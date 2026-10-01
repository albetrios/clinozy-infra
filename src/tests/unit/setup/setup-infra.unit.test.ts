import { describe, expect, it } from 'vitest';
import { omitUndefined } from '@setup/common/object.js';
import { redactSecrets, setupFetch } from '@setup/common/setup-fetch.js';
import { resourceStatus } from '@setup/common/interactive-step.js';
import { assertInteractive } from '@setup/common/interactive-step.js';
import { SetupError } from '@setup/common/setup-error.js';
import { isSensitive } from '@setup/infra/output.js';

describe('omitUndefined', () => {
  it('drops keys whose value is undefined, keeps the rest', () => {
    expect(omitUndefined({ a: 1, b: undefined, c: 'x' })).toEqual({ a: 1, c: 'x' });
  });
});

describe('redactSecrets', () => {
  it('redacts bearer tokens, basic-auth userinfo, and secret query params', () => {
    expect(redactSecrets('authorization: Bearer sk_live_abc123')).not.toContain('sk_live_abc123');
    expect(redactSecrets('postgres://user:p@ss@host/db')).toContain('••••:••••@');
    expect(redactSecrets('https://api.test/x?api_key=secretvalue')).not.toContain('secretvalue');
  });
});

describe('resourceStatus', () => {
  it('maps present → present, absent → absent (will create)', () => {
    expect(resourceStatus(true, 'in state')).toEqual({ state: 'present', detail: 'in state' });
    expect(resourceStatus(false, 'in state')).toEqual({ state: 'absent', detail: 'will create' });
  });
});

describe('isSensitive (output masking)', () => {
  it('masks credentials by key pattern and by embedded-credential value', () => {
    expect(isSensitive('STRIPE_SECRET_KEY', 'sk_live_x')).toBe(true);
    expect(isSensitive('DATABASE_URL', 'postgres://u:p@h/db')).toBe(true); // value-based
    expect(isSensitive('FRONTEND_URL', 'http://localhost:3000')).toBe(false);
    expect(isSensitive('OAUTH_GOOGLE_CLIENT_ID', 'x.apps.googleusercontent.com')).toBe(false);
  });
});

describe('setupFetch', () => {
  it('returns the response when status matches expectedStatus', async () => {
    const response = await setupFetch({
      name: 'Test',
      url: 'https://example.test/ok',
      expectedStatus: 200,
      retries: 0,
      fetchImplementation: async () => new Response('ok', { status: 200 }),
    });
    expect(response.status).toBe(200);
  });

  it('throws a SetupError on an unexpected non-retryable status', async () => {
    await expect(
      setupFetch({
        name: 'Test',
        url: 'https://example.test/forbidden',
        expectedStatus: 200,
        retries: 0,
        fetchImplementation: async () => new Response('no', { status: 403 }),
      }),
    ).rejects.toBeInstanceOf(SetupError);
  });

  it('retries on 5xx then succeeds', async () => {
    let calls = 0;
    const response = await setupFetch({
      name: 'Test',
      url: 'https://example.test/flaky',
      expectedStatus: 200,
      retries: 2,
      fetchImplementation: async () => {
        calls += 1;
        return new Response('x', { status: calls < 2 ? 500 : 200 });
      },
    });
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('throws a redacted SetupError on network failure', async () => {
    await expect(
      setupFetch({
        name: 'Neon',
        url: 'https://console.neon.tech/x?api_key=topsecret',
        retries: 0,
        fetchImplementation: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toMatchObject({ message: expect.not.stringContaining('topsecret') });
  });
});

describe('assertInteractive', () => {
  it('throws when stdout/stdin is not a TTY (CI / piped)', () => {
    // Vitest runs non-interactively, so this guard must fire.
    expect(() => assertInteractive()).toThrow(/human-only/);
  });
});
