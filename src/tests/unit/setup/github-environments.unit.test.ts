/**
 * The GitHub provider makes sure each app repo has a GitHub Environment per environment: an existing
 * one is left untouched, a missing one is created. GitHub calls are injected — no network.
 */
import { describe, expect, it } from 'vitest';
import { frontendRepository } from '@setup/common/config.js';
import type { SetupConfig } from '@setup/common/types.js';
import { type GithubEnvironmentApi, ensureGithubEnvironment } from '@setup/github/init.js';
import { buildConfig } from '@setup/infra/init-wizard.js';
import { acceptedGithubPermissions } from '@setup/infra/prerequisites.js';

const fakeGithub = (existing: string[]) => {
  const created: string[] = [];
  const api: GithubEnvironmentApi = {
    exists: (repository, environment) => existing.includes(`${repository}:${environment}`),
    create: (repository, environment) => {
      created.push(`${repository}:${environment}`);
    },
  };
  return { api, created };
};

describe('ensureGithubEnvironment', () => {
  it('creates a missing environment and leaves an existing one alone', () => {
    const github = fakeGithub(['acme/acme-fe:development']);
    expect(ensureGithubEnvironment('acme/acme-fe', 'development', github.api)).toBe('present');
    expect(ensureGithubEnvironment('acme/acme-fe', 'production', github.api)).toBe('created');
    expect(github.created).toEqual(['acme/acme-fe:production']);
  });

  it('surfaces a failed create instead of reporting success', () => {
    const api: GithubEnvironmentApi = {
      exists: () => false,
      create: () => {
        throw new Error('HTTP 403');
      },
    };
    expect(() => ensureGithubEnvironment('acme/acme-fe', 'production', api)).toThrow('HTTP 403');
  });
});

describe('frontendRepository', () => {
  it("is the backend repository's owner plus frontend.name", () => {
    const base = buildConfig('acme-org', 'acme-be', 'Acme Backend', ['development', 'production']);
    const config: SetupConfig = {
      ...base,
      frontend: { name: 'acme-fe' },
      providers: {
        ...base.providers,
        github: { ...base.providers.github, repository: 'acme-org/acme-be' },
      },
    };
    expect(frontendRepository(config)).toBe('acme-org/acme-fe');
    expect(frontendRepository({ ...config, frontend: undefined })).toBeUndefined();
  });
});

describe('acceptedGithubPermissions', () => {
  it("reads the permission GitHub says a fine-grained token lacks from a 403's headers", () => {
    const response = [
      'HTTP/2.0 403 Forbidden',
      'X-Accepted-Github-Permissions: actions=read',
      'X-Github-Media-Type: github.v3',
      '',
      '{"message":"Resource not accessible by personal access token"}',
    ].join('\n');
    expect(acceptedGithubPermissions(response)).toBe('actions=read');
    expect(acceptedGithubPermissions('HTTP/2.0 404 Not Found')).toBeUndefined();
  });
});
