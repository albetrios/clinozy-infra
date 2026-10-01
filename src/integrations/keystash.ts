/**
 * KeyStash vault integration (ported from envforge, config-gated OFF by default).
 *
 * Optionally mirrors provisioned secrets into KeyStash: the value goes to the macOS
 * Keychain (service `com.nikunj.keystash`, account = key id) and metadata + project +
 * mapping go to `store.json` — exactly what the KeyStash app reads. Off unless
 * `keystash: true` is set in `infra.config.ts`, so machines without KeyStash are
 * unaffected.
 *
 * The Keychain write, store IO, platform, clock, and uuid are injected via
 * {@link KeyStashBackend} so the mapping logic is unit-testable without touching the
 * real Keychain.
 *
 * Env overrides (match the app): `SETUP_KEYSTASH_STORE`, `SETUP_KEYSTASH_SERVICE`,
 * `SETUP_KEYSTASH_NO_KEYCHAIN=1` (skip the Keychain write — metadata only).
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

const DEFAULT_SERVICE = 'com.nikunj.keystash';

function defaultStorePath(): string {
  return join(homedir(), 'Library', 'Application Support', 'com.nikunj.keystash', 'store.json');
}

interface KeyMeta {
  id: string;
  name: string;
  provider: string;
  note: string;
  created: number;
}
interface Project {
  id: string;
  name: string;
  path: string;
}
interface Mapping {
  key_id: string;
  project_id: string;
  env_var: string;
}
export interface Store {
  keys: KeyMeta[];
  projects: Project[];
  mappings: Mapping[];
}

function emptyStore(): Store {
  return { keys: [], projects: [], mappings: [] };
}

/** The pieces KeyStash touches — injected so the mapping logic is testable. */
export interface KeyStashBackend {
  writeKeychain(service: string, account: string, value: string): void;
  loadStore(path: string): Store;
  saveStore(path: string, store: Store): void;
  platform(): string;
  now(): number;
  uuid(): string;
}

const defaultBackend: KeyStashBackend = {
  writeKeychain(service, account, value) {
    // -U updates in place if an entry with this service+account already exists.
    execFileSync('security', [
      'add-generic-password',
      '-U',
      '-s',
      service,
      '-a',
      account,
      '-w',
      value,
    ]);
  },
  loadStore(path) {
    if (!existsSync(path)) return emptyStore();
    try {
      const s = JSON.parse(readFileSync(path, 'utf8')) as Partial<Store>;
      return { keys: s.keys ?? [], projects: s.projects ?? [], mappings: s.mappings ?? [] };
    } catch {
      return emptyStore();
    }
  },
  saveStore(path, store) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  },
  platform: () => platform(),
  now: () => Date.now(),
  uuid: () => randomUUID(),
};

/** The slot note associating a key with a project + target file. */
export function slotNote(project: string, relPath: string): string {
  return `${project} · ${relPath}`;
}

export interface VaultInput {
  /** Logical key name (usually the env-var, e.g. RESEND_API_KEY). */
  name: string;
  /** Source provider / service label. */
  provider: string;
  /** Human note (project + target file). Also dedupes the key slot. */
  note: string;
  /** The secret value to store in the Keychain. */
  value: string;
  /** Project this key belongs to. */
  projectName: string;
  projectPath: string;
  /** Env-var the mapping should inject as. */
  envVar: string;
}

export interface KeyStashOptions {
  storePath?: string;
  service?: string;
  /** Skip the Keychain write (metadata only) — for tests / non-macOS. */
  skipKeychain?: boolean;
}

export class KeyStash {
  private store: Store;
  private readonly path: string;
  private readonly service: string;
  private readonly skipKeychain: boolean;
  private readonly backend: KeyStashBackend;

  constructor(options: KeyStashOptions = {}, backend: KeyStashBackend = defaultBackend) {
    this.backend = backend;
    this.path = options.storePath ?? process.env.SETUP_KEYSTASH_STORE ?? defaultStorePath();
    this.service = options.service ?? process.env.SETUP_KEYSTASH_SERVICE ?? DEFAULT_SERVICE;
    this.skipKeychain = options.skipKeychain ?? process.env.SETUP_KEYSTASH_NO_KEYCHAIN === '1';
    if (backend.platform() !== 'darwin' && !this.skipKeychain) {
      throw new Error(
        'KeyStash requires macOS (Keychain). Disable `keystash` in infra.config.ts to run here.',
      );
    }
    this.store = backend.loadStore(this.path);
  }

  /** The set of "name::note" slots already in the store (for status displays). */
  vaultedSlots(): Set<string> {
    return new Set(this.store.keys.map((k) => `${k.name}::${k.note}`));
  }

  private ensureProject(name: string, path: string): string {
    let proj = this.store.projects.find((p) => p.path === path);
    if (!proj) {
      proj = { id: this.backend.uuid(), name, path };
      this.store.projects.push(proj);
    }
    return proj.id;
  }

  private ensureMapping(keyId: string, projectId: string, envVar: string): void {
    const existing = this.store.mappings.find(
      (m) => m.key_id === keyId && m.project_id === projectId,
    );
    if (existing) existing.env_var = envVar;
    else this.store.mappings.push({ key_id: keyId, project_id: projectId, env_var: envVar });
  }

  /** Vault one secret and wire up its project + mapping. Idempotent per (name, note) slot. */
  vault(input: VaultInput): 'added' | 'updated' {
    const projectId = this.ensureProject(input.projectName, input.projectPath);

    let key = this.store.keys.find((k) => k.name === input.name && k.note === input.note);
    const action: 'added' | 'updated' = key ? 'updated' : 'added';
    if (!key) {
      key = {
        id: this.backend.uuid(),
        name: input.name,
        provider: input.provider,
        note: input.note,
        created: Math.floor(this.backend.now() / 1000),
      };
      this.store.keys.push(key);
    } else {
      key.provider = input.provider;
    }

    if (!this.skipKeychain) this.backend.writeKeychain(this.service, key.id, input.value);
    this.ensureMapping(key.id, projectId, input.envVar);
    this.backend.saveStore(this.path, this.store);
    return action;
  }
}
