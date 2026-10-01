/**
 * Locally generate random secrets — no network, no dashboard. Ideal for values
 * you invent rather than fetch: session/JWT signing secrets, webhook secrets.
 *
 * config = {
 *   outputs: {
 *     SESSION_SECRET: "hex",                       // shorthand
 *     JWT_SECRET: { type: "base64", bytes: 48 },   // full form
 *     REQUEST_ID: { type: "uuid" },
 *   }
 * }
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { Provider } from '../types.js';

interface GenerateSpec {
  type?: string;
  bytes?: number;
}

interface GenerateConfig {
  outputs?: Record<string, string | GenerateSpec>;
}

export const generateProvider: Provider = {
  name: 'generate',

  describe(config) {
    const c = config as GenerateConfig;
    return `generate secrets: ${Object.keys(c.outputs ?? {}).join(', ')}`;
  },

  outputKeys(config) {
    const c = config as GenerateConfig;
    return Object.keys(c.outputs ?? {});
  },

  async provision(ctx) {
    const c = ctx.config as GenerateConfig;
    const outputs: Record<string, string> = {};
    for (const [k, spec] of Object.entries(c.outputs ?? {})) {
      const s: GenerateSpec = typeof spec === 'string' ? { type: spec } : spec;
      outputs[k] = gen(s.type ?? 'hex', s.bytes ?? 32);
    }
    return { outputs };
  },
};

function gen(type: string, bytes: number): string {
  switch (type) {
    case 'uuid':
      return randomUUID();
    case 'base64':
      return randomBytes(bytes).toString('base64url');
    default:
      return randomBytes(bytes).toString('hex');
  }
}
