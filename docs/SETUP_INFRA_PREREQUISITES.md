# Setup-infra prerequisites — credentials you must provide

Fill only the providers that are `enabled: true` in `tooling/setup/setup.config.json`.

> **Two input files.** Account-wide **setup-tooling** tokens go in `.setup/.setup-credentials`.
> Per-environment **app** secrets go in `.env.development` / `.env.production`. Setup *derives*
> outputs (DSNs, `POSTHOG_KEY`, JWT keys, per-env `RAILWAY_TOKEN`) into `.env.<environment>` —
> do not put those in `.setup/.setup-credentials`.

Authoritative source: `pnpm setup:infra:preview` and `tooling/setup/common/secrets.ts`.

## What you put in `.setup/.setup-credentials`

| Provider | What you provide | Variable(s) | Where to get it |
| --- | --- | --- | --- |
| **Neon Postgres** | API key (+ org id if required) | `NEON_API_KEY` · optional `NEON_ORG_ID` | https://console.neon.tech/app/settings/api-keys |
| **AWS S3** | IAM access key pair | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | https://console.aws.amazon.com/iam/home#/users |
| **Sentry** | Auth token | `SENTRY_AUTH_TOKEN` | https://sentry.io/settings/auth-tokens/new-token/ |
| **Resend** | API key | `RESEND_API_KEY` | https://resend.com/api-keys |
| **Railway** (server **+ Redis**) | Account/project-wide token | `RAILWAY_API_TOKEN` | https://railway.com/account/tokens |
| **GitHub** (repo/env secrets) | Personal access token | `GITHUB_TOKEN` | https://github.com/settings/tokens |
| **Cloudflare Turnstile** | API token (Turnstile:Edit) + account id | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | https://dash.cloudflare.com/profile/api-tokens |
| **Postman** | Account API key | `POSTMAN_API_KEY` | https://go.postman.co/settings/me/api-keys |
| **Scalar** | Account API key | `SCALAR_API_KEY` (optional `SCALAR_NAMESPACE` / `SCALAR_SLUG`) | https://dashboard.scalar.com |
| **PostHog** | Personal API key | `POSTHOG_PERSONAL_API_KEY` (optional `POSTHOG_PROJECT_ID` / `POSTHOG_PROJECT_API_KEY`) | https://us.posthog.com/settings/user-api-keys |
| **Netlify** (frontend site) | Personal access token — or nothing when `netlify login` was run on this machine | `NETLIFY_AUTH_TOKEN` | https://app.netlify.com/user/applications#personal-access-tokens |
| **JWT secrets** | — nothing — | — | n/a (generated locally) |

