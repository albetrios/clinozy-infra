/**
 * Per-environment iteration helpers shared by the setup-infra module.
 *
 * Environment names are the single source of truth from `setup.config.json`
 * (`environments[].name`). These helpers remove the repeated per-env loops in
 * `secrets.ts` / `build-env-vars.ts`.
 */

/** Uppercased environment name used in scoped env-var keys (`POSTHOG_<ENV>_PROJECT_API_KEY`). */
export function upperEnvironment(name: string): string {
  return name.toUpperCase();
}

/**
 * Build a `Record<environment, T>` from a list of environment names, dropping entries
 * whose builder returns `undefined`. Replaces the hand-rolled per-env record loops.
 */
export function mapEnvironments<T>(
  environmentNames: string[],
  build: (environment: string) => T | undefined,
): Record<string, T> {
  const result: Record<string, T> = {};
  for (const environment of environmentNames) {
    const value = build(environment);
    if (value !== undefined) result[environment] = value;
  }
  return result;
}
