/**
 * AWS S3 provider for `pnpm setup:infra`.
 *
 * Provisions an S3 bucket + scoped IAM user per environment and records the keys to state.
 *
 * NAMING (single source of truth = setup.config.json): organization/project names from
 * `config.project.*`, environment names from `config.environments[].name` — never hardcoded.
 * SECRETS: written to `.env.<environment>` only (via build-env-vars), never printed to the
 * console; setup secret files are gitignored and unreadable by the agent (deny-read guard). See SETUP_INFRA_PROVIDER_TEMPLATE.md.
 */
import {
  S3Client,
  CreateBucketCommand,
  PutPublicAccessBlockCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  HeadBucketCommand,
  type BucketLocationConstraint,
} from '@aws-sdk/client-s3';
import {
  IAMClient,
  CreateUserCommand,
  PutUserPolicyCommand,
  CreateAccessKeyCommand,
  ListAccessKeysCommand,
  GetUserCommand,
  GetAccountSummaryCommand,
} from '@aws-sdk/client-iam';
import * as logger from '@setup/common/logger.js';
import { SetupError } from '@setup/common/setup-error.js';
import { readEnvFileValue } from '@setup/envs/read-env-file.js';
import { isSecretFilled } from '@setup/common/secrets.js';
import { resourceStatus } from '@setup/common/interactive-step.js';
import type {
  SetupConfig,
  SetupSecrets,
  SetupState,
  ProviderResult,
  InfraProvider,
  InfraProviderContext,
} from '@setup/common/types.js';

function createS3Client(secrets: SetupSecrets, region: string): S3Client {
  return new S3Client({
    region,
    credentials: {
      accessKeyId: secrets.aws.accessKeyId,
      secretAccessKey: secrets.aws.secretAccessKey,
    },
  });
}

function createIamClient(secrets: SetupSecrets): IAMClient {
  return new IAMClient({
    region: 'us-east-1',
    credentials: {
      accessKeyId: secrets.aws.accessKeyId,
      secretAccessKey: secrets.aws.secretAccessKey,
    },
  });
}

function isAwsAuthError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /Credential|AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|UnrecognizedClient|does not exist in our records|security token included in the request is invalid/i.test(
    text,
  );
}

function isBucketNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const metadata = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
  if (metadata?.httpStatusCode === 404) return true;
  const name = (error as { name?: string }).name ?? '';
  return name === 'NotFound' || name === 'NoSuchBucket';
}

function isIamUserNotFoundError(error: unknown): boolean {
  const name =
    error && typeof error === 'object' && 'name' in error
      ? String((error as { name: string }).name)
      : '';
  return name === 'NoSuchEntity' || name === 'NoSuchEntityException';
}

function formatAwsAuthFailure(detail: string): string {
  return (
    `AWS credentials rejected: ${detail}. ` +
    'Verify AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .setup/.setup-credentials ' +
    '(create or rotate keys at https://console.aws.amazon.com/iam/home#/users).'
  );
}

async function assertProvisionerAwsCredentials(secrets: SetupSecrets): Promise<void> {
  if (!isSecretFilled(secrets.aws.accessKeyId)) {
    throw new Error('AWS_ACCESS_KEY_ID missing in .setup/.setup-credentials');
  }
  if (!isSecretFilled(secrets.aws.secretAccessKey)) {
    throw new Error('AWS_SECRET_ACCESS_KEY missing in .setup/.setup-credentials');
  }
  const iamClient = createIamClient(secrets);
  try {
    await iamClient.send(new GetAccountSummaryCommand({}));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(formatAwsAuthFailure(detail));
  } finally {
    iamClient.destroy();
  }
}

function buildBucketPolicy(bucketArn: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: [
          's3:PutObject',
          's3:GetObject',
          's3:HeadObject',
          's3:DeleteObject',
          's3:ListBucket',
        ],
        Resource: [bucketArn, `${bucketArn}/*`],
      },
    ],
  });
}

