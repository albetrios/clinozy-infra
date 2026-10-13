# Setup-infra prerequisites — credentials you must provide

Only the providers that are `enabled: true` in `setup.config.json` need anything.

> **One input file.** Everything you provide goes in this repo's `.setup/.setup-credentials`:
> account-wide tokens as plain keys, and per-environment app secrets (Stripe, Google sign-in) as
> `KEY__<environment>`. Setup writes every app value into `../<backend>/.env.<environment>` and
> `../<frontend>/.env.<environment>` — never hand-edit those for anything setup manages.

## Before you run — this machine

`pnpm setup:infra:prereqs` checks every row below (each run starts with the same check).

| Need | Why | Ready when |
| --- | --- | --- |
| **Node and pnpm** at least the strictest `engines` of the three repos (today Node ≥ 24.15, pnpm ≥ 12.8.1; all three pin Node 24.21.0 and pnpm 12.8.1) | runs setup and the backend's docs scripts (Postman, Scalar) | checked at start; differing pins (`.nvmrc`, `packageManager`) are flagged |
| **Backend + frontend checked out next to this repo**, dependencies installed | setup writes their `.env.<environment>` files and runs the backend's scripts | `../<backend>` and `../<frontend>` exist; `pnpm install` done in each |
| **GitHub CLI** (`gh`) | GitHub API: environments in both app repos, checklist checks | `GITHUB_TOKEN` in `.setup-credentials`, or `gh auth login` — and that login can manage GitHub Environments in both app repos |
| **Railway CLI** (`railway`) | Railway project, services, tokens | `RAILWAY_API_TOKEN` in `.setup-credentials` (no `railway login` needed) |
| **Netlify** | frontend site | logged in once on this machine: `npx netlify-cli login` (no global install needed). Setup uses only that login — there is no Netlify token to paste |
| **`setup.config.json`** | names, environments, `product.domain`, which providers are enabled | committed — edit it, never hard-code names |
| **`.setup/.setup-credentials`** | every token and per-environment secret below | nothing to prepare: an interactive `pnpm setup:infra` asks once for each missing value — one line with its link, hidden input — and saves it here (Enter skips; asked again next run) |

Authoritative source: `pnpm setup:infra:preview` and `src/common/secrets.ts`.

## What you put in `.setup/.setup-credentials`

| Provider | What you provide | Variable(s) | Where to get it |
| --- | --- | --- | --- |
| **Neon Postgres** | API key (+ org id if required) | `NEON_API_KEY` · optional `NEON_ORG_ID` | https://console.neon.tech/app/settings/api-keys |
| **AWS S3** | IAM access key pair | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | https://console.aws.amazon.com/iam/home#/users |
| **Sentry** | Auth token | `SENTRY_AUTH_TOKEN` | https://sentry.io/settings/auth-tokens/new-token/ |
| **Resend** | API key | `RESEND_API_KEY` | https://resend.com/api-keys |
| **Railway** (server **+ Redis**) | Account/project-wide token | `RAILWAY_API_TOKEN` | https://railway.com/account/tokens |
| **GitHub** (GitHub Environments in both app repos; release token) | Personal access token — fine-grained, on both app repos: Actions (read), Administration (read & write), Environments (read & write), Contents + Pull requests (write) — or `gh auth login` | `GITHUB_TOKEN` | https://github.com/settings/tokens |
| **Cloudflare Turnstile** | API token (Turnstile:Edit) + account id | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | https://dash.cloudflare.com/profile/api-tokens |
| **Postman** | Account API key | `POSTMAN_API_KEY` | https://go.postman.co/settings/me/api-keys |
| **Scalar** | Account API key | `SCALAR_API_KEY` (optional `SCALAR_NAMESPACE` / `SCALAR_SLUG`) | https://dashboard.scalar.com |
| **PostHog** | Personal API key | `POSTHOG_PERSONAL_API_KEY` (optional `POSTHOG_PROJECT_ID` / `POSTHOG_PROJECT_API_KEY`) | https://us.posthog.com/settings/user-api-keys |
| **JWT secrets** | — nothing — | — | n/a (generated locally) |

