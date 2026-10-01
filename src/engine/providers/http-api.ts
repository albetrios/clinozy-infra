/**
 * Generic API-based provider. Describe the request in config and map fields from
 * the JSON response into env vars — no per-service code needed for most REST APIs.
 *
 * config = {
 *   method?, url, headers?, body?,
 *   outputs: { ENV_VAR: "dot.path[0].into.response" }
 * }
 */
import type { Provider } from '../types.js';

interface HttpApiConfig {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  outputs?: Record<string, string>;
}

export const httpApiProvider: Provider = {
  name: 'httpApi',

  describe(config) {
    const c = config as HttpApiConfig;
    return `${c.method ?? 'GET'} ${c.url}`;
  },

  outputKeys(config) {
    const c = config as HttpApiConfig;
    return Object.keys(c.outputs ?? {});
  },

  async provision(ctx) {
    const c = ctx.config as HttpApiConfig;
    ctx.log(`    → ${c.method ?? 'GET'} ${c.url}`);

    const init: RequestInit = {
      method: c.method ?? 'GET',
      headers: { 'content-type': 'application/json', ...(c.headers ?? {}) },
    };
    if (c.body !== undefined) init.body = JSON.stringify(c.body);

    let res: Response;
    try {
      res = await fetch(c.url, init);
    } catch (e) {
      throw new Error(`Request to ${c.url} failed: ${e instanceof Error ? e.message : e}`);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${c.url}: ${text.slice(0, 400)}`);
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }

    const outputs: Record<string, string> = {};
    for (const [envVar, path] of Object.entries(c.outputs ?? {})) {
      const val = getPath(json, path);
      if (val === undefined || val === null) {
        throw new Error(`Output "${envVar}": path "${path}" not found in response`);
      }
      outputs[envVar] = String(val);
    }

    return { outputs, data: { status: res.status } };
  },
};

/** Resolve "a.b[0].c" against a nested object. */
function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    const record = acc as Record<string, unknown>;
    const m = key.match(/^(\w+)\[(\d+)\]$/);
    if (m) {
      const arr = record[m[1] ?? ''] as unknown[] | undefined;
      return arr?.[Number(m[2])];
    }
    return record[key];
  }, obj);
}