/** Must match `USER_DATA_EXPORT_S3_PREFIX` in user-data-export.constants.ts */
const USER_DATA_EXPORT_S3_PREFIX = 'user-data-export';

/** Must match `USER_DATA_EXPORT_ARTIFACT_TTL_DAYS` in user-data-export.constants.ts */
const USER_DATA_EXPORT_ARTIFACT_TTL_DAYS = 7;

async function applyUserDataExportBucketLifecycle(
  s3Client: S3Client,
  bucketName: string,
): Promise<void> {
  await s3Client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucketName,
      LifecycleConfiguration: {
        Rules: [
          {
            ID: 'expire-user-data-export',
            Status: 'Enabled',
            Filter: { Prefix: `${USER_DATA_EXPORT_S3_PREFIX}/` },
            Expiration: { Days: USER_DATA_EXPORT_ARTIFACT_TTL_DAYS },
          },
        ],
      },
    }),
  );
}

function buildCorsRules(allowedOrigins: string[]): Array<{
  AllowedHeaders: string[];
  AllowedMethods: string[];
  AllowedOrigins: string[];
  ExposeHeaders: string[];
  MaxAgeSeconds: number;
}> {
  return [
    {
      AllowedHeaders: ['*'],
      AllowedMethods: ['PUT', 'GET', 'HEAD'],
      AllowedOrigins: allowedOrigins,
      ExposeHeaders: ['ETag', 'Content-Length', 'Content-Type'],
      MaxAgeSeconds: 3600,
    },
  ];
}

