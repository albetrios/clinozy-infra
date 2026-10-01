/**
 * Stripe preset (guide-only).
 *
 * Stripe exposes no API to mint or read API keys, so this preset only prints a Dashboard
 * walkthrough and collects the values you paste, writing them to each `.env.<environment>`.
 * No Stripe API calls are made.
 */
import type { GuidePreset } from './types.js';

const API_KEYS_URL = 'https://dashboard.stripe.com/apikeys';
const WEBHOOK_PATH = '/api/v1/billing/webhook';

/** The exact event set the billing webhook handler consumes (add these when creating the endpoint). */
const WEBHOOK_EVENTS = [
  'customer.created',
  'customer.updated',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.trial_will_end',
  'invoice.paid',
  'invoice.payment_succeeded',
] as const;

export const stripePreset: GuidePreset = {
  kind: 'guide',
  key: 'stripe',
  name: 'Stripe',
  isEnabled: ({ config }) => config.providers.stripe.enabled,
  disabledReason: () => 'disabled in setup.config.json',
  preview: {
    detail: 'Guide only — create keys + webhook in the Dashboard, paste per env',
    url: API_KEYS_URL,
    configKey:
      '.env.<environment> → STRIPE_SECRET_KEY / STRIPE_PUBLISHABLE_KEY / STRIPE_WEBHOOK_SECRET',
  },
  settingsDetail: 'guide + paste keys/webhook per env file',
  perEnv: true,
  dashboard: { url: API_KEYS_URL, label: 'Stripe → developers → API keys' },
  steps: [
    'Open the Stripe dashboard → Developers → API keys (use a Sandbox for development).',
    'Copy the Secret key (sk_…) and the Publishable key (pk_…).',
    'Developers → Webhooks → Add endpoint at <api>/api/v1/billing/webhook, then copy its Signing secret (whsec_…).',
    'Paste STRIPE_SECRET_KEY / STRIPE_PUBLISHABLE_KEY / STRIPE_WEBHOOK_SECRET into .env.<env>.',
  ],
  describe: ({ environments }) => ({ environments }),
  outputs: [
    { key: 'STRIPE_SECRET_KEY', description: 'Stripe secret key' },
    { key: 'STRIPE_PUBLISHABLE_KEY', description: 'Stripe publishable key' },
    { key: 'STRIPE_WEBHOOK_SECRET', description: 'Stripe webhook signing secret' },
  ],
  instructions: [
    'No Stripe API calls are made and nothing is read from .env — this step only guides you and saves what you paste.',
    'development: Stripe Dashboard → account picker → Sandboxes → create a sandbox → Developers → API keys → copy sk_test_/pk_test_.',
    'production: live Dashboard → Developers → API keys → copy sk_live_/pk_live_.',
    `webhook: Dashboard → Developers → Webhooks → Add endpoint → URL <public API URL>${WEBHOOK_PATH}; select events: ${WEBHOOK_EVENTS.join(', ')}; then copy the Signing secret (whsec_…).`,
    `local dev: \`stripe listen --forward-to localhost:3000${WEBHOOK_PATH}\` prints a whsec_ to use.`,
    'Paste STRIPE_SECRET_KEY / STRIPE_PUBLISHABLE_KEY / STRIPE_WEBHOOK_SECRET per environment when prompted → each .env.<environment>.',
    'You can configure one environment at a time — skip development or production if not ready yet.',
  ],
  guide: {
    scope: 'per-environment',
    guideError: 'guide-only — enter keys + webhook secret manually in .env.<environment>',
    summaryLine: 'Stripe: keys + webhook secret saved to .env.<environment>',
    fields: [
      {
        key: 'STRIPE_SECRET_KEY',
        label: 'Secret key (sk_test_… for the dev sandbox, sk_live_… for production)',
        secret: true,
      },
      {
        key: 'STRIPE_PUBLISHABLE_KEY',
        label: 'Publishable key (pk_test_… dev, pk_live_… prod)',
      },
      {
        key: 'STRIPE_WEBHOOK_SECRET',
        label: 'Webhook signing secret (whsec_… from the Dashboard endpoint or `stripe listen`)',
        secret: true,
      },
    ],
  },
  deleteInstructions: ({ config }) => {
    if (!config.providers.stripe.enabled) return [];
    return [
      {
        provider: 'Stripe',
        dashboardUrl: 'https://dashboard.stripe.com/webhooks',
        steps: [
          `Developers → Webhooks → open the endpoint at <your-url>${WEBHOOK_PATH} → Delete.`,
          'Delete the sandbox (Dashboard account picker → Sandboxes → ⋯ → Delete) if no longer needed.',
        ],
        resources: [{ label: 'Webhook path', identifier: WEBHOOK_PATH }],
      },
    ];
  },
};
