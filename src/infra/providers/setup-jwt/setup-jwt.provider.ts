/**
 * JWT / app-secrets provider for `pnpm setup:infra`.
 *
 * Generates the JWT RS256 keypair and the app `SECRETS_ENCRYPTION_KEY` per environment
 * into state (consumed by build-env-vars → `.env.<environment>`).
 *
 * NAMING (single source of truth = setup.config.json): organization/project names from
 * `config.project.*`, environment names from `config.environments[].name` — never hardcoded.
 * SECRETS: written to `.env.<environment>` only (via build-env-vars), never printed to the
 * console; setup secret files are gitignored and written owner-only. See SETUP_INFRA_PROVIDER_TEMPLATE.md.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import * as logger from '@setup/common/logger.js';
import { resourceStatus } from '@setup/common/interactive-step.js';
import type {
  SetupState,
  ProviderResult,
  InfraProvider,
  InfraProviderContext,
} from '@setup/common/types.js';

interface JwtEnvironmentState {
  jwtSecret: string;
  jwtPrivateKey: string;
  jwtPublicKey: string;
  jwtSigningKid: string;
  secretsEncryptionKey?: string;
}

function generateRsaKeypair(): { privateKey: string; publicKey: string } {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function ensureJwtEntry(
  existing: JwtEnvironmentState | string | undefined,
  environmentName: string,
): { entry: JwtEnvironmentState; created: boolean; upgraded: boolean } {
  if (typeof existing === 'object' && existing.jwtPrivateKey && existing.jwtPublicKey) {
    return {
      entry: {
        jwtSecret: existing.jwtSecret,
        jwtPrivateKey: existing.jwtPrivateKey,
        jwtPublicKey: existing.jwtPublicKey,
        jwtSigningKid: existing.jwtSigningKid ?? `${environmentName}-1`,
        ...(existing.secretsEncryptionKey
          ? { secretsEncryptionKey: existing.secretsEncryptionKey }
          : {}),
      },
      created: false,
      upgraded: false,
    };
  }

  const { privateKey, publicKey } = generateRsaKeypair();
  const jwtSecret = typeof existing === 'string' ? existing : (existing?.jwtSecret ?? '');
  const carriedSecret = jwtSecret || randomBytes(48).toString('base64url');

  return {
    entry: {
      jwtSecret: carriedSecret,
      jwtPrivateKey: privateKey,
      jwtPublicKey: publicKey,
      jwtSigningKid:
        typeof existing === 'object' && existing.jwtSigningKid
          ? existing.jwtSigningKid
          : `${environmentName}-1`,
      ...(typeof existing === 'object' && existing.secretsEncryptionKey
        ? { secretsEncryptionKey: existing.secretsEncryptionKey }
        : {}),
    },
    created: existing === undefined,
    upgraded: existing !== undefined,
  };
}

export function provision(state: SetupState, environments: string[]): ProviderResult {
  const existingSecrets = state.jwt ?? {};
  const jwtSecrets: NonNullable<SetupState['jwt']> = { ...existingSecrets };

  for (const environmentName of environments) {
    const { entry, created, upgraded } = ensureJwtEntry(
      jwtSecrets[environmentName] as JwtEnvironmentState | string | undefined,
      environmentName,
    );
    jwtSecrets[environmentName] = entry;
    if (created) {
      logger.success(
        `JWT keys for "${environmentName}" — generated (HS256 secret + RS256 keypair)`,
      );
    } else if (upgraded) {
      logger.success(
        `JWT keys for "${environmentName}" — RS256 keypair generated (existing HS256 secret preserved)`,
      );
    } else {
      logger.success(`JWT keys for "${environmentName}" — already generated`);
    }
  }

  return {
    success: true,
    message: `JWT: ${Object.keys(jwtSecrets).length} environment(s) ready`,
    stateUpdates: { jwt: jwtSecrets },
  };
}

function allEnvironmentsHaveJwt(environments: string[], state: SetupState): boolean {
  if (!state.jwt) return false;
  return environments.every((environmentName) => {
    const entry = state.jwt?.[environmentName];
    if (!entry) return false;
    if (typeof entry === 'string') return false;
    return Boolean(entry.jwtSecret && entry.jwtPrivateKey && entry.jwtPublicKey);
  });
}

export const setupJwtProvider: InfraProvider = {
  key: 'jwt',
  name: 'JWT secrets',
  isEnabled: () => true,
  disabledReason: () => '',
  settingsReview: ({ environments }) => [
    {
      bucket: 'resource',
      provider: 'JWT',
      detail: `${environments.length} secrets (auto-generated)`,
    },
  ],
  describe: ({ environments }) => ({ environments }),
  inspectRemote: ({ environments, state }) =>
    Promise.resolve({
      present: allEnvironmentsHaveJwt(environments, state),
      fields: [],
      error: 'local secrets — no remote resource',
    }),
  toEnvironmentVariables: ({ state }, environmentName) => {
    const jwt = state.jwt?.[environmentName];
    if (!jwt) return {};
    if (typeof jwt === 'string') return { JWT_SECRET: jwt };
    return {
      JWT_SECRET: jwt.jwtSecret,
      ...(jwt.jwtPrivateKey ? { JWT_PRIVATE_KEY: jwt.jwtPrivateKey } : {}),
      ...(jwt.jwtPublicKey ? { JWT_PUBLIC_KEY: jwt.jwtPublicKey } : {}),
      ...(jwt.jwtSigningKid ? { JWT_SIGNING_KID: jwt.jwtSigningKid } : {}),
      ...(jwt.secretsEncryptionKey ? { SECRETS_ENCRYPTION_KEY: jwt.secretsEncryptionKey } : {}),
    };
  },
  buildStep: (context: InfraProviderContext) => ({
    name: 'JWT secrets',
    enabled: true,
    instructions: [
      `Will generate JWT signing secrets per environment: ${context.environments.join(', ')}.`,
      'Local-only — no third-party API calls. Generated in-memory and written to .env.<environment>.',
    ],
    detectStatus: () =>
      resourceStatus(
        allEnvironmentsHaveJwt(context.environments, context.state),
        'JWT secrets generated for all environments',
      ),
    execute: async () => {
      const result = provision(context.state, context.environments);
      context.applyStateUpdates(result.stateUpdates ?? {});
      return result;
    },
    verifyState: () => ({
      ok: allEnvironmentsHaveJwt(context.environments, context.state),
      message: context.state.jwt
        ? `${Object.keys(context.state.jwt).length} environment secrets generated`
        : 'no JWT secrets recorded',
    }),
  }),
  deleteInstructions: ({ state }) => {
    const jwt = state.jwt;
    if (!jwt || Object.keys(jwt).length === 0) return [];
    return [
      {
        provider: 'JWT secrets',
        dashboardUrl: 'local — generated each run, not persisted to a file',
        steps: [
          'JWT secrets are local-only — no third-party resource to delete.',
          'To rotate, remove the JWT_* / SECRETS_ENCRYPTION_KEY lines from each .env.<environment> and re-run `pnpm setup:infra` to regenerate (state is ephemeral — there is no file to edit).',
          'After rotating, re-deploy services so they pick up the new JWT_SECRET.',
        ],
        resources: Object.keys(jwt).map((environmentName) => ({
          label: `Secret (${environmentName})`,
          identifier: '<redacted — generated locally>',
        })),
      },
    ];
  },
};
