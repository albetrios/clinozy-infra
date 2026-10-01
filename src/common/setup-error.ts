/**
 * Typed errors for the setup-infra module.
 *
 * Providers, the orchestrator, and helpers `throw` these instead of calling
 * `process.exit()`. Only the CLI entrypoint (`setup.ts`) catches them, prints,
 * and exits — so the module stays importable and unit-testable.
 */

/** A recoverable, user-facing setup failure. `hint` is an optional next-step suggestion. */
export class SetupError extends Error {
  readonly hint?: string;

  constructor(message: string, options: { hint?: string } = {}) {
    super(message);
    this.name = 'SetupError';
    if (options.hint !== undefined) this.hint = options.hint;
  }
}

/** The user chose to stop (declined a confirm / aborted a step). Not a failure. */
export class SetupAbort extends Error {
  constructor(message = 'Aborted by user.') {
    super(message);
    this.name = 'SetupAbort';
  }
}

/**
 * Render a thrown value at a CLI entrypoint and return the process exit code.
 * `SetupAbort` → 0 (clean stop); `SetupError` (+ hint) and anything else → 1.
 */
export function reportSetupError(
  error: unknown,
  logger: { error: (message: string) => void; info: (message: string) => void },
): number {
  if (error instanceof SetupAbort) {
    logger.info(error.message);
    return 0;
  }
  if (error instanceof SetupError) {
    logger.error(error.message);
    if (error.hint) logger.info(error.hint);
    return 1;
  }
  logger.error(error instanceof Error ? error.message : String(error));
  return 1;
}
