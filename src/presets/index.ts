/**
 * Preset catalog. Each service is declared as preset DATA; `presetToProvider`
 * turns a preset into the uniform InfraProvider the orchestrator drives.
 *
 * Kinds:
 *  - validate  — probes a credential (Resend).
 *  - guide     — dashboard walkthrough + paste collection (Stripe, Google OAuth).
 *  - managed   — thin wrapper over a retained API-orchestrating provider (Neon,
 *                Railway, AWS, Sentry, …) plus declarative outputs metadata.
 */
import { googleOauthPreset } from './google-oauth.preset.js';
import {
  awsPreset,
  githubAppWithOauthPreset,
  githubPreset,
  jwtPreset,
  neonPreset,
  postmanPreset,
  posthogPreset,
  railwayPreset,
  railwayRedisPreset,
  scalarPreset,
  sentryPreset,
  turnstilePreset,
} from './managed.presets.js';
import { resendPreset } from './resend.preset.js';
import { stripePreset } from './stripe.preset.js';
import type { Preset } from './types.js';

export { presetToProvider } from './types.js';
export { buildEnvExample } from './example.js';
export { lintPreset, lintPresets } from './lint.js';
export type {
  GuidePreset,
  ManagedPreset,
  Preset,
  PresetOutput,
  ValidatePreset,
} from './types.js';
export { googleOauthPreset } from './google-oauth.preset.js';
export { resendPreset } from './resend.preset.js';
export { stripePreset } from './stripe.preset.js';
export {
  awsPreset,
  githubAppWithOauthPreset,
  githubPreset,
  jwtPreset,
  neonPreset,
  postmanPreset,
  posthogPreset,
  railwayPreset,
  railwayRedisPreset,
  scalarPreset,
  sentryPreset,
  turnstilePreset,
} from './managed.presets.js';

/** Every preset, in provisioning order (used by metadata tests and doctor/example). */
export const PRESETS: readonly Preset[] = [
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
  railwayPreset,
  railwayRedisPreset,
  githubPreset,
  postmanPreset,
  scalarPreset,
];
