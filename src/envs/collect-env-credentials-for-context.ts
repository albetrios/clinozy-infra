import type { InfraProviderContext } from '@setup/common/types.js';
import {
  collectEnvCredentials,
  type CollectEnvCredentialsOptions,
  type CollectEnvCredentialsResult,
} from './env-file-setup.util.js';

/** Collect credentials only for `context.environments` (one env when traversing environment-first). */
export function collectEnvCredentialsForContext(
  context: InfraProviderContext,
  options: Omit<CollectEnvCredentialsOptions, 'environmentNames'>,
): Promise<CollectEnvCredentialsResult> {
  return collectEnvCredentials(context.config, {
    ...options,
    environmentNames: context.environments,
  });
}
