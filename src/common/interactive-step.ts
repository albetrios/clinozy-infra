/**
 * Interactive step orchestrator.
 *
 * Wraps a single provisioning step in a uniform: explain → execute → verify → recover loop.
 *
 * Flow:
 *   1. Print step header.
 *   2. If !descriptor.enabled, mark "skipped (disabled)" and return.
 *   3. If descriptor.alreadyDone() → mark "already-done" and return.
 *   4. Print instructions (so the user understands what's about to happen).
 *   5. Auto-continue (no per-step prompt — the up-front final confirmation gates the run); an
 *      "already present" resource defaults to update (re-run), and guide providers pause in execute().
 *   6. Execute; on throw, ask retry / skip / abort.
 *   7. Verify state (read the in-memory run state); fail prompt if missing.
 *   8. Verify live (call provider check API); fail prompt if unhealthy.
 *
 * Used by orchestrator.runProvision so every provisioning step is interactive.
 */
import { createInterface } from 'node:readline';
import chalk from 'chalk';
import * as logger from './logger.js';
import { isAssumeYes } from './prompts.js';
import { isNonRecoverableProvisionerError } from './provisioner-failure.util.js';
import { SetupError } from './setup-error.js';

export type StepDecision = 'continue' | 'skip' | 'abort';
export type FailureDecision = 'retry' | 'skip' | 'abort';
export type StepStatus =
  | 'completed'
  | 'skipped'
  | 'aborted'
  | 'failed'
  | 'disabled'
  | 'already-done';

export interface StateVerification {
  ok: boolean;
  message: string;
}

export interface LiveVerification {
  ok: boolean;
  message: string;
}

/** Result of a resource existence/drift check (state-based). */
export interface ResourceStatus {
  /** `absent` → will create · `present` → up-to-date · `drift` → exists but config changed. */
  state: 'absent' | 'present' | 'drift';
  /** One-line human description shown in the plan and the step header. */
  detail: string;
  /** For `drift`: the specific config-vs-state differences. */
  changes?: string[];
}

/** Shorthand for a state-based existence check: present → `present`, else `absent`. */
export function resourceStatus(present: boolean, presentDetail: string): ResourceStatus {
  return present
    ? { state: 'present', detail: presentDetail }
    : { state: 'absent', detail: 'will create' };
}

export interface StepDescriptor<T> {
  name: string;
  enabled: boolean;
  /**
   * Reason shown when enabled is false (e.g. "disabled in setup.config.json", "missing secret").
   */
  enabledReason?: string;
  /**
   * Bullet list of what the step is about to do (printed before the continue/skip/abort prompt).
   */
  instructions: string[];
  /**
   * Optional resource existence/drift check (state-based). `absent` → create silently;
   * `present`/`drift` → prompt update/skip. Also consumed by `setup:infra:plan`. Omit for
   * validate-only or always-run steps.
   */
  detectStatus?: () => ResourceStatus | Promise<ResourceStatus>;
  /**
   * Run the actual provisioning. Should throw on failure or return the provider's result.
   */
  execute: () => Promise<T>;
  /**
   * Optional state-only post-check (read the in-memory run state). Fast.
   */
  verifyState?: () => StateVerification;
  /**
   * Optional live verification (provider API call). Slower but proves the resource works.
   */
  verifyLive?: () => Promise<LiveVerification>;
}

export interface StepOutcome<T> {
  name: string;
  status: StepStatus;
  result?: T;
  errorMessage?: string;
  detail?: string;
}

/**
 * Guard: setup-infra is interactive and human-only (no CI / unattended runs). Throws
 * when stdin/stdout isn't a TTY so a piped/automated invocation fails fast and clearly.
 */
export function assertInteractive(): void {
  // --yes (non-interactive) deliberately runs unattended — no TTY required.
  if (isAssumeYes()) return;
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    throw new SetupError(
      'setup:infra is interactive and human-only — run it in a terminal, or pass --yes for non-interactive mode.',
    );
  }
}

async function ask(question: string, defaultValue: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolvePromise) => {
    readline.question(`  ${question} [${defaultValue}]: `, (answer) => {
      readline.close();
      const trimmed = answer.trim();
      resolvePromise(trimmed === '' ? defaultValue : trimmed.toLowerCase());
    });
  });
}

/** One option in a single-keypress chooser. `label` is the text AFTER the key letter, e.g. key `c` + label `ontinue`. */
interface KeyChoice<T> {
  key: string;
  label: string;
  value: T;
  aliases?: string[];
}

/**
 * Read ONE keypress without waiting for Enter (raw mode). Resolves the char (Enter → `\n`); Ctrl+C
 * exits. Returns `null` when stdin isn't a raw-capable TTY (piped/redirected) so callers fall back
 * to line input.
 */
function readSingleKey(): Promise<string | null> {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return Promise.resolve(null);
  return new Promise((resolvePromise) => {
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (data: Buffer): void => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      const key = data.toString('utf8');
      if (key === '\u0003') {
        // Ctrl+C
        process.stdout.write('\n');
        process.exit(130);
      }
      resolvePromise(key);
    };
    stdin.on('data', onData);
  });
}

