/**
 * Each environment's Redis is its own Railway service, and a second template deploy into the same
 * project gets a suffixed name — production's became "Redis-ufVc", reachable only at
 * `redis-ufvc.railway.internal`. A hard-coded `redis.railway.internal` crashed production's API.
 */
import { describe, expect, it } from 'vitest';
import {
  buildRailwayRedisUrl,
  redisPrivateHost,
} from '@setup/infra/providers/setup-railway-redis/setup-railway-redis.provider.js';

describe('Railway Redis host', () => {
  it("uses the service's rendered REDISHOST, then RAILWAY_PRIVATE_DOMAIN", () => {
    expect(redisPrivateHost({ REDISHOST: 'redis-ufvc.railway.internal' }, 'Redis-ufVc')).toBe(
      'redis-ufvc.railway.internal',
    );
    expect(redisPrivateHost({ RAILWAY_PRIVATE_DOMAIN: 'redis.railway.internal' }, 'Redis')).toBe(
      'redis.railway.internal',
    );
  });

  it('falls back to the private-DNS name of the service, never an unrendered reference', () => {
    expect(redisPrivateHost({ REDISHOST: '${{RAILWAY_PRIVATE_DOMAIN}}' }, 'Redis-ufVc')).toBe(
      'redis-ufvc.railway.internal',
    );
    expect(redisPrivateHost({}, 'Redis')).toBe('redis.railway.internal');
  });

  it('builds the URL on that host, with the password encoded', () => {
    expect(
      buildRailwayRedisUrl({ password: 'p@ss/word', host: 'redis-ufvc.railway.internal' }),
    ).toBe('redis://default:p%40ss%2Fword@redis-ufvc.railway.internal:6379');
  });
});
