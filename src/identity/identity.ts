/**
 * Product identity — the single definition every identity tool shares.
 *
 * The identity lives in two files this repo already owns: `package.json` → `name` (this tool)
 * and `setup.config.json` (the backend + frontend it provisions). {@link IDENTITY_FIELDS} maps
 * each identity key to its JSON path, so reading and writing can never disagree:
 *
 *   - `src/identity/rebrand.ts`            renames the product        (`pnpm rebrand`)
 *   - `src/identity/rebrand.ts --sync`     re-derives derived fields   (`pnpm identity:sync`)
 *   - `src/identity/validate-identity.ts`  fails on drift or a retired name (`pnpm validate:identity`)
 *
 * Ported from the sibling frontend's `tooling/identity/identity.mjs`, so a rebrand behaves the
 * same in all three repos: a TOTAL rename (prose included), `previousNames` recording every name
 * the repo has carried, and a guard that fails if one of them comes back.
 *
 * Two deliberate differences from the frontend:
 *   - The sweep walks `git ls-files` (tracked + untracked-not-ignored), not the filesystem. This
 *     repo keeps provider credentials and provisioned-resource state in gitignored `.setup/`;
 *     a filesystem walk would rewrite them.
 *   - `lower_snake` is a fourth token shape: the backend's Postgres roles (`<backend>_app`) are
 *     spelled that way, and missing them grants a role the renamed backend no longer creates.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDefaultArtifacts } from '@setup/identity/project-identity.util.js';

export const SETUP_CONFIG = 'setup.config.json';
export const PACKAGE_JSON = 'package.json';

/** The sibling repos keep their identity here (`tooling/setup/setup.config.json`). */
export const SIBLING_CONFIG = 'tooling/setup/setup.config.json';

export interface Identity {
  /** User-visible product word ("Acme") — derived from `displayName` ("<Product> Backend"). */
  readonly productName: string;
  /** `product.name` — prefix of resources shared by backend + frontend (`<namespace>-<env>`). */
  readonly namespace: string;
  /** `package.json` → `name` — this tool's package + repo name. */
  readonly toolName: string;
  /** `project.name` — the backend repo this tool provisions. */
  readonly backendName: string;
  /** `project.displayName` — human backend label (logs, email "from" name). */
  readonly displayName: string;
  /** `frontend.name` — the frontend repo this tool provisions. */
  readonly frontendName: string;
  /** `project.organization` — owning organization (GitHub owner, Sentry org). */
  readonly organization: string;
  /** `providers.github.repository` — the backend's GitHub `owner/repo`. */
  readonly repository: string;
  /** `project.previousNames` — every name this repo has carried; guarded by validate:identity. */
  readonly previousNames: readonly string[];
}

type IdentityKey = Exclude<keyof Identity, 'productName'>;

interface IdentityField {
  readonly key: IdentityKey;
  readonly file: string;
  readonly path: readonly string[];
}

/** Where each identity key lives. The rebrand writes exactly these; loadIdentity reads them. */
export const IDENTITY_FIELDS: readonly IdentityField[] = [
  { key: 'toolName', file: PACKAGE_JSON, path: ['name'] },
  { key: 'backendName', file: SETUP_CONFIG, path: ['project', 'name'] },
  { key: 'displayName', file: SETUP_CONFIG, path: ['project', 'displayName'] },
  { key: 'organization', file: SETUP_CONFIG, path: ['project', 'organization'] },
  { key: 'namespace', file: SETUP_CONFIG, path: ['product', 'name'] },
  { key: 'frontendName', file: SETUP_CONFIG, path: ['frontend', 'name'] },
  { key: 'repository', file: SETUP_CONFIG, path: ['providers', 'github', 'repository'] },
  { key: 'previousNames', file: SETUP_CONFIG, path: ['project', 'previousNames'] },
];

// ── Formatting-preserving JSON edits ─────────────────────────────────────────────────────────

/**
 * Locate the `[start, end)` span of the value at `path`, or `undefined` when absent.
 *
 * A JSON round-trip would reformat the whole file (`JSON.stringify` expands the inline
 * `["dev", "main"]` arrays and one-line objects this config uses), so identity edits splice the one
 * value they change and leave every other byte alone. Callers pass text `JSON.parse` accepts.
 */
