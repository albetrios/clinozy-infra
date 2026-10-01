/**
 * Hardened outbound HTTP for the setup-infra module.
 *
 * Standalone (no `@/` imports — keeps the module liftable into other products). Mirrors
 * the shape of the app's `src/infrastructure/outbound/outbound-fetch.ts`: per-request
 * timeout via `AbortController`, a small bounded retry on network/5xx, optional
 * `expectedStatus` enforcement, and redaction of credentials from any thrown message.
 */
import { SetupError } from './setup-error.js';

export interface SetupFetchOptions {
  /** Integration label used in error messages (e.g. 'Resend', 'Neon'). */
  name: string;
  url: string;
  init?: RequestInit;
  /** Per-attempt timeout. Default 15s. */
  timeoutMs?: number;
  /** Extra attempts on network error / 5xx (total = retries + 1). Default 2. */
  retries?: number;
  /** When set, a non-matching status throws a SetupError. */
  expectedStatus?: number | number[];
  /** Override fetch (tests). Defaults to global fetch. */
  fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;

/** Remove bearer tokens, basic-auth userinfo, and secret-ish query params from a string. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(authorization:\s*)(bearer|basic)\s+[\w.\-=/+]+/gi, '$1$2 ••••')
    .replace(/(\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1••••:••••@')
    .replace(/([?&](?:api[_-]?key|token|secret|password|key)=)[^&\s]+/gi, '$1••••');
}

function isExpected(status: number, expected: number | number[]): boolean {
  return Array.isArray(expected) ? expected.includes(status) : status === expected;
}

async function attempt(options: SetupFetchOptions): Promise<Response> {
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await fetchImplementation(options.url, { ...options.init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch with timeout + bounded retry. Throws {@link SetupError} (with secrets redacted)
 * on network failure, timeout, or `expectedStatus` mismatch.
 */
export async function setupFetch(options: SetupFetchOptions): Promise<Response> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  let lastError: unknown;

  for (let i = 0; i <= retries; i += 1) {
    try {
      const response = await attempt(options);
      if (
        options.expectedStatus !== undefined &&
        !isExpected(response.status, options.expectedStatus)
      ) {
        // Retry server errors; fail fast on 4xx (won't fix itself).
        if (response.status >= 500 && i < retries) {
          lastError = new Error(`HTTP ${response.status}`);
          continue;
        }
        throw new SetupError(`${options.name}: unexpected HTTP ${response.status}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (error instanceof SetupError) throw error;
      // network/abort error → retry unless exhausted
      if (i >= retries) break;
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new SetupError(
    `${options.name}: request to ${redactSecrets(options.url)} failed — ${redactSecrets(reason)}`,
  );
}