/**
 * Single-keypress chooser: prints a colored hint with the default option highlighted, then reads
 * one key (no Enter needed; Enter takes the default). Degrades to the line-based {@link ask} when
 * stdin isn't a raw TTY. The chosen key is echoed back so the transcript stays readable.
 */
async function promptKeyChoice<T>(
  prompt: string,
  choices: KeyChoice<T>[],
  defaultKey: string,
): Promise<T> {
  const defaultChoice = choices.find((choice) => choice.key === defaultKey) ?? choices[0];
  if (!defaultChoice) throw new SetupError('promptKeyChoice requires at least one choice.');
  const hint = choices
    .map((choice) =>
      choice.key === defaultChoice.key
        ? chalk.bold.green(`(${choice.key})${choice.label}`)
        : chalk.cyan(`(${choice.key})`) + chalk.gray(choice.label),
    )
    .join(chalk.gray('  ·  '));

  while (true) {
    process.stdout.write(`  ${prompt}  ${hint} ${chalk.gray(`[${defaultChoice.key}]`)} `);
    const raw = await readSingleKey();
    if (raw === null) {
      // Non-raw stdin (piped) — fall back to line input.
      const typed = await ask(prompt, defaultChoice.key);
      const fallback = choices.find(
        (choice) => choice.key === typed || choice.aliases?.includes(typed),
      );
      return (fallback ?? defaultChoice).value;
    }
    const key = raw.toLowerCase();
    if (key === '\r' || key === '\n') {
      process.stdout.write(chalk.bold.green(`${defaultChoice.key}\n`));
      return defaultChoice.value;
    }
    const match = choices.find((choice) => choice.key === key || choice.aliases?.includes(key));
    if (match) {
      process.stdout.write(chalk.bold(`${match.key}\n`));
      return match.value;
    }
    process.stdout.write(chalk.yellow(`${key.trim() || '?'}\n`));
    logger.warn(
      `  Press ${choices.map((choice) => choice.key).join(' / ')} (or Enter for ${defaultChoice.key}).`,
    );
  }
}

// Steps auto-run: the up-front settings review + "create REAL resources?" final confirmation (and
// the per-environment scope choice) already gate the run, so a per-step continue/skip/abort prompt
// is redundant noise. Provisioning steps run automatically; guide-only providers still pause inside
// execute() to collect pasted values (those prompts never auto-answer). Granular control remains via
// per-environment skip and SETUP_INFRA_PROVIDERS / SETUP_INFRA_SKIP_PROVIDERS.
async function promptStepDecision(): Promise<StepDecision> {
  return 'continue';
}

/** True when setup should run all providers for one environment before moving to the next. */
export function usesEnvironmentFirstTraversal(environments: string[]): boolean {
  return environments.length > 1;
}

/**
 * Gate an entire environment phase (all providers for that env) when multiple environments exist.
 */
export async function promptSetupEnvironmentPhase(environmentName: string): Promise<StepDecision> {
  if (isAssumeYes()) return 'continue';
  logger.blank();
  return promptKeyChoice<StepDecision>(
    `Set up environment ${chalk.bold(`"${environmentName}"`)}?`,
    [
      { key: 'c', label: 'ontinue', value: 'continue', aliases: ['y'] },
      { key: 's', label: 'kip', value: 'skip' },
      { key: 'a', label: 'bort', value: 'abort', aliases: ['q'] },
    ],
    'c',
  );
}

/**
 * Decision when a resource already exists (org/project/environment present): update it
 * (re-run the step) or skip and keep what's there. Defaults to skip — never mutate
 * existing infrastructure without an explicit choice.
 */
// Already-present resources default to UPDATE (re-run the idempotent step to refresh) with no
// prompt — the up-front final confirmation already gated the whole run, and every provider's
// execute is adopt-or-update. The "already present — <detail>" line is still printed for context.
async function promptExistingDecision(): Promise<'update' | 'skip'> {
  return 'update';
}

