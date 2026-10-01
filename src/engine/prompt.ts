/**
 * Prompter abstraction used by the engine's guided-manual provider (vendored
 * from envforge).
 *
 * - {@link ttyPrompter} gives live, interactive prompts and masks secret input
 *   (the readline `_writeToOutput` mute trick).
 * - {@link pipedPrompter} buffers stdin lines so nothing is lost between
 *   questions — makes runs scriptable/CI-safe and never hangs (`ended` flag).
 *
 * Task 5 folds this masking/TTY-vs-piped behavior into `src/common/prompts.ts`
 * so the whole CLI shares it.
 */
import readline from 'node:readline';

export interface AskOptions {
  secret?: boolean;
  default?: string;
}

export interface Prompter {
  ask(question: string, opts?: AskOptions): Promise<string>;
  confirm(question: string, def?: boolean): Promise<boolean>;
  /** True once no more input is available (piped input exhausted / non-interactive). */
  readonly ended: boolean;
  close(): void;
}

export function createPrompter(): Prompter {
  return process.stdin.isTTY ? ttyPrompter() : pipedPrompter();
}

/** Interactive prompter with live prompts and masked secret input. */
function ttyPrompter(): Prompter {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let muted = false;
  let promptText = '';
  let ended = false;
  let pending: ((v: string) => void) | null = null;

  rl.on('close', () => {
    ended = true;
    if (pending) {
      const p = pending;
      pending = null;
      p('');
    }
  });

  const rlAny = rl as unknown as { _writeToOutput: (s: string) => void };
  const origWrite = rlAny._writeToOutput.bind(rl);
  rlAny._writeToOutput = (s: string) => {
    if (!muted) return origWrite(s);
    if (s.includes(promptText)) return origWrite(s);
    if (s === '\n' || s === '\r\n') return origWrite(s);
    process.stdout.write('*');
  };

  const question = (text: string, secret = false): Promise<string> =>
    new Promise((resolve) => {
      if (ended) return resolve('');
      promptText = text;
      muted = secret;
      pending = resolve;
      rl.question(text, (ans) => {
        pending = null;
        if (muted) {
          muted = false;
          process.stdout.write('\n');
        }
        resolve(ans);
      });
    });

  return {
    get ended() {
      return ended;
    },
    async ask(q, opts = {}) {
      const text = opts.default ? `${q} [${opts.default}]: ` : `${q}: `;
      const ans = (await question(text, opts.secret)).trim();
      return ans || opts.default || '';
    },
    async confirm(q, def = false) {
      const ans = (await question(`${q} ${def ? '[Y/n]' : '[y/N]'}: `)).trim().toLowerCase();
      if (!ans) return def;
      return ans === 'y' || ans === 'yes';
    },
    close() {
      rl.close();
    },
  };
}

/**
 * Non-interactive prompter: buffers every stdin line into a queue so none are
 * lost between questions (the readline "dropped line" pitfall). Each ask/confirm
 * consumes the next queued line. Used for CI, tests, and `cmd | setup:infra`.
 */
function pipedPrompter(): Prompter {
  const rl = readline.createInterface({ input: process.stdin });
  const queue: string[] = [];
  const waiters: ((v: string | null) => void)[] = [];
  let ended = false;

  rl.on('line', (line) => {
    const w = waiters.shift();
    if (w) w(line);
    else queue.push(line);
  });
  rl.on('close', () => {
    ended = true;
    while (waiters.length) {
      const w = waiters.shift();
      if (w) w(null);
    }
  });

  const next = (): Promise<string | null> => {
    if (queue.length) {
      const v = queue.shift();
      return Promise.resolve(v ?? null);
    }
    if (ended) return Promise.resolve(null);
    return new Promise((resolve) => waiters.push(resolve));
  };

  return {
    get ended() {
      return ended && queue.length === 0;
    },
    async ask(q, opts = {}) {
      process.stdout.write(opts.default ? `${q} [${opts.default}]: \n` : `${q}: \n`);
      const line = await next();
      const ans = (line ?? '').trim();
      return ans || opts.default || '';
    },
    async confirm(q, def = false) {
      process.stdout.write(`${q} ${def ? '[Y/n]' : '[y/N]'}: \n`);
      const line = await next();
      const ans = (line ?? '').trim().toLowerCase();
      if (!ans) return def;
      return ans === 'y' || ans === 'yes';
    },
    close() {
      rl.close();
    },
  };
}
