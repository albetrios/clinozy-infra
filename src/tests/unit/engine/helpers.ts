/** Shared test doubles for the engine unit tests. */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineAudit, Prompter } from '@setup/engine/index.js';

/** A prompter driven by pre-scripted answers (no stdin). */
export function scriptPrompter(script: { asks?: string[]; confirms?: boolean[] } = {}): Prompter {
  const asks = [...(script.asks ?? [])];
  const confirms = [...(script.confirms ?? [])];
  return {
    ended: false,
    async ask() {
      return asks.shift() ?? '';
    },
    async confirm(_q, def = false) {
      return confirms.length ? (confirms.shift() ?? def) : def;
    },
    close() {},
  };
}

/**
 * A prompter that provides no answers and reports input as ended — safe for tests
 * that never expect a prompt (a manual provider would throw rather than hang).
 */
export function silentPrompter(): Prompter {
  return {
    ended: true,
    async ask() {
      return '';
    },
    async confirm(_q, def = false) {
      return def;
    },
    close() {},
  };
}

export interface CapturedAuditEntry {
  kind: 'create' | 'update';
  provider: string;
  resource: string;
  detail: string;
}

export interface CapturingAudit extends EngineAudit {
  entries: CapturedAuditEntry[];
}

/** An audit sink that records entries in memory instead of writing the log file. */
export function captureAudit(): CapturingAudit {
  const entries: CapturedAuditEntry[] = [];
  return {
    entries,
    create(provider, resource, detail) {
      entries.push({ kind: 'create', provider, resource, detail });
    },
    update(provider, resource, detail) {
      entries.push({ kind: 'update', provider, resource, detail });
    },
  };
}

/** Fresh temp directory to act as a project's env-file root. */
export function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'clinozy-infra-engine-'));
}

export function readEnvFile(dir: string, name: string): string {
  return readFileSync(join(dir, name), 'utf8');
}