async function promptOnFailure(): Promise<FailureDecision> {
  // Non-interactive: skip the failing step (best-effort) rather than loop on retry.
  if (isAssumeYes()) return 'skip';
  return promptKeyChoice<FailureDecision>(
    'What now?',
    [
      { key: 'r', label: 'etry', value: 'retry', aliases: ['y'] },
      { key: 's', label: 'kip', value: 'skip' },
      { key: 'a', label: 'bort', value: 'abort', aliases: ['q'] },
    ],
    'r',
  );
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export async function runInteractiveStep<T>(
  stepNumber: number,
  totalSteps: number,
  descriptor: StepDescriptor<T>,
): Promise<StepOutcome<T>> {
  logger.stepHeader(stepNumber, totalSteps, descriptor.name);

  if (!descriptor.enabled) {
    const reason = descriptor.enabledReason ?? 'disabled in setup.config.json';
    logger.warn(`Skipped — ${reason}`);
    return { name: descriptor.name, status: 'disabled', detail: reason };
  }

  // Tracks an explicit "update existing" choice so we skip the redundant
  // continue/skip/abort prompt below and go straight to execute.
  let updatingExisting = false;

  // Existence/drift check: absent → create; present/drift → prompt update or skip.
  if (descriptor.detectStatus) {
    const status = await descriptor.detectStatus();
    if (status.state !== 'absent') {
      const label = status.state === 'drift' ? 'Drift detected' : 'Already present';
      logger.success(`${label} — ${status.detail}`);
      for (const change of status.changes ?? []) logger.info(`  • ${change}`);
      if ((await promptExistingDecision()) === 'skip') {
        return { name: descriptor.name, status: 'already-done', detail: status.detail };
      }
      updatingExisting = true;
    }
  }

  // When the resource already exists we are only adopting it — the "how to set this up" walkthrough
  // is noise, so show instructions only for steps that actually provision something new.
  if (!updatingExisting && descriptor.instructions.length > 0) {
    logger.instruction(descriptor.instructions);
  }

  // "update existing" already confirmed intent → go straight to execute.
  const decision = updatingExisting ? 'continue' : await promptStepDecision();
  if (decision === 'abort') {
    logger.warn('Aborted by user.');
    return { name: descriptor.name, status: 'aborted' };
  }
  if (decision === 'skip') {
    logger.warn('Skipped by user.');
    return { name: descriptor.name, status: 'skipped' };
  }

  let attempt = 0;
  while (true) {
    attempt += 1;
    if (attempt > 1) logger.info(`Retry attempt #${attempt}...`);

    let result: T;
    try {
      result = await descriptor.execute();
    } catch (executionError) {
      const message = toError(executionError).message;
      logger.failActiveSpinner(`Failed: ${message}`);
      logger.error(`Failed: ${message}`);
      if (isNonRecoverableProvisionerError(message)) {
        logger.error(
          'Fix credentials or config in .setup/.setup-credentials, then re-run setup:infra.',
        );
        return { name: descriptor.name, status: 'aborted', errorMessage: message };
      }
      const recovery = await promptOnFailure();
      if (recovery === 'retry') continue;
      if (recovery === 'skip') {
        return { name: descriptor.name, status: 'failed', errorMessage: message };
      }
      return { name: descriptor.name, status: 'aborted', errorMessage: message };
    }

    if (descriptor.verifyState) {
      const stateCheck = descriptor.verifyState();
      if (!stateCheck.ok) {
        logger.error(`State verification failed: ${stateCheck.message}`);
        const recovery = await promptOnFailure();
        if (recovery === 'retry') continue;
        if (recovery === 'skip') {
          return {
            name: descriptor.name,
            status: 'failed',
            errorMessage: `state: ${stateCheck.message}`,
          };
        }
        return {
          name: descriptor.name,
          status: 'aborted',
          errorMessage: `state: ${stateCheck.message}`,
        };
      }
      logger.success(`State verified — ${stateCheck.message}`);
    }

    if (descriptor.verifyLive) {
      const liveSpinner = logger.startSpinner('Verifying live resource...');
      let liveCheck: LiveVerification;
      try {
        liveCheck = await descriptor.verifyLive();
      } catch (liveError) {
        liveCheck = { ok: false, message: toError(liveError).message };
      }
      if (liveCheck.ok) {
        logger.stopSpinner(liveSpinner, `Live verified — ${liveCheck.message}`);
      } else {
        logger.stopSpinner(liveSpinner, `Live verification failed — ${liveCheck.message}`, 'fail');
        const recovery = await promptOnFailure();
        if (recovery === 'retry') continue;
        if (recovery === 'skip') {
          return {
            name: descriptor.name,
            status: 'failed',
            errorMessage: `live: ${liveCheck.message}`,
            result,
          };
        }
        return {
          name: descriptor.name,
          status: 'aborted',
          errorMessage: `live: ${liveCheck.message}`,
          result,
        };
      }
    }

    logger.success(`${descriptor.name} — done.`);
    return { name: descriptor.name, status: 'completed', result };
  }
}

export function summarizeOutcomes(outcomes: StepOutcome<unknown>[]): {
  rows: Array<{ env: string; status: string; detail: string }>;
  hasFailures: boolean;
} {
  const rows = outcomes.map((outcome) => ({
    env: outcome.name,
    status:
      outcome.status === 'completed'
        ? 'OK'
        : outcome.status === 'already-done'
          ? 'OK'
          : outcome.status === 'disabled'
            ? 'OFF'
            : outcome.status === 'skipped'
              ? 'SKIP'
              : outcome.status === 'aborted'
                ? 'ABORT'
                : 'FAIL',
    detail: outcome.errorMessage ?? outcome.detail ?? '',
  }));

  const hasFailures = outcomes.some(
    (outcome) => outcome.status === 'failed' || outcome.status === 'aborted',
  );

  return { rows, hasFailures };
}