function locateJsonValue(text: string, path: readonly string[]): [number, number] | undefined {
  let found: [number, number] | undefined;
  const skipSpace = (from: number): number => {
    let index = from;
    while (index < text.length && ' \t\n\r'.includes(text.charAt(index))) index += 1;
    return index;
  };
  const stringEnd = (from: number): number => {
    let index = from + 1;
    while (index < text.length && text.charAt(index) !== '"') {
      index += text.charAt(index) === '\\' ? 2 : 1;
    }
    return index + 1;
  };
  const isTarget = (at: readonly string[]): boolean =>
    at.length === path.length && at.every((segment, index) => segment === path[index]);

  const valueEnd = (from: number, at: readonly string[]): number => {
    const start = skipSpace(from);
    const open = text.charAt(start);
    let end: number;
    if (open === '{' || open === '[') {
      const close = open === '{' ? '}' : ']';
      let index = skipSpace(start + 1);
      let position = 0;
      while (text.charAt(index) !== close) {
        let segment = String(position);
        if (open === '{') {
          const keyEnd = stringEnd(index);
          segment = JSON.parse(text.slice(index, keyEnd)) as string;
          index = skipSpace(keyEnd) + 1; // past ':'
        }
        index = skipSpace(valueEnd(index, [...at, segment]));
        if (text.charAt(index) === ',') index = skipSpace(index + 1);
        position += 1;
      }
      end = index + 1;
    } else if (open === '"') {
      end = stringEnd(start);
    } else {
      end = start;
      while (end < text.length && !',}] \t\n\r'.includes(text.charAt(end))) end += 1;
    }
    if (isTarget(at)) found = [start, end];
    return end;
  };

  JSON.parse(text); // reject malformed input before scanning it
  valueEnd(0, []);
  return found;
}

