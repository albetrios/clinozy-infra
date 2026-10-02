---
name: setup-infra-maintainer
description: Keeps setup:infra third-party providers and all dependent files in sync. Use when adding, removing or reshaping any provider (Neon, AWS, Sentry, JWT, Resend, Stripe, Google OAuth, GitHub App, Netlify, PostHog, Turnstile, Railway, Railway Redis, GitHub, Postman, Scalar).
---

# Setup infra maintainer (clinozy-infra)

## Purpose

When you **add, remove or reshape a provider** in `pnpm setup:infra`, every dependent file must change
in the same commit. This is the checklist. Short version + skeleton:
[`docs/SETUP_INFRA_PROVIDER_TEMPLATE.md`](../../../docs/SETUP_INFRA_PROVIDER_TEMPLATE.md). The whole
flow, scripts and file map: [`docs/SETUP_INFRA_README.md`](../../../docs/SETUP_INFRA_README.md).
Presets (the preferred way to declare a service): the `preset-author` skill.

## Source of truth

- **Provider list:** `infra.config.ts` → `resources` (ordered presets), resolved by
  `src/infra/providers/index.ts` → `getInfraProviders()`. Current keys: `neon` · `aws` · `sentry` ·
  `jwt` · `resend` · `stripe` · `google-oauth` · `github-app-with-oauth` · `netlify` · `posthog` ·
  `turnstile` · `railway` · `railway-redis` · `github` · `postman` · `scalar`.
- **Names:** `setup.config.json` — `project.*`, `product.name`, `product.domain`, `frontend.name`,
  `environments[]`. Never hard-code a name or host; derive it (`src/envs/env-file-setup.util.ts` derives
  every public host from `product.domain`). Only `src/infra/init-wizard.ts` holds seed defaults. Add a
  `// NAMING (single source of truth = setup.config.json): …` comment where a script uses names.

## Secrets never leak

- **Never print a secret value** — status only, also in errors. HTTP goes through `setupFetch`
  (`src/common/setup-fetch.ts`), which redacts credentials from thrown messages.
- **Outputs go to the apps' `.env.<environment>` only**, composed from each provider's
  `toEnvironmentVariables()` by `src/envs/build-env-vars.ts` and written by `src/envs/export-env-files.ts`
  (surgical upsert; retired keys removed). `setup:infra:output` masks; `--copy <KEY>` uses the clipboard.
- **Inputs live in `.setup/.setup-credentials`** (gitignored, `0600`): account tokens as plain keys,
  per-environment app secrets as `KEY__<environment>`. The guide asks once for missing values.
- **State is ephemeral** (`src/common/state.ts`, in-memory). Don't add a state file.
- **CI runs on every pull request and `main` is protected** (squash-only, CI `checks` must pass —
  `.github/rulesets/main.json`). There is no pre-commit secret scan — never force-add `.setup/` or `.env.*`.

## Checklist: ADD a provider

1. **Config** — `src/common/config.ts` (`setupConfigSchema.providers.<key>`), `src/infra/init-wizard.ts`
   (`buildConfig()` default), `setup.config.json` (ship `enabled: false` unless it should run).
2. **Credentials** — `src/common/secrets.ts`:
   - schema (`setupSecretsSchema`) + mapping in `loadSecretsFromEnv`;
   - `TOKEN_URLS` (the link the guide shows) + `SIMPLE_VARS` (template/append) for account tokens;
   - `PER_ENVIRONMENT_VARS` for per-environment values no API can create (as `KEY__<environment>`).
3. **Guide** — `src/infra/guide.ts` → `buildGuideSteps()`: `providerName`, `enabledCheck`, `configured`,
   `prompts` (`{ key, label }`, a few words). The link comes from `TOKEN_URLS` or the step's `url`;
   `src/tests/unit/setup/presets.unit.test.ts` fails if a prompt has none.
4. **State** — `src/common/state.ts`, only if `provision` resolves a value read later.
5. **Provider** — `src/infra/providers/setup-<key>/setup-<key>.provider.ts` with the standard header;
   implement `toEnvironmentVariables` (declare keys on `EnvironmentVariables` in `src/common/types.ts`),
   `alreadyDone()` for resource-creating steps, `deleteInstructions` when it tracks resources. Never a
   `destroy`. A provider that needs DNS records calls `requireDnsRecord` (`src/common/dns-requirements.ts`).
6. **Preset + composition** — wrap it in `src/presets/` (usually `managed.presets.ts`), export it from
   `src/presets/index.ts`, add it to `resources` in `infra.config.ts` (order = run order).
7. **Prerequisites** — `src/infra/prerequisites.ts`: a `PREREQUISITES` entry if it needs a CLI, a `LOGINS`
   entry if it needs a login (token in `.setup-credentials` or a CLI login).
8. **Checklist** — `src/infra/next-steps.ts`, only if it leaves a manual follow-up.
9. **Docs** — `docs/SETUP_INFRA_PREREQUISITES.md` (credential + output tables) and the provider list in
   `docs/SETUP_INFRA_README.md` (`src/tests/unit/setup/provider-docs-sync.unit.test.ts` fails if the key is missing).
10. **Verify** — `pnpm health`, `pnpm setup:infra:preview`, `pnpm setup:infra --providers <key>`.

## Checklist: REMOVE a provider

Reverse the above in one change: drop it from `infra.config.ts` and `src/presets/`, delete the provider
folder, remove its config schema/default/`setup.config.json` entry, its `secrets.ts` entries
(`setupSecretsSchema`, `loadSecretsFromEnv`, `TOKEN_URLS`, `SIMPLE_VARS`, `PER_ENVIRONMENT_VARS`), its guide
step, state key, prerequisite and checklist step, and its rows in both docs. If it wrote env keys the apps
no longer use, add them to the retired-key lists in `src/envs/export-env-files.ts` /
`src/envs/frontend-env-keys.ts` so existing env files are cleaned. `pnpm health` must pass.

## File map

| Area | Files |
| --- | --- |
| Config & init | `src/common/config.ts`, `src/infra/init-wizard.ts`, `setup.config.json` |
| Credentials | `src/common/secrets.ts` |
| Guide · checklist | `src/infra/guide.ts` · `src/infra/next-steps.ts` |
| Orchestrator (don't edit for a provider) | `src/infra/orchestrator.ts` |
| Prerequisites | `src/infra/prerequisites.ts` |
| Providers · presets · composition | `src/infra/providers/setup-<key>/`, `src/presets/`, `infra.config.ts` |
| State & types | `src/common/state.ts`, `src/common/types.ts` |
| Env emission | provider `toEnvironmentVariables()` → `src/envs/build-env-vars.ts` → `src/envs/export-env-files.ts` |
| Docs | `docs/SETUP_INFRA_PREREQUISITES.md`, `docs/SETUP_INFRA_README.md`, `docs/SETUP_INFRA_PROVIDER_TEMPLATE.md` |
