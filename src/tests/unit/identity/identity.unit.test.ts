/**
 * Identity tooling — `pnpm rebrand`, `pnpm identity:sync`, `pnpm validate:identity`.
 *
 * Every name here is INVENTED (`acme` → `zenith`; `hub` for the common-word case). A test written
 * with the real brand is itself rewritten by the next rebrand — its expectations updated, its
 * inputs not — and then fails while testing nothing new.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type Identity,
  checkSiblings,
  findDrift,
  findPreviousNames,
  getJsonValue,
  loadIdentity,
  planRebrand,
  renameableFiles,
  renamePairs,
  retiredNames,
  rewriteText,
  setJsonValue,
} from '@setup/identity/identity.js';

const acme: Identity = {
  productName: 'Acme',
  namespace: 'acme',
  toolName: 'acme-infra',
  backendName: 'acme-be',
  displayName: 'Acme Backend',
  frontendName: 'acme-fe',
  organization: 'acme-org',
  repository: 'acme-org/acme-be',
  previousNames: [],
};

const zenith: Identity = {
  ...acme,
  productName: 'Zenith',
  namespace: 'zenith',
  toolName: 'zenith-infra',
  backendName: 'zenith-be',
  displayName: 'Zenith Backend',
  frontendName: 'zenith-fe',
  repository: 'acme-org/zenith-be',
};

const ENVIRONMENTS = ['development', 'production'];

describe('setJsonValue', () => {
  const text = `{
  "project": { "name": "acme-be", "displayName": "a \\"quoted\\" label" },
  "git": { "protectedBranches": ["dev", "main"] },
  "environments": [
    { "name": "development", "label": "Development" },
    { "name": "production", "label": "Production" }
  ]
}
`;

  it('replaces one nested value and leaves every other byte alone', () => {
    const next = setJsonValue(text, ['project', 'name'], 'zenith-be');
    expect(next).toBe(text.replace('"acme-be"', '"zenith-be"'));
    expect(next).toContain('"protectedBranches": ["dev", "main"]');
  });

  it('walks past escaped quotes and into arrays by index', () => {
    expect(setJsonValue(text, ['environments', '1', 'label'], 'Prod')).toContain(
      '{ "name": "production", "label": "Prod" }',
    );
    expect(getJsonValue(text, ['project', 'displayName'])).toBe('a "quoted" label');
  });

  it('writes arrays inline, matching the config style', () => {
    expect(setJsonValue(text, ['git', 'protectedBranches'], ['main'])).toContain(
      '"protectedBranches": ["main"]',
    );
  });

  it('refuses a path that does not exist instead of guessing', () => {
    expect(() => setJsonValue(text, ['project', 'missing'], 'x')).toThrow(/project\.missing/);
  });
});

describe('rewriteText — every token shape', () => {
  const pairs = renamePairs(acme, zenith, ENVIRONMENTS);
  const rename = (text: string): string => rewriteText(text, pairs).next;

  it('kebab slugs: paths, suffixed names, hostnames and sentence case', () => {
    expect(rename('cd ../acme-be && docker run acme-be-api')).toBe(
      'cd ../zenith-be && docker run zenith-be-api',
    );
    expect(rename('https://development--acme-fe.netlify.app')).toBe(
      'https://development--zenith-fe.netlify.app',
    );
    expect(rename('Acme-infra provisions it.')).toBe('Zenith-infra provisions it.');
    expect(rename('wacme-be')).toBe('wacme-be');
  });

  it('UPPER_SNAKE env vars, lower_snake roles and camelCase identifiers', () => {
    expect(rename('process.env.ACME_BE_DIR ?? ACME_FE_DIR')).toBe(
      'process.env.ZENITH_BE_DIR ?? ZENITH_FE_DIR',
    );
    expect(rename('GRANT acme_be_app TO runtime')).toBe('GRANT zenith_be_app TO runtime');
    expect(rename('acmeBeAppMembershipGranted; type AcmeBeRouter')).toBe(
      'zenithBeAppMembershipGranted; type ZenithBeRouter',
    );
  });

  it('display phrases and <namespace>-<env> resource names', () => {
    expect(rename("DEFAULT_DISPLAY_NAME = 'Acme Backend'")).toBe(
      "DEFAULT_DISPLAY_NAME = 'Zenith Backend'",
    );
    expect(rename('`acme-development`, `acme-production`, `acme-<env>`')).toBe(
      '`zenith-development`, `zenith-production`, `zenith-<env>`',
    );
  });

  it('never maps a slug-shaped display name onto a display label', () => {
    const slugLabel = renamePairs({ ...acme, displayName: 'acme-be' }, zenith, ENVIRONMENTS);
    expect(rewriteText('target: acme-be', slugLabel).next).toBe('target: zenith-be');
  });

  // A common-word namespace is never swept as a bare word, so only the explicit pairs reach it.
  const hub: Identity = {
    ...acme,
    productName: 'Hub',
    namespace: 'hub',
    toolName: 'hub-infra',
    backendName: 'hub-be',
    displayName: 'hub-be',
    frontendName: 'hub-fe',
  };
  const renameHub = (text: string): string =>
    rewriteText(text, renamePairs(hub, zenith, ENVIRONMENTS)).next;

  it('sweeps a common-word namespace only through its explicit resource names', () => {
    expect(
      renameHub(
        'The engine hub routes hub-be to `hub-development`; `product.name` (e.g. `hub`); Hub types.',
      ),
    ).toBe(
      'The engine hub routes zenith-be to `zenith-development`; `product.name` (e.g. `zenith`); Hub types.',
    );
  });

  it('renames a checkout path whole, never half (`<namespace>/<slug>`)', () => {
    expect(renameHub('cd ~/projects/hub/hub-infra')).toBe('cd ~/projects/zenith/zenith-infra');
  });
});

describe('retired-name guard', () => {
  const retired: Identity = { ...zenith, previousNames: ['acme-be', 'Acme'] };

  it('finds a retired name in every spelling the sweep rewrites', () => {
    const files: Record<string, string> = {
      'a.ts': 'ACME_BE_DIR acme_be_app acmeBeX ../acme-be',
      'b.md': 'Built for Acme.',
    };
    const hits = findPreviousNames(retired, Object.keys(files), (file) => files[file] ?? '');
    expect(hits).toEqual([
      { file: 'a.ts', name: 'acme-be', count: 4 },
      { file: 'b.md', name: 'Acme', count: 1 },
    ]);
  });

  it('ignores the previousNames list itself — the evidence it runs on', () => {
    const config = '{ "project": { "previousNames": ["acme-be", "Acme"] } }';
    expect(findPreviousNames(retired, ['setup.config.json'], () => config)).toEqual([]);
  });

  it('retires current names plus history, never a name still in use', () => {
    expect(retiredNames({ ...acme, previousNames: ['old-be'] }, zenith)).toEqual([
      'old-be',
      'acme-infra',
      'acme-be',
      'acme-fe',
      'Acme',
      'acme',
    ]);
    expect(retiredNames(acme, { ...zenith, frontendName: 'acme-fe' })).not.toContain('acme-fe');
  });
});

describe('derived surfaces', () => {
  const config = (apiImage: string): string =>
    `${JSON.stringify(
      {
        project: {
          name: 'acme-be',
          artifacts: {
            apiImage,
            workerImage: 'acme-be-worker',
            dockerLocalApiTag: 'acme-be',
            ghcrCacheScopeApi: 'acme-be-api',
            ghcrCacheScopeWorker: 'acme-be-worker',
          },
        },
      },
      null,
      2,
    )}\n`;

  it('is clean when the artifacts match the backend name, and flags drift otherwise', () => {
    expect(findDrift(acme, () => config('acme-be-api'))).toEqual([]);
    expect(findDrift(acme, () => config('stale-api'))).toEqual([
      { file: 'setup.config.json', label: 'Docker/GHCR artifact names (project.artifacts)' },
    ]);
  });
});

describe('planRebrand — end to end in a scratch repo', () => {
  let root = '';
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function scaffold(): void {
    root = mkdtempSync(join(tmpdir(), 'identity-'));
    const write = (file: string, text: string): void => {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), text);
    };
    write('package.json', '{\n  "name": "acme-infra",\n  "private": true\n}\n');
    write(
      'setup.config.json',
      `{
  "project": {
    "name": "acme-be",
    "displayName": "Acme Backend",
    "organization": "acme-org",
    "previousNames": [],
    "artifacts": {
      "apiImage": "acme-be-api",
      "workerImage": "acme-be-worker",
      "dockerLocalApiTag": "acme-be",
      "ghcrCacheScopeApi": "acme-be-api",
      "ghcrCacheScopeWorker": "acme-be-worker"
    }
  },
  "product": { "name": "acme" },
  "frontend": { "name": "acme-fe" },
  "environments": [{ "name": "development" }],
  "providers": {
    "aws": { "s3BucketPrefix": "acme-be" },
    "github": { "repository": "acme-org/acme-be" }
  }
}
`,
    );
    write('src/paths.ts', "const dir = process.env.ACME_BE_DIR ?? '../acme-be'; // acme_be_app\n");
    write('docs/readme.md', '# acme-infra\n\nProvisions `acme-development` for Acme Backend.\n');
    write('.gitignore', '.setup/\n');
    write('.setup/state.json', '{ "bucket": "acme-be-development" }\n');
    symlinkSync('docs', join(root, 'docs-link'));
    execFileSync('git', ['init', '-q'], { cwd: root });
  }

  it('renames everything it should, writes previousNames last, and is then a no-op', () => {
    scaffold();
    const before = loadIdentity(root);
    expect(before).toEqual(acme);

    const plan = planRebrand(root, before, zenith);
    for (const file of plan.files) writeFileSync(join(root, file.file), file.after);

    const after = loadIdentity(root);
    expect(after).toEqual({
      ...zenith,
      previousNames: ['acme-infra', 'acme-be', 'acme-fe', 'Acme', 'acme'],
    });
    const config = readFileSync(join(root, 'setup.config.json'), 'utf8');
    expect(getJsonValue(config, ['project', 'artifacts', 'apiImage'])).toBe('zenith-be-api');
    expect(getJsonValue(config, ['providers', 'aws', 's3BucketPrefix'])).toBe('zenith-be');
    expect(readFileSync(join(root, 'src/paths.ts'), 'utf8')).toBe(
      "const dir = process.env.ZENITH_BE_DIR ?? '../zenith-be'; // zenith_be_app\n",
    );
    expect(readFileSync(join(root, 'docs/readme.md'), 'utf8')).toBe(
      '# zenith-infra\n\nProvisions `zenith-development` for Zenith Backend.\n',
    );

    // Gitignored provisioning state is never touched; symlinks are not walked twice.
    expect(readFileSync(join(root, '.setup/state.json'), 'utf8')).toContain('acme-be');
    expect(renameableFiles(root)).not.toContain('docs-link');

    // The guard now holds: no retired name anywhere, derived fields in sync.
    const read = (file: string): string => readFileSync(join(root, file), 'utf8');
    expect(findPreviousNames(after, renameableFiles(root), read)).toEqual([]);
    expect(findDrift(after, read)).toEqual([]);

    // Re-running the same rename changes nothing.
    expect(
      planRebrand(root, after, { ...zenith, previousNames: after.previousNames }).files,
    ).toEqual([]);
  });
});

describe('checkSiblings', () => {
  let root = '';
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reports a sibling whose own identity disagrees, and skips one that is absent', () => {
    root = mkdtempSync(join(tmpdir(), 'siblings-'));
    const backend = join(root, 'acme-be');
    mkdirSync(join(backend, 'tooling/setup'), { recursive: true });
    writeFileSync(
      join(backend, 'tooling/setup/setup.config.json'),
      JSON.stringify({
        project: { name: 'acme-be', displayName: 'Old Backend' },
        providers: { github: { repository: 'acme-org/acme-be' } },
      }),
    );

    const checks = checkSiblings(acme, { backend, frontend: join(root, 'missing') });
    expect(checks).toEqual([
      {
        repo: 'backend',
        root: backend,
        mismatches: [
          { field: 'project.displayName', expected: 'Acme Backend', actual: 'Old Backend' },
        ],
      },
    ]);
  });
});
