/**
 * `product.domain` is the single source of every public address. Invented names (`acme`).
 */
import { describe, expect, it } from 'vitest';
import { resolveResendFromAddress } from '@setup/common/resend-from.js';
import type { SetupConfig } from '@setup/common/types.js';
import {
  allowedOriginsForEnvironment,
  apiHostForEnvironment,
  appHostForEnvironment,
  backendOriginForEnvironment,
  frontendOriginForEnvironment,
} from '@setup/envs/env-file-setup.util.js';
import { buildConfig } from '@setup/infra/init-wizard.js';
import { satisfiesMinimumNode } from '@setup/infra/prerequisites.js';
import { sameDomains } from '@setup/infra/providers/setup-cloudflare-turnstile/setup-cloudflare-turnstile.provider.js';
import { ensureResendSenderDomain } from '@setup/presets/resend.preset.js';

/** Wizard defaults with every explicit URL removed, so only the domain drives the addresses. */
const withDomain = (domain?: string): SetupConfig => {
  const config = buildConfig('acme-org', 'acme-be', 'Acme Backend', ['development', 'production']);
  return {
    ...config,
    product: { name: 'acme', ...(domain ? { domain } : {}) },
    frontend: { name: 'acme-fe' },
    app: { ...config.app, frontendUrl: {}, allowedOrigins: {} },
  };
};

describe('hosts derived from product.domain', () => {
  const config = withDomain('acme.test');

  it('puts production on app./api. and other environments on <env>--api. + the Netlify alias', () => {
    expect(appHostForEnvironment(config, 'production')).toBe('app.acme.test');
    expect(apiHostForEnvironment(config, 'production')).toBe('api.acme.test');
    expect(appHostForEnvironment(config, 'development')).toBe('development--acme-fe.netlify.app');
    expect(apiHostForEnvironment(config, 'development')).toBe('development--api.acme.test');
  });

  it('feeds the frontend, API and CORS origins, one environment at a time', () => {
    expect(frontendOriginForEnvironment(config, 'production')).toBe('https://app.acme.test');
    expect(backendOriginForEnvironment(config, 'production')).toBe('https://api.acme.test');
    expect(allowedOriginsForEnvironment(config, 'production')).toBe('https://app.acme.test');
    expect(allowedOriginsForEnvironment(config, 'development')).toBe(
      'https://development--acme-fe.netlify.app',
    );
  });

  it('lets an explicit per-environment value win over the derived one', () => {
    const explicit: SetupConfig = {
      ...config,
      frontend: { name: 'acme-fe', url: { production: 'https://www.acme.test' } },
      app: { ...config.app, allowedOrigins: { production: 'https://a.test,https://b.test' } },
    };
    expect(frontendOriginForEnvironment(explicit, 'production')).toBe('https://www.acme.test');
    expect(allowedOriginsForEnvironment(explicit, 'production')).toBe(
      'https://a.test,https://b.test',
    );
  });

  it('keeps the local fallbacks when no domain is configured', () => {
    const plain = withDomain();
    expect(apiHostForEnvironment(plain, 'production')).toBeUndefined();
    expect(frontendOriginForEnvironment(plain, 'production')).toBe('');
    expect(backendOriginForEnvironment(plain, 'development')).toBe('http://localhost:3000');
  });

  it('sends mail from noreply@<domain> unless an address is pinned', () => {
    expect(resolveResendFromAddress(config)).toBe('noreply@acme.test');
    const pinned = {
      ...config,
      providers: {
        ...config.providers,
        resend: { ...config.providers.resend, fromAddress: 'hello@acme.test' },
      },
    };
    expect(resolveResendFromAddress(pinned)).toBe('hello@acme.test');
  });
});

describe('satisfiesMinimumNode', () => {
  it('compares a >= engines range against the running Node', () => {
    expect(satisfiesMinimumNode('>=24.15', '24.13.0')).toBe(false);
    expect(satisfiesMinimumNode('>=24.15', '24.21.0')).toBe(true);
    expect(satisfiesMinimumNode('>=24.15', 'v24.15.0')).toBe(true);
    expect(satisfiesMinimumNode('^24', '20.0.0')).toBe(true); // other shapes are not judged
  });
});

describe('Turnstile sameDomains', () => {
  it('ignores order and case, and notices a missing host', () => {
    expect(
      sameDomains(['App.acme.test', 'api.acme.test'], ['api.acme.test', 'app.acme.test']),
    ).toBe(true);
    expect(sameDomains(['acme-fe.netlify.app'], ['app.acme.test', 'api.acme.test'])).toBe(false);
  });
});

describe('ensureResendSenderDomain', () => {
  const fakeResend = (domains: Array<{ id: string; name: string; status: string }>) => {
    const calls: string[] = [];
    const fetchImplementation = async (url: string, init?: RequestInit): Promise<Response> => {
      const path = url.replace('https://api.resend.com', '');
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/domains' && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ data: domains }), { status: 200 });
      }
      if (path === '/domains') {
        return new Response(
          JSON.stringify({ id: 'new', name: 'acme.test', status: 'not_started', records: [] }),
          { status: 201 },
        );
      }
      const found = domains.find((domain) => path === `/domains/${domain.id}`);
      return new Response(JSON.stringify({ ...found, records: [] }), { status: 200 });
    };
    return { calls, fetchImplementation };
  };

  it('reuses a registered domain without creating anything', async () => {
    const api = fakeResend([{ id: 'd1', name: 'acme.test', status: 'verified' }]);
    expect(
      await ensureResendSenderDomain('fake-key', 'acme.test', api.fetchImplementation),
    ).toEqual({ status: 'verified', created: false });
    expect(api.calls).toEqual(['GET /domains', 'GET /domains/d1']);
  });

  it('adds the domain when Resend does not know it yet', async () => {
    const api = fakeResend([]);
    expect(
      await ensureResendSenderDomain('fake-key', 'acme.test', api.fetchImplementation),
    ).toEqual({ status: 'not_started', created: true });
    expect(api.calls).toEqual(['GET /domains', 'POST /domains']);
  });
});