export async function provision(
  config: SetupConfig,
  secrets: SetupSecrets,
  state: SetupState,
  environments: string[],
): Promise<ProviderResult> {
  const awsConfig = config.providers.aws;
  const s3Client = createS3Client(secrets, awsConfig.region);
  const iamClient = createIamClient(secrets);

  const spinner = logger.startSpinner('Setting up AWS S3...');

  try {
    await assertProvisionerAwsCredentials(secrets);

    const buckets: Record<string, { name: string; region: string }> = state.aws?.buckets
      ? { ...state.aws.buckets }
      : {};
    const iamUsers: Record<
      string,
      { username: string; arn: string; accessKeyId: string; secretAccessKey: string }
    > = state.aws?.iamUsers ? { ...state.aws.iamUsers } : {};

    logger.stopSpinner(spinner, 'AWS S3 setup starting...');

    for (const environmentName of environments) {
      const bucketName = `${awsConfig.s3BucketPrefix}-${environmentName}-uploads`;
      const iamUsername = `${awsConfig.iamUserPrefix}-${environmentName}`;

      // Create S3 bucket
      if (!buckets[environmentName]) {
        const bucketSpinner = logger.startSpinner(`Creating S3 bucket: ${bucketName}...`);

        try {
          await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
          logger.stopSpinner(bucketSpinner, `Bucket "${bucketName}" already exists`);
        } catch (headError) {
          if (!isBucketNotFoundError(headError)) {
            const message = headError instanceof Error ? headError.message : String(headError);
            const failMessage = isAwsAuthError(headError)
              ? formatAwsAuthFailure(message)
              : `HeadBucket failed: ${message}`;
            logger.stopSpinner(bucketSpinner, failMessage, 'fail');
            throw new Error(failMessage);
          }
          try {
            await s3Client.send(
              new CreateBucketCommand({
                Bucket: bucketName,
                ...(awsConfig.region !== 'us-east-1'
                  ? {
                      CreateBucketConfiguration: {
                        LocationConstraint: awsConfig.region as BucketLocationConstraint,
                      },
                    }
                  : {}),
              }),
            );
            logger.stopSpinner(bucketSpinner, `Bucket "${bucketName}" created`);
          } catch (createError) {
            const message =
              createError instanceof Error ? createError.message : String(createError);
            const failMessage = isAwsAuthError(createError)
              ? formatAwsAuthFailure(message)
              : `Bucket create failed: ${message}`;
            logger.stopSpinner(bucketSpinner, failMessage, 'fail');
            throw new Error(failMessage);
          }
        }

        // Block public access
        await s3Client.send(
          new PutPublicAccessBlockCommand({
            Bucket: bucketName,
            PublicAccessBlockConfiguration: {
              BlockPublicAcls: true,
              IgnorePublicAcls: true,
              BlockPublicPolicy: true,
              RestrictPublicBuckets: true,
            },
          }),
        );

        // Set CORS
        const allowedOrigins = config.app.allowedOrigins[environmentName];
        if (allowedOrigins) {
          await s3Client.send(
            new PutBucketCorsCommand({
              Bucket: bucketName,
              CORSConfiguration: {
                CORSRules: buildCorsRules(allowedOrigins.split(',')),
              },
            }),
          );
        }

        buckets[environmentName] = { name: bucketName, region: awsConfig.region };
      } else {
        logger.success(`  Bucket "${environmentName}" already configured`);
      }

      const lifecycleSpinner = logger.startSpinner(
        `Applying GDPR export lifecycle on "${bucketName}"...`,
      );
      try {
        await applyUserDataExportBucketLifecycle(s3Client, bucketName);
        logger.stopSpinner(
          lifecycleSpinner,
          `Lifecycle: expire \`${USER_DATA_EXPORT_S3_PREFIX}/\` after ${USER_DATA_EXPORT_ARTIFACT_TTL_DAYS} days`,
        );
      } catch (lifecycleError) {
        const message =
          lifecycleError instanceof Error ? lifecycleError.message : String(lifecycleError);
        logger.stopSpinner(lifecycleSpinner, `Lifecycle rule failed: ${message}`, 'fail');
        throw lifecycleError;
      }

      // Create IAM user
      if (!iamUsers[environmentName]) {
        const iamSpinner = logger.startSpinner(`Creating IAM user: ${iamUsername}...`);

        let userArn: string;
        try {
          const getUserResponse = await iamClient.send(
            new GetUserCommand({ UserName: iamUsername }),
          );
          const existingArn = getUserResponse.User?.Arn;
          if (!existingArn) {
            throw new Error(
              `IAM GetUser succeeded but returned no Arn for "${iamUsername}" (AWS API contract violation).`,
            );
          }
          userArn = existingArn;
          logger.stopSpinner(iamSpinner, `IAM user "${iamUsername}" already exists`);
        } catch (getUserError) {
          if (!isIamUserNotFoundError(getUserError)) {
            const message =
              getUserError instanceof Error ? getUserError.message : String(getUserError);
            const failMessage = isAwsAuthError(getUserError)
              ? formatAwsAuthFailure(message)
              : `IAM GetUser failed: ${message}`;
            logger.stopSpinner(iamSpinner, failMessage, 'fail');
            throw new Error(failMessage);
          }
          const createUserResponse = await iamClient.send(
            new CreateUserCommand({ UserName: iamUsername }),
          );
          const createdArn = createUserResponse.User?.Arn;
          if (!createdArn) {
            throw new Error(
              `IAM CreateUser succeeded but returned no Arn for "${iamUsername}" (AWS API contract violation).`,
            );
          }
          userArn = createdArn;
          logger.stopSpinner(iamSpinner, `IAM user "${iamUsername}" created`);
        }

        // Attach inline policy scoped to this bucket
        const bucketArn = `arn:aws:s3:::${bucketName}`;
        await iamClient.send(
          new PutUserPolicyCommand({
            UserName: iamUsername,
            PolicyName: `${bucketName}-access`,
            PolicyDocument: buildBucketPolicy(bucketArn),
          }),
        );

        // Access key (idempotent). AWS only returns the secret at creation time and caps a user at
        // 2 access keys, so on a re-run we never blindly create a third: reuse the key already in
        // `.env.<environment>`, and when the user is at the 2-key limit give actionable guidance
        // instead of the raw `Cannot exceed quota for AccessKeysPerUser` error.
        const existingAccessKeyId = readEnvFileValue(environmentName, 'S3_ACCESS_KEY_ID');
        const existingSecretAccessKey = readEnvFileValue(environmentName, 'S3_SECRET_ACCESS_KEY');
        if (existingAccessKeyId && existingSecretAccessKey) {
          iamUsers[environmentName] = {
            username: iamUsername,
            arn: userArn,
            accessKeyId: existingAccessKeyId,
            secretAccessKey: existingSecretAccessKey,
          };
          logger.success(
            `  Reusing existing access key for "${iamUsername}" from .env.${environmentName}`,
          );
        } else {
          const existingKeys = await iamClient.send(
            new ListAccessKeysCommand({ UserName: iamUsername }),
          );
          if ((existingKeys.AccessKeyMetadata?.length ?? 0) >= 2) {
            throw new SetupError(
              `IAM user "${iamUsername}" already has the maximum 2 access keys, and no usable key is stored in .env.${environmentName}.`,
              {
                hint: `Delete an unused key (AWS console → IAM → Users → ${iamUsername} → Security credentials → Access keys), then retry — or skip this step if an existing key is already in use.`,
              },
            );
          }
          const accessKeyResponse = await iamClient.send(
            new CreateAccessKeyCommand({ UserName: iamUsername }),
          );
          const accessKey = accessKeyResponse.AccessKey;
          if (!(accessKey?.AccessKeyId && accessKey.SecretAccessKey)) {
            throw new Error(
              `IAM CreateAccessKey returned an incomplete key pair for "${iamUsername}" (AWS API contract violation).`,
            );
          }
          iamUsers[environmentName] = {
            username: iamUsername,
            arn: userArn,
            accessKeyId: accessKey.AccessKeyId,
            secretAccessKey: accessKey.SecretAccessKey,
          };
          logger.success(`  Access key created for "${iamUsername}"`);
        }
      } else {
        logger.success(`  IAM user "${environmentName}" already configured`);
      }
    }

    return {
      success: true,
      message: `AWS: ${Object.keys(buckets).length} buckets + ${Object.keys(iamUsers).length} IAM users ready`,
      stateUpdates: { aws: { buckets, iamUsers } },
    };
  } catch (provisionError) {
    const message =
      provisionError instanceof Error ? provisionError.message : String(provisionError);
    logger.failActiveSpinner(`AWS provisioning failed: ${message}`);
    return { success: false, message };
  } finally {
    s3Client.destroy();
    iamClient.destroy();
  }
}

