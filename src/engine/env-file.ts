/**
 * Surgical `.env` read/write (vendored from envforge, hardened for clinozy-infra).
 *
 * `upsertEnvContent` edits existing text in place: existing keys keep their
 * position, `export ` prefix, and surrounding lines; genuinely new keys are
 * appended under a single labeled managed block. Blank lines, comments, and
 * unrelated keys are preserved byte-for-byte. Idempotent — re-running with the
 * same values is a no-op.
 *
 * It is multi-line-aware: updating a key whose current value is a quoted block
 * spanning several physical lines (e.g. a PEM `JWT_PRIVATE_KEY`) replaces the
 * whole block, so no orphaned continuation lines are left behind.
 *
 * Callers pass a value formatter. The engine's own loop uses {@link formatValue};
 * clinozy-infra's env exporter passes `escapeEnvValue` so multi-line/PEM secrets
 * round-trip through dotenv identically.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const VAR_RE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=)(.*)$/;

const MANAGED_HEADER = '# --- managed by clinozy-infra ---';
const MANAGED_MARKER = 'managed by clinozy-infra';

export type ValueFormatter = (value: string) => string;

/** Parse a .env file into a flat key/value map (strips surrounding quotes). */
export function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(VAR_RE);
    if (!m) continue;
    const key = m[2];
    if (key === undefined) continue;
    let v = (m[4] ?? '').trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[key] = v;
  }
  return out;
}

/**
 * Compute the surgical upsert of `updates` into `existingText`. Pure — no IO.
 * Returns the new text plus which keys were changed in place vs. newly added.
 */
export function upsertEnvContent(
  existingText: string,
  updates: Record<string, string>,
  format: ValueFormatter = formatValue,
): { text: string; changed: string[]; added: string[] } {
  const lines = existingText.length ? existingText.split(/\r?\n/) : [];
  const remaining = new Map(Object.entries(updates));
  const changed: string[] = [];
  const added: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const m = line.match(VAR_RE);
    if (!m) continue;
    const key = m[2];
    if (key === undefined || !remaining.has(key)) continue;
    const val = remaining.get(key) ?? '';
    const end = entryEndIndex(lines, i, m[4] ?? '');
    const rebuilt = `${m[1] ?? ''}${key}${m[3] ?? '='}${format(val)}`;
    // Replace the whole entry (its opening line + any quoted continuation lines).
    lines.splice(i, end - i + 1, rebuilt);
    changed.push(key);
    remaining.delete(key);
    // `i` now indexes `rebuilt`; the loop's i++ advances past it correctly.
  }

  if (remaining.size) {
    const hasHeader = existingText.includes(MANAGED_MARKER);
    const last = lines[lines.length - 1];
    if (lines.length && last !== undefined && last.trim() !== '') lines.push('');
    if (!hasHeader) lines.push(MANAGED_HEADER);
    for (const [key, val] of remaining) {
      lines.push(`${key}=${format(val)}`);
      added.push(key);
    }
  }

  return { text: lines.join('\n').replace(/\n*$/, '\n'), changed, added };
}

/**
 * Upsert keys into a .env file on disk (writes with a trailing newline). Thin
 * IO wrapper over {@link upsertEnvContent} using the default {@link formatValue}.
 */
export function upsertEnv(
  filePath: string,
  updates: Record<string, string>,
): { changed: string[]; added: string[] } {
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const { text, changed, added } = upsertEnvContent(existing, updates);
  writeFileSync(filePath, text, 'utf8');
  return { changed, added };
}

/**
 * Index of the last physical line belonging to the entry that starts at
 * `startIndex`. For an unquoted value that's just `startIndex`; for a value that
 * opens a quote not closed on the same line, it scans forward to the line that
 * closes it (so multi-line PEM blocks are handled as one unit).
 */
function entryEndIndex(lines: string[], startIndex: number, rawValue: string): number {
  const trimmed = rawValue.trimStart();
  const quote = trimmed[0];
  if (quote !== '"' && quote !== "'") return startIndex;
  if (closesQuote(trimmed.slice(1), quote)) return startIndex;
  for (let j = startIndex + 1; j < lines.length; j++) {
    const line = lines[j];
    if (line === undefined) return j - 1;
    if (closesQuote(line, quote)) return j;
  }
  return startIndex; // unterminated — don't swallow the rest of the file
}

/** True if `s` contains an unescaped closing `quote`. */
function closesQuote(s: string, quote: string): boolean {
  if (quote === "'") return s.includes("'");
  let backslashes = 0;
  for (const ch of s) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (ch === '"' && backslashes % 2 === 0) return true;
    backslashes = 0;
  }
  return false;
}

/** The engine's default formatter (simple, unquoted-when-safe). */
function formatValue(v: string): string {
  if (v === '') return '';
  // Unquoted only when safe; otherwise double-quote and escape.
  if (/^[A-Za-z0-9_./:+@?=&%-]+$/.test(v)) return v;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
