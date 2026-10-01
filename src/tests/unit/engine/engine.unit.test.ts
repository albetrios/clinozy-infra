import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createState, defineConfig, parseEnv, provisionConfig } from '@setup/engine/index.js';
import {
  captureAudit,
  readEnvFile,
  scriptPrompter,
  silentPrompter,
  tmpProject,
} from './helpers.js';

const noLog = () => {};

describe('provisionConfig — end to end', () => {
  it('runs a mock-provider config, writes the .env, and records audit entries', async () => {
    const dir = tmpProject();
    const audit = captureAudit();
    const config = defineConfig({
      project: 'demo',
      environments: ['development'],
      envFile: (env) => `.env.${env}`,
      resources: [
        {
          name: 'consts',
          provider: 'mock',
          config: { outputs: { FOO: 'bar', WHO: 'user-{env}' } },
        },
      ],
    });

    await provisionConfig(config, {
      projectDir: dir,
      prompter: silentPrompter(),
      log: noLog,
      audit,
    });

    const content = readEnvFile(dir, '.env.development');
    expect(content).toContain('FOO=bar');
    expect(content).toContain('WHO=user-development');

    const created = audit.entries.filter((e) => e.kind === 'create').map((e) => e.detail);
    expect(created).toEqual(
      expect.arrayContaining(['FOO → .env.development', 'WHO → .env.development']),
    );
  });

  it('rejects an unknown environment', async () => {
    const dir = tmpProject();
    const config = defineConfig({
      project: 'demo',
      environments: ['development'],
      envFile: (env) => `.env.${env}`,
      resources: [{ name: 'c', provider: 'mock', config: { outputs: { A: '1' } } }],
    });

    await expect(
      provisionConfig(config, {
        projectDir: dir,
        envs: ['staging'],
        prompter: silentPrompter(),
        log: noLog,
      }),
    ).rejects.toThrow(/Unknown environment/);
  });
});

describe('provisionConfig — ctx.get() chaining', () => {
  it("resolves a later resource's config from an earlier resource's output", async () => {
    const dir = tmpProject();
    const config = defineConfig({
      project: 'chain',
      environments: ['development'],
      envFile: (env) => `.env.${env}`,
      resources: [
        { name: 'a', provider: 'mock', config: { outputs: { A_KEY: 'alpha' } } },
        {
          name: 'b',
          provider: 'mock',
          config: (_env, ctx) => ({ outputs: { B_KEY: `${ctx.get('A_KEY') ?? 'MISSING'}-beta` } }),
        },
      ],
    });

    await provisionConfig(config, { projectDir: dir, prompter: silentPrompter(), log: noLog });

    expect(readEnvFile(dir, '.env.development')).toContain('B_KEY=alpha-beta');
  });
});

describe('provisionConfig — skip-logic and --force', () => {
  it('skips an already-provisioned resource but re-runs it under --force', async () => {
    const dir = tmpProject();
    const state = createState();
    const config = defineConfig({
      project: 'gen',
      environments: ['development'],
      envFile: (env) => `.env.${env}`,
      resources: [
        { name: 'secret', provider: 'generate', config: { outputs: { SESSION_SECRET: 'hex' } } },
      ],
    });
    const opts = { projectDir: dir, state, prompter: silentPrompter(), log: noLog };

    await provisionConfig(config, opts);
    const v1 = parseEnv(readEnvFile(dir, '.env.development')).SESSION_SECRET;
    expect(v1).toBeTruthy();

    // Second run: state recorded + key present → skipped, value unchanged.
    await provisionConfig(config, opts);
    const v2 = parseEnv(readEnvFile(dir, '.env.development')).SESSION_SECRET;
    expect(v2).toBe(v1);

    // With --force it re-generates a fresh value.
    await provisionConfig(config, { ...opts, force: true });
    const v3 = parseEnv(readEnvFile(dir, '.env.development')).SESSION_SECRET;
    expect(v3).not.toBe(v1);
  });
});

describe('provisionConfig — manual keep-existing flow', () => {
  it('keeps an existing key when confirmed, and replaces it under --force', async () => {
    const dir = tmpProject();
    writeFileSync(join(dir, '.env.development'), 'API_KEY=old\n');
    const config = defineConfig({
      project: 'svc',
      environments: ['development'],
      envFile: (env) => `.env.${env}`,
      resources: [
        { name: 'thing', provider: 'manual', config: { prompts: { API_KEY: { secret: true } } } },
      ],
    });

    // Confirm "keep existing" → value untouched.
    await provisionConfig(config, {
      projectDir: dir,
      prompter: scriptPrompter({ confirms: [true] }),
      log: noLog,
    });
    expect(parseEnv(readEnvFile(dir, '.env.development')).API_KEY).toBe('old');

    // --force bypasses the keep prompt and takes the pasted value.
    await provisionConfig(config, {
      projectDir: dir,
      force: true,
      prompter: scriptPrompter({ asks: ['fresh'] }),
      log: noLog,
    });
    expect(parseEnv(readEnvFile(dir, '.env.development')).API_KEY).toBe('fresh');
  });
});