Cloudflare Turnstile is **provisioned** from `CLOUDFLARE_*`: setup creates one widget per environment and writes `CAPTCHA_SITE_KEY` / `CAPTCHA_SECRET` into each `.env.<environment>`. Postman uses `POSTMAN_API_KEY` to create one workspace (named after the project) and a **collection per environment** (`<project>-<env>`, each with that environment's API base URL baked in), then writes `POSTMAN_WORKSPACE_ID` back into each `.env.<environment>` (output). Scalar uses `SCALAR_API_KEY` to publish a Scalar Registry doc **per environment** (slug `<project>-<env>`); the team namespace is auto-resolved from the token.

## Per-environment app secrets — also in `.setup/.setup-credentials`

No API can create these, so you provide them once per environment, as `KEY__<environment>` (e.g.
`STRIPE_SECRET_KEY__production`) — an interactive run asks for any that are missing and saves them.
Setup writes them into the backend's `.env.<environment>`; an empty value keeps what the env file
holds. A plain `KEY` without the suffix is never used for these, so a key exported in your shell
cannot end up in another environment.

| Provider | Keys (`__<environment>`) | Where to get them |
| --- | --- | --- |
| **Stripe** | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | **dev:** a Sandbox → API keys (`sk_test_`/`pk_test_`). **prod:** live mode (`sk_live_`/`pk_live_` — the backend refuses a test key in production). **webhook:** Developers → Webhooks → add `<API>/api/v1/billing/webhook` (setup prints both URLs and the events) → `whsec_…`. The publishable key also reaches the frontend as `VITE_STRIPE_PUBLISHABLE_KEY`. |
| **Google sign-in** | `OAUTH_GOOGLE_CLIENT_ID`, `OAUTH_GOOGLE_CLIENT_SECRET` | Google Cloud Console → Credentials → one Web OAuth client per environment; register the redirect URI setup prints (`OAUTH_GOOGLE_REDIRECT_URI` is derived — don't set it). |
| **GitHub sign-in (GitHub App)** | `OAUTH_GITHUB_CLIENT_ID` / `_CLIENT_SECRET` | Pasted at apply per environment (or the manifest flow creates the app once). |

## Neon projects

Each environment gets **its own Neon project** — separate storage, history and computes, so one
environment's data can never be branched into another. Every name derives from `project.name` and the
environment name in `setup.config.json` (never Neon's `main` / `neondb` / `neondb_owner`):

| | development | production |
| --- | --- | --- |
| Neon project | `<project>-development` | `<project>-production` |
| Branch (the only one, protected when the environment is `protected`) | `development` | `production` |
| Database | `<project_with_underscores>_development` | `<project_with_underscores>_production` |
| Database owner (setup's admin login) | `<database>_owner` | `<database>_owner` |
| History retention (`providers.neon.historyRetentionDays`) | 1 day | 7 days |

For `clinozy-be`: projects `clinozy-be-development` / `clinozy-be-production`, databases
`clinozy_be_development` / `clinozy_be_production`, owners `clinozy_be_development_owner` /
`clinozy_be_production_owner`. Setup adopts an existing project only when it already carries these
names; branch protection and the longer history need a paid Neon plan (a refused protection is a warning).

## Database users (Neon)

Setup creates the backend's hosted database users in each environment's project — **if a user already
exists and the password in `.env.<environment>` still logs in, it is left untouched**; a missing user
is created. If a user is **in use** but `.env.<environment>` has no working password for it, setup
stops rather than change it (that would lock out the deployed app) — restore the file, or re-run with
`--force` to set a new password. Setup never deletes users: an old one it no longer uses is reported
with the SQL to drop it. Migrations are **not** run here: the backend's deploy (GitHub Actions: migrate → seed →
deploy) runs them as the migrator — the first one included — and they tolerate the users setup
created first.

| Env var | User | Purpose |
| --- | --- | --- |
| `DATABASE_URL` (pooled) | `<project>_app` | runtime (API and workers) — row-level security applies |
| `DATABASE_MAINTENANCE_URL` (pooled) | `<project>_maintenance` | maintenance pool (retention/cleanup jobs) — row-level security applies |
| `DATABASE_MIGRATION_URL` (direct) | `<project>_migrator` | migrations, run by the deploy — `CREATEROLE BYPASSRLS`, full rights on the database and `public`, admin over the other backend roles |

Workers use the same users. Not hosted: `<project>_operator` (local/CI fixtures). The database owner
(`<database>_owner`) is only setup's admin connection for creating these users — it is never written to
an env file.

## What setup generates (outputs — do NOT hand-enter)

| Generated value | Comes from |
| --- | --- |
| `DATABASE_URL`, `DATABASE_MAINTENANCE_URL`, `DATABASE_MIGRATION_URL` | Neon — the database users above |
| `REDIS_URL` | Railway Redis provisioning |
| `S3_*` | AWS bucket + IAM user |
| `SENTRY_DSN` | Sentry backend project (`project.name`) create/adopt |
| `SENTRY_FRONTEND_DSN` | Sentry **frontend** project (`frontend.name`) — browser-safe, for clinozy-fe |
| `POSTHOG_KEY`, `POSTHOG_HOST` | One shared PostHog project per env (`<product>-<env>`), resolved from `POSTHOG_PERSONAL_API_KEY` |
| `CAPTCHA_SITE_KEY`, `CAPTCHA_SECRET` | One Turnstile widget per env (`<product>-<env>`), domains incl. the frontend origin |
| `RAILWAY_TOKEN` (per-env) | Minted from `RAILWAY_API_TOKEN` |
| `JWT_*`, `SECRETS_ENCRYPTION_KEY` | Generated locally |
| `REDIS_KEY_PREFIX`, `WEBAUTHN_RP_ID`, `WEBAUTHN_RP_NAME` | Derived from `setup.config.json` (product name, `frontend.url.<env>`) |
| `OAUTH_*_REDIRECT_URI`, `SCALAR_SLUG` | Derived by their providers from the SPA origin / project name |
| `RELEASE_PLEASE_TOKEN` (backend + frontend) | Your `GITHUB_TOKEN` — GitHub has no API to mint a personal token |
| `MONTHLY_DATABASE_RESTORE_DRILL_NEON_API_KEY` | Your `NEON_API_KEY` |
| `SENTRY_AUTH_TOKEN` (frontend, source maps) | Your `SENTRY_AUTH_TOKEN` |
| `NETLIFY_SITE_ID`, `NETLIFY_AUTH_TOKEN` (frontend) | The site found/created from the production frontend URL; the token from your Netlify CLI login |

## Shared vs per-codebase naming

`product.domain` (e.g. `clinozy.com`) is the single source of every public address:

| Environment | Frontend | API | CORS |
| --- | --- | --- | --- |
| production | `https://app.<domain>` (attached to the Netlify site) | `https://api.<domain>` (Railway custom domain) | the frontend |
| any other | `https://<env>--<frontend.name>.netlify.app` (Netlify alias) | `https://<env>--api.<domain>` (Railway custom domain) | the frontend |

Email is sent from `noreply@<domain>`; setup registers the domain with Resend. Turnstile widgets
allow both hosts. Each Railway, Netlify and Resend step prints the DNS records still to create, and
`pnpm setup:infra:next` re-checks them live. A Railway custom domain needs two: the CNAME to its
`*.up.railway.app` target and the `_railway-verify.<host>` TXT ownership record — Railway issues the
certificate only once both resolve. Setup also pins the API service's `PORT` to `app.port`, the port
both API domains route to (without it Railway injects 8080 and the domains answer 502). An
explicit `frontend.url.<env>` / `app.frontendUrl.<env>` / `app.allowedOrigins.<env>` /
`providers.resend.fromAddress` still wins over the derived value.

`setup.config.json` distinguishes three names: `project.name` (backend, e.g. `clinozy-be`), `frontend.name`
(frontend, e.g. `clinozy-fe`), and `product.name` (e.g. `clinozy`). Resources **shared** by both apps —
PostHog and Turnstile — are named `<product>-<env>` (`clinozy-development`, `clinozy-production`). Sentry is
**not** shared: the backend and frontend get separate projects (`clinozy-be`, `clinozy-fe`).

## Getting values back out

- **Full backend env (pasteable):** `pnpm setup:infra:output --environment <env> --copy-all` → clipboard.
- **Frontend (clinozy-fe) keys:** `pnpm setup:infra:export-env` writes them into `../clinozy-fe/.env.<environment>` (Vite names; browser-safe only). `pnpm setup:infra:frontend --environment <env> [--vite]` prints that bundle.

## Notes

- Run `pnpm setup:infra` — with **multiple environments**, account-level keys are collected first, then **all providers run for development**, then **all providers for production** (continue / skip / abort per environment). Every run ends with a numbered checklist of what is left (`pnpm setup:infra:next` re-prints it).
- **Logins**: `GITHUB_TOKEN` / `RAILWAY_API_TOKEN` in `.setup-credentials` stand in for `gh auth login` / `railway login`; Netlify always uses `npx netlify-cli login`.
- Reference (scripts, security, file map): [SETUP_INFRA_README.md](./SETUP_INFRA_README.md).
