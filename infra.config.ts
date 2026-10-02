/**
 * infra.config.ts — the RESOURCE composition for clinozy-infra.
 *
 * Edit THIS file to add/remove/reorder a provisioned service. Deleting a line
 * removes that service from `plan`/`up` without touching the engine or orchestrator.
 *
 * Project identity (org/name/artifacts, environments, app runtime config) lives in
 * `setup.config.json` — not here. See `src/infra/config.ts` for the split.
 *
 * Every service is a preset (`src/presets/`):
 *  - validate/guide presets replace their bespoke providers outright;
 *  - managed presets wrap a retained API-orchestrating provider (the "client lib")
 *    and add declarative outputs metadata.
 */
import { defineInfraConfig } from './src/infra/config.js';
import {
  awsPreset,
  githubAppWithOauthPreset,
  githubPreset,
  googleOauthPreset,
  jwtPreset,
  neonPreset,
  netlifyPreset,
  postmanPreset,
  posthogPreset,
  railwayPreset,
  railwayRedisPreset,
  resendPreset,
  scalarPreset,
  sentryPreset,
  stripePreset,
  turnstilePreset,
} from './src/presets/index.js';

export default defineInfraConfig({
  // Both targets currently use `.env.<environment>`; clinozy-fe receives only browser-safe VITE_* keys.
  envFiles: {
    backend: (env) => `.env.${env}`,
    frontend: (env) => `.env.${env}`,
  },
  // Order matters — providers run sequentially in the provision loop. A thunk (not a
  // plain array) so the referenced presets are read lazily, after module-init cycles settle.
  resources: () => [
    neonPreset,
    awsPreset,
    sentryPreset,
    jwtPreset,
    resendPreset,
    stripePreset,
    googleOauthPreset,
    githubAppWithOauthPreset,
    posthogPreset,
    turnstilePreset,
    netlifyPreset,
    railwayPreset,
    railwayRedisPreset,
    githubPreset,
    postmanPreset,
    scalarPreset,
  ],
});