/** Read the value at `path` from JSON text (`undefined` when absent). */
export function getJsonValue(text: string, path: readonly string[]): unknown {
  let node: unknown = JSON.parse(text);
  for (const segment of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Arrays stay on one line (`["a", "b"]`), matching the config's existing inline arrays. */
function formatJsonValue(value: unknown): string {
  return Array.isArray(value)
    ? `[${value.map((item) => JSON.stringify(item)).join(', ')}]`
    : JSON.stringify(value);
}

/** Replace the value at an EXISTING `path`, preserving all other formatting. Throws when absent. */
export function setJsonValue(text: string, path: readonly string[], value: unknown): string {
  const span = locateJsonValue(text, path);
  if (!span) throw new Error(`JSON path "${path.join('.')}" not found.`);
  return `${text.slice(0, span[0])}${formatJsonValue(value)}${text.slice(span[1])}`;
}

// ── Loading ──────────────────────────────────────────────────────────────────────────────────

const BACKEND_LABEL_SUFFIX = ' Backend';

/** "acme" → "Acme" */
const titleCase = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

/**
 * The product word, recovered from the backend display name ("Acme Backend" → "Acme").
 * Falls back to the title-cased namespace when the display name is a bare slug (`acme-be`).
 */
export function productNameOf(displayName: string, namespace: string): string {
  return displayName.endsWith(BACKEND_LABEL_SUFFIX)
    ? displayName.slice(0, -BACKEND_LABEL_SUFFIX.length)
    : titleCase(namespace);
}

/** Load and validate the identity from `package.json` + `setup.config.json` under `root`. */
export function loadIdentity(root: string): Identity {
  const texts = new Map<string, string>();
  const read = (file: string): string => {
    const cached = texts.get(file) ?? readFileSync(join(root, file), 'utf8');
    texts.set(file, cached);
    return cached;
  };

  const values: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const { key, file, path } of IDENTITY_FIELDS) {
    const value = getJsonValue(read(file), path);
    if (key === 'previousNames') {
      // Empty is correct for a repo that has never been renamed.
      values[key] = Array.isArray(value) ? value.map(String) : [];
      continue;
    }
    if (typeof value !== 'string' || value.length === 0)
      missing.push(`${file} → ${path.join('.')}`);
    values[key] = value;
  }
  if (missing.length > 0) {
    throw new Error(`Identity field(s) missing or empty: ${missing.join(', ')}.`);
  }

  const identity = values as Omit<Identity, 'productName'>;
  return { ...identity, productName: productNameOf(identity.displayName, identity.namespace) };
}

/** `environments[].name` from `setup.config.json` — used for `<namespace>-<env>` resource names. */
export function loadEnvironmentNames(root: string): string[] {
  const environments = getJsonValue(readFileSync(join(root, SETUP_CONFIG), 'utf8'), [
    'environments',
  ]);
  return Array.isArray(environments)
    ? environments
        .map((environment) => (environment as { name?: unknown }).name)
        .filter((name): name is string => typeof name === 'string')
    : [];
}

// ── Derived surfaces ─────────────────────────────────────────────────────────────────────────

export interface DerivedSurface {
  readonly file: string;
  readonly label: string;
  /** Idempotent transform: applying it to an in-sync file is a no-op, so it doubles as the check. */
  readonly apply: (text: string) => string;
}

/** Config values computed FROM the identity (never edited by hand). */
export function derivedSurfaces(identity: Identity): DerivedSurface[] {
  return [
    {
      file: SETUP_CONFIG,
      label: 'Docker/GHCR artifact names (project.artifacts)',
      // Optional in the schema — the loader derives the same defaults when the block is absent.
      apply: (text) =>
        getJsonValue(text, ['project', 'artifacts']) === undefined
          ? text
          : Object.entries(buildDefaultArtifacts(identity.backendName)).reduce(
              (acc, [key, value]) => setJsonValue(acc, ['project', 'artifacts', key], value),
              text,
            ),
    },
  ];
}

/** Surfaces whose on-disk content disagrees with the identity (empty when in sync). */
export function findDrift(
  identity: Identity,
  read: (file: string) => string,
): Array<{ file: string; label: string }> {
  return derivedSurfaces(identity)
    .filter((surface) => {
      const text = read(surface.file);
      return surface.apply(text) !== text;
    })
    .map(({ file, label }) => ({ file, label }));
}

// ── Token shapes ─────────────────────────────────────────────────────────────────────────────

const escapeRegExp = (value: string): string => value.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&');

/** Kebab slug to its camelCase spelling (`acme-be` → `acmeBe`). */
export const kebabToCamel = (value: string): string =>
  value.replace(/-([a-z\d])/g, (_match, character: string) => character.toUpperCase());

/** Kebab slug to its UPPER_SNAKE spelling (`acme-be` → `ACME_BE`). */
export const kebabToUpperSnake = (value: string): string => value.toUpperCase().replace(/-/g, '_');

/** Kebab slug to its lower_snake spelling (`acme-be` → `acme_be`). */
export const kebabToLowerSnake = (value: string): string => value.replace(/-/g, '_');

/** "Acme Portal" → "acme-portal" */
export function kebab(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\dA-Za-z]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/**
 * Ordinary words a product could be named. The bare product word and namespace are swept — and
 * guarded — only when they are NOT one of these: "core" is English ("engine core", "Core types"),
 * while an invented name left in prose is exactly what the guard is for.
 */
export const COMMON_WORD_PRODUCT_NAMES = new Set([
  'app',
  'base',
  'cloud',
  'core',
  'flow',
  'hub',
  'infra',
  'link',
  'next',
  'one',
  'platform',
  'portal',
  'pulse',
  'spark',
  'studio',
  'suite',
]);

/** True when a bare word is safe to sweep and guard: letters only, not a common word. */
export function isDistinctiveWord(word: string): boolean {
  return /^[A-Za-z]+$/.test(word) && !COMMON_WORD_PRODUCT_NAMES.has(word.toLowerCase());
}

/** Carry the matched text's leading capitalisation onto the replacement. */
export function matchCase(source: string, replacement: string): string {
  const first = source.charAt(0);
  const isUpper = first === first.toUpperCase() && first !== first.toLowerCase();
  return isUpper ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement;
}

/**
 * Pick the matcher for a token by its SHAPE, so callers pass plain strings:
 *  - `UPPER_SNAKE` → prefix match, so `ACME_BE` hits `ACME_BE_DIR`;
 *  - `lower_snake` → `acme_be` hits the `acme_be_app` Postgres role;
 *  - `camelCase`   → identifier prefix, first letter case-flexible (`acmeBe…` / `AcmeBe…`);
 *  - `kebab-slug`  → case-INSENSITIVE, hyphen-bounded (`../acme-be`, `development--acme-fe.netlify.app`,
 *                    sentence-capitalised `Acme-be`);
 *  - `Two Words`   → case-insensitive phrase ("Acme Backend" / "acme backend");
 *  - a bare word   → case-sensitive whole word.
 */
export function patternFor(from: string): { regex: RegExp; preserveCase: boolean } {
  const token = escapeRegExp(from);
  if (/^[A-Z\d]+(_[A-Z\d]+)+$/.test(from)) {
    return { regex: new RegExp(`(?<!\\w)${token}(?=_|\\b)`, 'g'), preserveCase: false };
  }
  if (/^[a-z\d]+(_[a-z\d]+)+$/.test(from)) {
    return {
      regex: new RegExp(`(?<![A-Za-z\\d])${token}(?![A-Za-z\\d])`, 'g'),
      preserveCase: false,
    };
  }
  if (/^[a-z\d]+[A-Z]/.test(from)) {
    // Only the FIRST character is case-flexible; the lookahead refuses a following lowercase
    // letter or digit so a longer word that merely starts with the token is left alone.
    const first = from.charAt(0);
    return {
      regex: new RegExp(
        `[${first.toLowerCase()}${first.toUpperCase()}]${escapeRegExp(from.slice(1))}(?![a-z\\d])`,
        'g',
      ),
      preserveCase: true,
    };
  }
  if (from.includes('-')) {
    return { regex: new RegExp(`(?<!\\w)${token}(?!\\w)`, 'gi'), preserveCase: true };
  }
  if (from.includes(' ')) {
    return { regex: new RegExp(`(?<![\\w-])${token}(?![\\w-])`, 'gi'), preserveCase: true };
  }
  return { regex: new RegExp(`(?<![\\w-])${token}(?![\\w-])`, 'g'), preserveCase: false };
}

/** Every spelling of a name the sweep rewrites — and therefore every spelling the guard checks. */
export function spellingsOf(name: string): string[] {
  return name.includes('-')
    ? [name, kebabToCamel(name), kebabToUpperSnake(name), kebabToLowerSnake(name)]
    : [name];
}

// ── Rename planning ──────────────────────────────────────────────────────────────────────────

export type RenamePair = readonly [from: string, to: string];

/**
 * Old → new token pairs for a rename, most specific first.
 *
 * The bare namespace / product word is included only when distinctive (see
 * {@link isDistinctiveWord}); `<namespace>-<env>` resource names are explicit pairs instead,
 * because a blanket `<namespace>-` rule would rewrite ordinary hyphenated English.
 */
export function renamePairs(
  from: Identity,
  to: Identity,
  environmentNames: readonly string[],
): RenamePair[] {
  // A hyphen-less slug is a bare word; sweeping a common one ("core") would rewrite English.
  const slugs = (
    [
      [from.toolName, to.toolName],
      [from.backendName, to.backendName],
      [from.frontendName, to.frontendName],
    ] as RenamePair[]
  ).filter(([a]) => a.includes('-') || isDistinctiveWord(a));
  const pairs: RenamePair[] = [
    // A display name that is itself a slug (`acme-be`) is covered by the slug pair — pairing it
    // with "<Product> Backend" would turn every slug occurrence into a display label.
    ...(from.displayName.includes(' ') ? [[from.displayName, to.displayName] as const] : []),
    [`${from.productName} Backend`, `${to.productName} Backend`],
    [`${from.productName} Frontend`, `${to.productName} Frontend`],
    // The checkouts live in a folder named after the product (`~/projects/<namespace>/<slug>`).
    // Anchored on the slug, so it must run BEFORE the slug pairs or the path ends up half-renamed.
    ...slugs.map(([a, b]): RenamePair => [`${from.namespace}/${a}`, `${to.namespace}/${b}`]),
    ...slugs,
    ...slugs
      .filter(([a]) => a.includes('-'))
      .flatMap(([a, b]): RenamePair[] => [
        [kebabToUpperSnake(a), kebabToUpperSnake(b)],
        [kebabToLowerSnake(a), kebabToLowerSnake(b)],
        [kebabToCamel(a), kebabToCamel(b)],
      ]),
    ...[...environmentNames, '<env>'].map(
      (environment): RenamePair => [
        `${from.namespace}-${environment}`,
        `${to.namespace}-${environment}`,
      ],
    ),
    // A backtick-quoted namespace is a config value (`product.name` (e.g. `hub`)), never prose —
    // safe to rename even when the namespace is a common word.
    [`\`${from.namespace}\``, `\`${to.namespace}\``],
    ...(isDistinctiveWord(from.productName) ? [[from.productName, to.productName] as const] : []),
    ...(isDistinctiveWord(from.namespace) ? [[from.namespace, to.namespace] as const] : []),
  ];
  const seen = new Set<string>();
  return pairs.filter(([a, b]) => {
    if (!a || a === b || seen.has(a)) return false;
    seen.add(a);
    return true;
  });
}

/** Apply every pair to one text. Returns the rewritten text and the number of replacements. */
export function rewriteText(
  text: string,
  pairs: readonly RenamePair[],
): { next: string; count: number } {
  let next = text;
  let count = 0;
  for (const [from, to] of pairs) {
    const { regex, preserveCase } = patternFor(from);
    next = next.replace(regex, (match) => {
      count += 1;
      return preserveCase ? matchCase(match, to) : to;
    });
  }
  return { next, count };
}

/** Never rewritten by a rename: generated artifacts and real history. */
const RENAME_SKIP_FILES = new Set(['pnpm-lock.yaml', 'CHANGELOG.md']);

/**
 * Files eligible for the repo-wide sweep and the retired-name guard: tracked plus
 * untracked-not-ignored, minus symlinks (`.claude/skills` → `agent-os/skills` would otherwise be
 * visited twice) and {@link RENAME_SKIP_FILES}. Binary files are dropped later by content.
 */
export function renameableFiles(root: string): string[] {
  let listing: string;
  try {
    listing = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: root, encoding: 'utf8' },
    );
  } catch (error) {
    throw new Error(
      `Identity tools walk \`git ls-files\` so gitignored secrets (.setup/) are never touched — ` +
        `run them inside a git checkout. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return [...new Set(listing.split('\0').filter(Boolean))].filter((file) => {
    if (RENAME_SKIP_FILES.has(file)) return false;
    const full = join(root, file);
    return existsSync(full) && lstatSync(full).isFile();
  });
}

/** True when the text is a text file (no NUL bytes) — `.DS_Store` and images are skipped. */
const isText = (text: string): boolean => !text.includes('\u0000');

/** The repo-wide sweep: every file whose text changes under `pairs`. */
export function planRename(
  files: readonly string[],
  read: (file: string) => string,
  pairs: readonly RenamePair[],
): Array<{ file: string; count: number; next: string }> {
  const changes: Array<{ file: string; count: number; next: string }> = [];
  for (const file of files) {
    const before = read(file);
    if (!isText(before)) continue;
    const { next, count } = rewriteText(before, pairs);
    if (count > 0 && next !== before) changes.push({ file, count, next });
  }
  return changes;
}

/**
 * The names a rename retires: everything already retired plus the current slugs (and the bare
 * product word / namespace when distinctive), minus anything the new identity still uses.
 */
export function retiredNames(from: Identity, to: Identity): string[] {
  const keep = new Set([
    to.toolName,
    to.backendName,
    to.frontendName,
    to.productName,
    to.namespace,
  ]);
  return [
    ...new Set([
      ...from.previousNames,
      from.toolName,
      from.backendName,
      from.frontendName,
      ...[from.productName, from.namespace].filter(isDistinctiveWord),
    ]),
  ].filter((name) => !keep.has(name));
}

export interface PlannedFile {
  readonly file: string;
  readonly before: string;
  readonly after: string;
  readonly reasons: readonly string[];
}

/**
 * Plan a rename from `from` to `to` without writing anything.
 *
 * Every edit lands on an in-memory overlay, in this order: identity fields → derived surfaces →
 * repo-wide sweep → `previousNames`. The list is written LAST because it is the one place that
 * must keep the old names; writing it before the sweep let the sweep rename the list itself,
 * after which the guard compared the repo against the NEW names and passed without checking
 * the old ones (the backend's rebrand hit exactly that).
 */
export function planRebrand(
  root: string,
  from: Identity,
  to: Identity,
): { files: PlannedFile[]; retired: string[]; occurrences: number } {
  const overlay = new Map<string, string>();
  const reasons = new Map<string, string[]>();
  const read = (file: string): string =>
    overlay.get(file) ?? readFileSync(join(root, file), 'utf8');
  const edit = (file: string, next: string, reason: string): void => {
    if (next === read(file)) return;
    overlay.set(file, next);
    reasons.set(file, [...(reasons.get(file) ?? []), reason]);
  };

  for (const { key, file, path } of IDENTITY_FIELDS) {
    if (key === 'previousNames') continue;
    edit(file, setJsonValue(read(file), path, to[key]), 'identity');
  }
  for (const surface of derivedSurfaces(to)) {
    edit(surface.file, surface.apply(read(surface.file)), surface.label);
  }

  let occurrences = 0;
  const pairs = renamePairs(from, to, loadEnvironmentNames(root));
  for (const change of planRename(renameableFiles(root), read, pairs)) {
    occurrences += change.count;
    edit(change.file, change.next, `${change.count} occurrence(s)`);
  }

  const retired = retiredNames(from, to);
  edit(
    SETUP_CONFIG,
    setJsonValue(read(SETUP_CONFIG), ['project', 'previousNames'], retired),
    'previousNames',
  );

  const files = [...overlay.entries()]
    .map(([file, after]) => ({
      file,
      before: readFileSync(join(root, file), 'utf8'),
      after,
      reasons: reasons.get(file) ?? [],
    }))
    .filter((planned) => planned.before !== planned.after)
    .sort((a, b) => a.file.localeCompare(b.file));
  return { files, retired, occurrences };
}

// ── Guards ───────────────────────────────────────────────────────────────────────────────────

/**
 * Occurrences of a retired name, in every spelling the sweep rewrites.
 *
 * The `previousNames` list is masked first — it is the one place that must still hold the
 * retired names, otherwise the guard would flag the evidence it runs on.
 */
export function findPreviousNames(
  identity: Identity,
  files: readonly string[],
  read: (file: string) => string,
): Array<{ file: string; name: string; count: number }> {
  if (identity.previousNames.length === 0) return [];
  const found: Array<{ file: string; name: string; count: number }> = [];
  for (const file of files) {
    const raw = read(file);
    if (!isText(raw)) continue;
    const text = raw.replace(/("previousNames":\s*)\[[^\]]*\]/g, '$1[]');
    for (const name of identity.previousNames) {
      const count = spellingsOf(name).reduce(
        (sum, spelling) => sum + (text.match(patternFor(spelling).regex) ?? []).length,
        0,
      );
      if (count > 0) found.push({ file, name, count });
    }
  }
  return found;
}

export interface SiblingCheck {
  readonly repo: 'backend' | 'frontend';
  readonly root: string;
  readonly mismatches: ReadonlyArray<{ field: string; expected: string; actual: unknown }>;
}

/**
 * Cross-check the sibling repos' own identity against this one.
 *
 * This tool writes env files, GitHub environments and database roles FOR those repos, so a
 * disagreement is not cosmetic: a backend renamed to `<new>-be` creates `<new>_be_app`, and a
 * stale `project.name` here grants a role that no longer exists. Absent siblings are skipped by
 * the caller (`root` undefined), so this repo's CI can run without them.
 */
export function checkSiblings(
  identity: Identity,
  roots: { backend?: string | undefined; frontend?: string | undefined },
): SiblingCheck[] {
  const expectations: Array<{
    repo: SiblingCheck['repo'];
    root: string | undefined;
    fields: Array<[path: string[], expected: string]>;
  }> = [
    {
      repo: 'backend',
      root: roots.backend,
      fields: [
        [['project', 'name'], identity.backendName],
        [['project', 'displayName'], identity.displayName],
        [['providers', 'github', 'repository'], identity.repository],
      ],
    },
    {
      repo: 'frontend',
      root: roots.frontend,
      fields: [
        [['project', 'name'], identity.frontendName],
        [['project', 'backendName'], identity.backendName],
        [['project', 'namespace'], identity.namespace],
      ],
    },
  ];

  const checks: SiblingCheck[] = [];
  for (const { repo, root, fields } of expectations) {
    if (!root || !existsSync(join(root, SIBLING_CONFIG))) continue;
    const text = readFileSync(join(root, SIBLING_CONFIG), 'utf8');
    const mismatches = fields
      .map(([path, expected]) => ({
        field: path.join('.'),
        expected,
        actual: getJsonValue(text, path),
      }))
      .filter(({ expected, actual }) => actual !== expected);
    checks.push({ repo, root, mismatches });
  }
  return checks;
}
