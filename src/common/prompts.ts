import { createInterface } from 'node:readline';
import { clipboardAvailable, copyToClipboard } from './clipboard.js';
import * as logger from './logger.js';

// ─── Non-interactive (--yes) mode ────────────────────────────────────────────
// When set, every confirmation/decision prompt resolves to its SAFE default without
// blocking on stdin: gating confirms → yes, step/env decisions → continue, "already
// present" → skip, on-failure → skip (never an infinite retry). Enabled by `--yes`/`-y`
// in setup.ts. Lets the whole run proceed unattended after the settings review.
let assumeYes = false;

/** Enable/disable non-interactive mode (auto-answer prompts with their safe default). */
export function setAssumeYes(value: boolean): void {
  assumeYes = value;
}

/** True when `--yes` / non-interactive mode is active. */
export function isAssumeYes(): boolean {
  return assumeYes;
}

// ─── Force mode (--force / -f) ───────────────────────────────────────────────
// Re-provision / re-collect even when a resource or credential is already set,
// instead of the default "already configured → keep it". Enabled by `--force`.
let force = false;

/** Enable/disable force mode. */
export function setForce(value: boolean): void {
  force = value;
}

/** True when `--force` is active. */
export function isForce(): boolean {
  return force;
}

export function createReadline(): ReturnType<typeof createInterface> {
  return createInterface({ input: process.stdin, output: process.stdout });
}

export function question(
  readline: ReturnType<typeof createInterface>,
  prompt: string,
  defaultValue?: string,
): Promise<string> {
  const suffix = defaultValue !== undefined && defaultValue !== '' ? ` (${defaultValue})` : '';
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: string): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    // Piped / CI: if stdin closes (EOF) before an answer, resolve with the default
    // instead of hanging forever.
    readline.once('close', () => done(defaultValue ?? ''));
    readline.question(`${prompt}${suffix}: `, (answer) => {
      const trimmed = answer.trim();
      done(trimmed !== '' ? trimmed : (defaultValue ?? ''));
    });
  });
}

export function questionWithDefault(
  readline: ReturnType<typeof createInterface>,
  prompt: string,
  defaultValue: string,
): Promise<string> {
  return question(readline, prompt, defaultValue);
}

/**
 * What a hidden prompt echoes for one readline write: newlines pass through (so Enter
 * still advances the line), everything else is masked with a single `*`. Pure so the
 * masking rule is unit-testable. Mirrors envforge's `_writeToOutput` mute trick.
 */
export function maskedEcho(text: string): string {
  return /[\r\n]/.test(text) ? text : '*';
}

/**
 * Prompt for a secret value, masking typed/pasted characters with `*` (password-style).
 * The prompt text is printed; input is masked. Returns the trimmed value (empty string
 * if the user just pressed Enter).
 */
export function questionHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    let settled = false;
    const done = (value: string): void => {
      if (settled) return;
      settled = true;
      readline.close();
      process.stdout.write('\n');
      resolve(value);
    };
    // Mask echoed input with `*` — the prompt itself is already printed above.
    (readline as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (text) => {
      process.stdout.write(maskedEcho(text));
    };
    // Piped / CI: resolve to empty on EOF instead of hanging.
    readline.once('close', () => done(''));
    readline.question('', (answer) => done(answer.trim()));
  });
}

/**
 * A step that needs the user to fetch a value from an external dashboard.
 *
 * `url` is auto-copied to the system clipboard so the user only has to paste it
 * into the browser; `steps` are printed as an exact numbered checklist.
 */
export interface LinkStepOptions {
  /** One-line title of what this value is and why it is needed. */
  title: string;
  /** The dashboard URL to copy to the clipboard. */
  url: string;
  /** Exact, ordered actions the user performs on that page. */
  steps: string[];
}

/**
 * Print an exact step-by-step block for a value the user must fetch, and copy
 * its link to the clipboard with a prominent "link copied" confirmation.
 *
 * @remarks
 * The clipboard is the primary focus: when a clipboard tool is present the URL
 * is placed there and the user is told to just paste it — the link is still
 * printed as a fallback. No clipboard tool → it degrades to printing the link.
 */
export function presentLinkStep({ title, url, steps }: LinkStepOptions): void {
  logger.blank();
  logger.info(`▸ ${title}`);
  logger.instruction(steps);
  if (clipboardAvailable() && copyToClipboard(url)) {
    logger.blank();
    logger.success(
      '🔗  Link copied to your clipboard — just paste it (⌘V / Ctrl+V) in your browser:',
    );
    logger.info(`    ${url}`);
  } else {
    logger.blank();
    logger.info(`🔗  Open this link in your browser: ${url}`);
  }
  logger.blank();
}
