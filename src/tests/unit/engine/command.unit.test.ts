import { describe, expect, it } from 'vitest';
import { getProvider, type ProvisionContext } from '@setup/engine/index.js';
import { silentPrompter } from './helpers.js';

function ctx(config: unknown): ProvisionContext {
  return {
    project: 't',
    env: 'development',
    resource: 'cmd',
    config,
    prompt: silentPrompter(),
    log: () => {},
    existing: {},
    force: false,
  };
}

describe('command provider', () => {
  it('runs a command and captures stdout into an output var', async () => {
    const provider = getProvider('command');
    const result = await provider.provision(
      ctx({
        command: process.execPath,
        args: ['-e', 'process.stdout.write("hello")'],
        outputs: { OUT: { stdout: true } },
      }),
    );
    expect(result.outputs.OUT).toBe('hello');
  });

  it('extracts a regex group from stdout', async () => {
    const provider = getProvider('command');
    const result = await provider.provision(
      ctx({
        command: process.execPath,
        args: ['-e', 'process.stdout.write("published: version=1.2.3 ok")'],
        outputs: { VER: { match: 'version=([0-9.]+)' } },
      }),
    );
    expect(result.outputs.VER).toBe('1.2.3');
  });

  it('throws a helpful error when the command fails', async () => {
    const provider = getProvider('command');
    await expect(
      provider.provision(ctx({ command: process.execPath, args: ['-e', 'process.exit(3)'] })),
    ).rejects.toThrow(/Command "/);
  });
});