Cloudflare Turnstile is **provisioned** from `CLOUDFLARE_*`: setup creates one widget per environment and writes `CAPTCHA_SITE_KEY` / `CAPTCHA_SECRET` into each `.env.<environment>`. Postman uses `POSTMAN_API_KEY` to create one workspace (named after the project) and a **collection per environment** (`<project>-<env>`, each with that environment's API base URL baked in), then writes `POSTMAN_WORKSPACE_ID` back into each `.env.<environment>` (output). Scalar uses `SCALAR_API_KEY` to publish a Scalar Registry doc **per environment** (slug `<project>-<env>`); the team namespace is auto-resolved from the token.

## What you put in `.env.<environment>` (per environment file)

These are prompted at apply (stdin) and written into the matching `.env.<environment>` — the environment is the **file**, not a key suffix.

| Provider | Keys you enter | What setup does |
| --- | --- | --- |
| **Stripe** | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | **Pure guide (Dashboard only) — no API calls.** Per environment at apply (continue / skip / abort). **dev:** Sandboxes → API keys → `sk_/pk_test_…`. **prod:** live API keys → `sk_/pk_live_…`. **webhook:** Developers → Webhooks → `<public API URL>/api/v1/billing/webhook` → `whsec_…` (local: `stripe listen …`) |
| **Google OAuth** | `OAUTH_GOOGLE_CLIENT_ID` / `_CLIENT_SECRET` / `_REDIRECT_URI` | Per-environment OAuth client in Google Cloud Console; paste at apply (continue / skip / abort per env) |
| **GitHub sign-in (GitHub App)** | `OAUTH_GITHUB_CLIENT_ID` / `_CLIENT_SECRET` / `_REDIRECT_URI` | **Per environment** — paste at apply (continue / skip / abort per env) or pre-fill `.env` files. Recommended: `SETUP_INFRA_GITHUB_OAUTH_PASTE_ONLY=1` (no browser). Optional: manifest auto-create opens a browser once at apply when paste-only is off |

## What setup generates (outputs — do NOT hand-enter)

| Generated value | Comes from |
| --- | --- |
| `DATABASE_URL`, `DATABASE_MIGRATION_URL` | Neon provisioning |
| `REDIS_URL` | Railway Redis provisioning |
| `S3_*` | AWS bucket + IAM user |
| `SENTRY_DSN` | Sentry backend project (`project.name`) create/adopt |
| `SENTRY_FRONTEND_DSN` | Sentry **frontend** project (`frontend.name`) — browser-safe, for clinozy-fe |
| `POSTHOG_KEY`, `POSTHOG_HOST` | One shared PostHog project per env (`<product>-<env>`), resolved from `POSTHOG_PERSONAL_API_KEY` |
| `CAPTCHA_SITE_KEY`, `CAPTCHA_SECRET` | One Turnstile widget per env (`<product>-<env>`), domains incl. the frontend origin |
| `STRIPE_WEBHOOK_SECRET` | Provisioned from the per-env `STRIPE_SECRET_KEY` |
| `RAILWAY_TOKEN` (per-env) | Minted from `RAILWAY_API_TOKEN` |
| `JWT_*`, `SECRETS_ENCRYPTION_KEY` | Generated locally |
| `REDIS_KEY_PREFIX`, `WEBAUTHN_RP_ID`, `WEBAUTHN_RP_NAME` | Derived from `setup.config.json` (product name, `frontend.url.<env>`) |
| `OAUTH_*_REDIRECT_URI`, `SCALAR_SLUG` | Derived by their providers from the SPA origin / project name |
| `RELEASE_PLEASE_TOKEN` (backend + frontend) | Your `GITHUB_TOKEN` — GitHub has no API to mint a personal token |
| `MONTHLY_DATABASE_RESTORE_DRILL_NEON_API_KEY` | Your `NEON_API_KEY` |
| `SENTRY_AUTH_TOKEN` (frontend, source maps) | Your `SENTRY_AUTH_TOKEN` |
| `NETLIFY_SITE_ID`, `NETLIFY_AUTH_TOKEN` (frontend) | The site found/created from the production frontend URL; your Netlify token |

## Shared vs per-codebase naming

`product.domain` (e.g. `clinozy.com`) is the single source of every public address:

| Environment | Frontend | API | CORS |
| --- | --- | --- | --- |
| production | `https://app.<domain>` (attached to the Netlify site) | `https://api.<domain>` (Railway custom domain) | the frontend |
| any other | `https://<env>--<frontend.name>.netlify.app` (Netlify alias) | `https://<env>--api.<domain>` (Railway custom domain) | the frontend |

Email is sent from `noreply@<domain>`; setup registers the domain with Resend. Turnstile widgets
allow both hosts. Each Railway, Netlify and Resend step prints the DNS records still to create. An
explicit `frontend.url.<env>` / `app.frontendUrl.<env>` / `app.allowedOrigins.<env>` /
`providers.resend.fromAddress` still wins over the derived value.

`setup.config.json` distinguishes three names: `project.name` (backend, e.g. `clinozy-be`), `frontend.name`
(frontend, e.g. `clinozy-fe`), and `product.name` (e.g. `clinozy`). Resources **shared** by both apps —
PostHog and Turnstile — are named `<product>-<env>` (`clinozy-development`, `clinozy-production`). Sentry is
**not** shared: the backend and frontend get separate projects (`clinozy-be`, `clinozy-fe`).

## Getting values back out

- **Full backend env (pasteable):** `pnpm setup:infra:output --environment <env> --copy-all` → clipboard.
- **Frontend (clinozy-fe) keys:** `pnpm setup:infra:export-env` writes `.env.<environment>.fe` (Vite names). `pnpm setup:infra:frontend --environment <env> [--vite]` still prints the bundle to stdout.

## Notes

- Run `pnpm setup:infra` — with **multiple environments**, account-level keys are collected first, then **all providers run for development**, then **all providers for production** (continue / skip / abort per environment). Per-env paste steps (Stripe, Google, GitHub) follow the same order in the prerequisite guide.
- **Token-only auth**: `GITHUB_TOKEN` + `RAILWAY_API_TOKEN` in `.setup-credentials` — no `gh auth login` / `railway login`.
- Full detail: `docs/deployment/setup/setup-token-instructions.md`.
