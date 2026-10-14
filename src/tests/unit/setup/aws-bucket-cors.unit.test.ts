import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GetBucketCorsCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { IAMClient } from '@aws-sdk/client-iam';
import {
  check,
  provision,
  setupAwsProvider,
} from '@setup/infra/providers/setup-aws/setup-aws.provider.js';
import { createEmptyState } from '@setup/common/state.js';
import type { InfraProviderContext, SetupState } from '@setup/common/types.js';

const ORIGINS = ['https://dev.acme.test', 'http://localhost:5173'];

const CURRENT_RULE = {
  AllowedOrigins: ORIGINS,
  AllowedMethods: ['POST', 'PUT', 'GET', 'HEAD'],
  AllowedHeaders: ['content-type', 'x-amz-server-side-encryption'],
  ExposeHeaders: ['ETag'],
  MaxAgeSeconds: 3600,
};

// Minimal context — the AWS hooks read config.providers.aws, config.app.allowedOrigins and secrets.aws.
function context(state: SetupState): InfraProviderContext {
  return {
    config: {
      project: { name: 'acme-be', displayName: 'Acme Backend', organization: 'acme' },
      environments: [{ name: 'development', deployBranch: 'main' }],
      providers: {
        aws: {
          enabled: true,
          region: 'us-east-1',
          s3BucketPrefix: 'acme-be',
          iamUserPrefix: 'acme-be-s3',
        },
      },
      app: { allowedOrigins: { development: ORIGINS.join(',') } },
    },
    secrets: { aws: { accessKeyId: 'AKIATEST', secretAccessKey: 'test-secret' } },
    state,
    environments: ['development', 'production'],
    applyStateUpdates: (updates: Partial<SetupState>) => Object.assign(state, updates),
  } as unknown as InfraProviderContext;
}

function notFound(name: string): S3ServiceException {
  return new S3ServiceException({
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: 404 },
    message: name,
  });
}

/** Stubs S3: only the development bucket exists, and its CORS is `rules` (none when undefined). */
function stubS3(rules?: unknown[]): void {
  vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: unknown) => {
    if (command instanceof HeadBucketCommand) {
      if (command.input.Bucket === 'acme-be-development-uploads') return {};
      throw notFound('NotFound');
    }
    if (command instanceof GetBucketCorsCommand) {
      if (!rules) throw notFound('NoSuchCORSConfiguration');
      return { CORSRules: rules };
    }
    throw new Error(`unexpected S3 command ${String(command)}`);
  }) as never);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AWS detectRemote', () => {
  it('records each existing upload bucket into the run state', async () => {
    stubS3();
    const state = createEmptyState();
    const found = await setupAwsProvider.detectRemote?.(context(state));
    expect(found).toEqual({ development: 'acme-be-development-uploads' });
    expect(state.aws?.buckets).toEqual({
      development: { name: 'acme-be-development-uploads', region: 'us-east-1' },
    });
    expect(state.aws?.iamUsers).toEqual({});
  });
});

describe('AWS check (bucket CORS)', () => {
  const hydrated = async (): Promise<InfraProviderContext> => {
    const ctx = context(createEmptyState());
    await setupAwsProvider.detectRemote?.(ctx);
    return ctx;
  };

  it('is healthy when the live CORS is the upload rule', async () => {
    stubS3([CURRENT_RULE]);
    const { config, state, secrets } = await hydrated();
    expect(await check(config, state, secrets)).toBe(true);
  });

  it('flags a stale rule (no POST, wildcard headers)', async () => {
    stubS3([{ ...CURRENT_RULE, AllowedMethods: ['PUT', 'GET', 'HEAD'], AllowedHeaders: ['*'] }]);
    const { config, state, secrets } = await hydrated();
    expect(await check(config, state, secrets)).toBe(false);
  });

  it('flags a bucket with no CORS at all', async () => {
    stubS3();
    const { config, state, secrets } = await hydrated();
    expect(await check(config, state, secrets)).toBe(false);
  });
});

describe('AWS provision on an adopted bucket', () => {
  it('still re-applies the public access block, lifecycle and upload CORS', async () => {
    vi.spyOn(IAMClient.prototype, 'send').mockImplementation((async () => ({})) as never);
    const sent: unknown[] = [];
    vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: unknown) => {
      sent.push(command);
      return {};
    }) as never);
    const state = createEmptyState();
    state.aws = {
      buckets: { development: { name: 'acme-be-development-uploads', region: 'us-east-1' } },
      iamUsers: {
        development: {
          username: 'acme-be-s3-development',
          arn: 'arn:aws:iam::000000000000:user/acme-be-s3-development',
          accessKeyId: 'AKIATEST',
          secretAccessKey: 'test-secret',
        },
      },
    };
    const { config, secrets } = context(state);

    const result = await provision(config, secrets, state, ['development']);

    expect(result.success).toBe(true);
    expect(sent.some((command) => command instanceof PutPublicAccessBlockCommand)).toBe(true);
    expect(sent.some((command) => command instanceof PutBucketLifecycleConfigurationCommand)).toBe(
      true,
    );
    const cors = sent.find((command) => command instanceof PutBucketCorsCommand) as
      | PutBucketCorsCommand
      | undefined;
    expect(cors?.input).toEqual({
      Bucket: 'acme-be-development-uploads',
      CORSConfiguration: { CORSRules: [CURRENT_RULE] },
    });
  });
});