export async function check(
  state: SetupState,
  secrets: SetupSecrets,
  region: string,
): Promise<boolean> {
  if (!state.aws?.buckets) {
    logger.error('AWS: no buckets in state');
    return false;
  }

  const s3Client = createS3Client(secrets, region);
  let allHealthy = true;

  for (const [environmentName, bucket] of Object.entries(state.aws.buckets)) {
    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: bucket.name }));
      logger.success(`S3 bucket "${environmentName}" (${bucket.name}) — reachable`);
    } catch {
      logger.error(`S3 bucket "${environmentName}" (${bucket.name}) — unreachable`);
      allHealthy = false;
    }
  }

  s3Client.destroy();
  return allHealthy;
}

function allEnvironmentsHaveBucket(environments: string[], state: SetupState): boolean {
  const buckets = state.aws?.buckets;
  if (!buckets) return false;
  return environments.every((environmentName) => Boolean(buckets[environmentName]));
}

function allEnvironmentsHaveIamUser(environments: string[], state: SetupState): boolean {
  const iamUsers = state.aws?.iamUsers;
  if (!iamUsers) return false;
  return environments.every((environmentName) => Boolean(iamUsers[environmentName]));
}

export const setupAwsProvider: InfraProvider = {
  key: 'aws',
  name: 'AWS S3',
  isEnabled: ({ config, secrets }) =>
    config.providers.aws.enabled &&
    isSecretFilled(secrets.aws.accessKeyId) &&
    isSecretFilled(secrets.aws.secretAccessKey),
  disabledReason: ({ config }) =>
    !config.providers.aws.enabled
      ? 'disabled in setup.config.json'
      : 'AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY missing in .setup/.setup-credentials',
  preview: ({ config }) =>
    config.providers.aws.enabled
      ? {
          detail: 'Access Key ID + Secret',
          url: 'https://console.aws.amazon.com/iam/home#/users',
          configKey: 'aws.accessKeyId, aws.secretAccessKey',
        }
      : null,
  settingsReview: ({ config, environments }) =>
    config.providers.aws.enabled
      ? [
          {
            bucket: 'resource',
            provider: 'AWS S3',
            detail: `${environments.length} buckets + ${environments.length} IAM users (${config.providers.aws.region})`,
          },
        ]
      : [],
  detectExisting: async ({ config, secrets, environments }) => {
    if (
      !(
        config.providers.aws.enabled &&
        isSecretFilled(secrets.aws.accessKeyId) &&
        isSecretFilled(secrets.aws.secretAccessKey)
      )
    ) {
      return [];
    }
    try {
      await assertProvisionerAwsCredentials(secrets);
    } catch {
      return [];
    }
    const s3Client = new S3Client({
      region: config.providers.aws.region,
      credentials: {
        accessKeyId: secrets.aws.accessKeyId,
        secretAccessKey: secrets.aws.secretAccessKey,
      },
    });
    const existing: Array<{ provider: string; detail: string }> = [];
    for (const environmentName of environments) {
      const bucketName = `${config.providers.aws.s3BucketPrefix}-${environmentName}-uploads`;
      try {
        await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
        existing.push({ provider: 'AWS S3', detail: `bucket "${bucketName}" already exists` });
      } catch {
        // bucket does not exist — fine
      }
    }
    s3Client.destroy();
    return existing;
  },
  describe: ({ config, environments }) => ({
    project: config.providers.aws.s3BucketPrefix,
    environments,
  }),
  inspectRemote: async ({ config, secrets, environments }) => {
    const awsConfig = config.providers.aws;
    if (!awsConfig.enabled)
      return { present: false, fields: [], error: 'disabled in setup.config.json' };
    if (!isSecretFilled(secrets.aws.accessKeyId)) {
      return {
        present: false,
        fields: [],
        error: 'AWS_ACCESS_KEY_ID missing in .setup/.setup-credentials',
      };
    }
    if (!isSecretFilled(secrets.aws.secretAccessKey)) {
      return {
        present: false,
        fields: [],
        error: 'AWS_SECRET_ACCESS_KEY missing in .setup/.setup-credentials',
      };
    }
    try {
      await assertProvisionerAwsCredentials(secrets);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { present: false, fields: [], error: message };
    }
    const isAuthError = (error: unknown): boolean => isAwsAuthError(error);
    const s3Client = createS3Client(secrets, awsConfig.region);
    const iamClient = createIamClient(secrets);
    const fields = [];
    const authErrors: string[] = [];
    let anyPresent = false;
    for (const environmentName of environments) {
      const bucketName = `${awsConfig.s3BucketPrefix}-${environmentName}-uploads`;
      let bucketPresent = false;
      try {
        await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
        bucketPresent = true;
      } catch (error) {
        if (isAuthError(error))
          authErrors.push(error instanceof Error ? error.message : String(error));
      }
      fields.push({
        label: `bucket (${environmentName})`,
        expected: bucketName,
        remote: bucketPresent ? bucketName : '—',
        matches: bucketPresent,
      });
      const iamUsername = `${awsConfig.iamUserPrefix}-${environmentName}`;
      let userPresent = false;
      try {
        await iamClient.send(new GetUserCommand({ UserName: iamUsername }));
        userPresent = true;
      } catch (error) {
        if (isAuthError(error))
          authErrors.push(error instanceof Error ? error.message : String(error));
      }
      fields.push({
        label: `IAM user (${environmentName})`,
        expected: iamUsername,
        remote: userPresent ? iamUsername : '—',
        matches: userPresent,
      });
      anyPresent = anyPresent || bucketPresent || userPresent;
    }
    if (!anyPresent && authErrors.length > 0) {
      return { present: false, fields: [], error: authErrors[0] ?? 'AWS credentials error' };
    }
    return { present: anyPresent, fields };
  },
  toEnvironmentVariables: ({ config, state }, environmentName) => {
    const user = state.aws?.iamUsers?.[environmentName];
    const bucket = state.aws?.buckets?.[environmentName];
    if (!(config.providers.aws.enabled && bucket && user)) return {};
    return {
      S3_BUCKET: bucket.name,
      S3_REGION: bucket.region,
      S3_ACCESS_KEY_ID: user.accessKeyId,
      S3_SECRET_ACCESS_KEY: user.secretAccessKey,
    };
  },
  buildStep: (context: InfraProviderContext) => ({
    name: 'AWS S3',
    enabled: setupAwsProvider.isEnabled(context),
    enabledReason: setupAwsProvider.disabledReason(context),
    instructions: [
      `Will create or adopt one S3 bucket per environment in ${context.config.providers.aws.region}.`,
      `Bucket names: ${context.environments
        .map(
          (environmentName) =>
            `${context.config.providers.aws.s3BucketPrefix}-${environmentName}-uploads`,
        )
        .join(', ')}.`,
      `Will create or adopt one IAM user per environment for restricted bucket access.`,
    ],
    detectStatus: () =>
      resourceStatus(
        allEnvironmentsHaveBucket(context.environments, context.state) &&
          allEnvironmentsHaveIamUser(context.environments, context.state),
        'all buckets + IAM users in state',
      ),
    execute: async () => {
      const result = await provision(
        context.config,
        context.secrets,
        context.state,
        context.environments,
      );
      if (!result.success) throw new Error(result.message);
      context.applyStateUpdates(result.stateUpdates ?? {});
      return result;
    },
    verifyState: () => ({
      ok:
        allEnvironmentsHaveBucket(context.environments, context.state) &&
        allEnvironmentsHaveIamUser(context.environments, context.state),
      message: context.state.aws?.buckets
        ? `${Object.keys(context.state.aws.buckets).length} buckets + ${Object.keys(context.state.aws.iamUsers ?? {}).length} IAM users`
        : 'no AWS resources recorded',
    }),
    verifyLive: async () => {
      const ok = await check(context.state, context.secrets, context.config.providers.aws.region);
      return { ok, message: ok ? 'reachable' : 'unreachable' };
    },
  }),
  check: ({ config, state, secrets }) => check(state, secrets, config.providers.aws.region),
  deleteInstructions: ({ config, state }) => {
    const buckets = state.aws?.buckets ?? {};
    const iamUsers = state.aws?.iamUsers ?? {};
    const blocks: Array<{
      provider: string;
      dashboardUrl: string;
      steps?: string[];
      resources: Array<{ label: string; identifier: string }>;
    }> = [];

    if (Object.keys(buckets).length > 0) {
      const region = config.providers.aws.region;
      blocks.push({
        provider: 'AWS S3',
        dashboardUrl: `https://s3.console.aws.amazon.com/s3/buckets?region=${region}`,
        steps: [
          'Open the bucket → Empty (delete all objects + versions) → then Delete bucket.',
          'Buckets cannot be deleted while they contain objects.',
        ],
        resources: Object.entries(buckets).map(([environmentName, bucket]) => ({
          label: `Bucket (${environmentName})`,
          identifier: bucket.name,
        })),
      });
    }

    if (Object.keys(iamUsers).length > 0) {
      blocks.push({
        provider: 'AWS IAM',
        dashboardUrl: 'https://console.aws.amazon.com/iam/home#/users',
        steps: [
          'Open each user → Security credentials → delete access keys.',
          'Then Permissions → detach policies → Delete user.',
        ],
        resources: Object.entries(iamUsers).map(([environmentName, user]) => ({
          label: `IAM user (${environmentName})`,
          identifier: user.username,
        })),
      });
    }

    return blocks;
  },
};
