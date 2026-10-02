/**
 * Netlify provider — the frontend site is found (or created) from the production frontend URL.
 * A fake fetch stands in for the Netlify API; names are invented.
 */
import { describe, expect, it } from 'vitest';
import { netlifyTokenFromCliConfig } from '@setup/common/secrets.js';
import type { SetupConfig } from '@setup/common/types.js';
import { buildConfig } from '@setup/infra/init-wizard.js';
import {
  ensureNetlifySite,
  netlifySiteTarget,
} from '@setup/infra/providers/setup-netlify/setup-netlify.provider.js';

const withProductionUrl = (production: string): SetupConfig => ({
  ...buildConfig('acme-org', 'acme-be', 'Acme Backend', ['development', 'production']),
  frontend: { name: 'acme-fe', url: { development: 'http://localhost:5173', production } },
});

/** Fake Netlify API: GET answers from `sites` by domain, POST records the created site. */
function fakeNetlify(
  sites: Record<string, { id: string; name: string; custom_domain?: string }>,
  createStatus = 201,
) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const fetchImplementation = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    if (method === 'POST') {
      const created = { id: 'new-site-id', name: (body as { name: string }).name };
      return new Response(JSON.stringify(created), { status: createStatus });
    }
    if (method === 'PATCH') {
      return new Response(
        JSON.stringify({ id: 'existing-id', name: 'acme-fe', ...(body as object) }),
        {
          status: 200,
        },
      );
    }
    const domain = decodeURIComponent(url.split('/sites/')[1] ?? '');
    const site = sites[domain];
    return site
      ? new Response(JSON.stringify(site), { status: 200 })
      : new Response('{}', { status: 404 });
  };
  return { calls, fetchImplementation };
}

describe('netlifySiteTarget', () => {
  it('names the site after a *.netlify.app production URL', () => {
    expect(netlifySiteTarget(withProductionUrl('https://acme-fe.netlify.app'))).toEqual({
      siteName: 'acme-fe',
    });
  });

  it('uses frontend.name and attaches a custom production domain', () => {
    expect(netlifySiteTarget(withProductionUrl('https://app.acme.test'))).toEqual({
      siteName: 'acme-fe',
      customDomain: 'app.acme.test',
    });
  });

  it('refuses a deploy alias or a missing production URL instead of guessing a name', () => {
    expect(
      netlifySiteTarget(withProductionUrl('https://development--acme-fe.netlify.app')),
    ).toBeUndefined();
    expect(netlifySiteTarget(withProductionUrl(''))).toBeUndefined();
  });
});

describe('ensureNetlifySite', () => {
  it('adopts an existing site without creating anything', async () => {
    const api = fakeNetlify({ 'acme-fe.netlify.app': { id: 'existing-id', name: 'acme-fe' } });
    const result = await ensureNetlifySite(
      'fake-token',
      { siteName: 'acme-fe' },
      api.fetchImplementation,
    );
    expect(result).toEqual({ site: { id: 'existing-id', name: 'acme-fe' }, created: false });
    expect(api.calls.map((call) => call.method)).toEqual(['GET']);
  });

  it('finds a custom-domain site by that domain first', async () => {
    const api = fakeNetlify({
      'app.acme.test': { id: 'custom-id', name: 'acme-fe', custom_domain: 'app.acme.test' },
    });
    const result = await ensureNetlifySite(
      'fake-token',
      { siteName: 'acme-fe', customDomain: 'app.acme.test' },
      api.fetchImplementation,
    );
    expect(result.site.id).toBe('custom-id');
  });

  it('attaches a missing custom domain to an adopted site', async () => {
    const api = fakeNetlify({ 'acme-fe.netlify.app': { id: 'existing-id', name: 'acme-fe' } });
    await ensureNetlifySite(
      'fake-token',
      { siteName: 'acme-fe', customDomain: 'app.acme.test' },
      api.fetchImplementation,
    );
    expect(api.calls.at(-1)).toMatchObject({
      method: 'PATCH',
      body: { custom_domain: 'app.acme.test' },
    });
  });

  it('creates the site (with its custom domain) when none exists', async () => {
    const api = fakeNetlify({});
    const result = await ensureNetlifySite(
      'fake-token',
      { siteName: 'acme-fe', customDomain: 'app.acme.test' },
      api.fetchImplementation,
    );
    expect(result).toEqual({ site: { id: 'new-site-id', name: 'acme-fe' }, created: true });
    expect(api.calls.at(-1)).toMatchObject({
      method: 'POST',
      body: { name: 'acme-fe', custom_domain: 'app.acme.test' },
    });
  });

  it('explains a taken site name instead of failing with a bare status', async () => {
    const api = fakeNetlify({}, 422);
    await expect(
      ensureNetlifySite('fake-token', { siteName: 'acme-fe' }, api.fetchImplementation),
    ).rejects.toThrow(/rejected the new site "acme-fe"/);
  });
});

describe('netlifyTokenFromCliConfig', () => {
  it("reads the active user's token from the Netlify CLI login", () => {
    const config = JSON.stringify({
      userId: 'u1',
      users: { u0: { auth: { token: 'other' } }, u1: { auth: { token: 'active-token' } } },
    });
    expect(netlifyTokenFromCliConfig(config)).toBe('active-token');
  });

  it('returns nothing for a logged-out or unreadable config', () => {
    expect(netlifyTokenFromCliConfig(JSON.stringify({ users: {} }))).toBe('');
    expect(netlifyTokenFromCliConfig('not json')).toBe('');
  });
});
