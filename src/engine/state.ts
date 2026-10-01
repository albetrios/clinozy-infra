/**
 * Provisioning state — EPHEMERAL by design.
 *
 * Unlike envforge (which persists `.envforge/state.json`), clinozy-infra keeps state
 * in memory only and hydrates it from live remote APIs when needed. This preserves
 * the existing `--reconstruct` / `--inspect` semantics: the source of truth is the
 * real infrastructure, never a local file that can drift. The engine mutates a
 * {@link State} object passed in by the caller; callers may pre-populate it from
 * remote detection to drive skip-logic.
 */

export interface ResourceState {
  provisionedAt: string;
  outputs: string[];
  data?: unknown;
}

export interface State {
  [env: string]: Record<string, ResourceState> | undefined;
}

/** A fresh, empty in-memory state. */
export function createState(): State {
  return {};
}
