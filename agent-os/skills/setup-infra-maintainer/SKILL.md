---
name: setup-infra-maintainer
description: Keeps setup:infra third-party providers and all dependent files in sync. Use when adding or removing any provider (Neon, Railway Redis, AWS, Sentry, GitHub, Railway, Postman, Stripe, Resend, OAuth, etc.).
---

# Setup infra maintainer (clinozy-be)

## Purpose

When you **add or remove a third-party provider** in the setup:infra flow (`pnpm setup:infra`, `setup:infra:init`, `setup:infra:preview`), **every dependent file** must be updated in the same change. This skill is the checklist so nothing is missed.

## When to Use

- **Adding** a new third-party (e.g. new provider for secrets, DB, queue, or deploy).
- **Removing** an existing third-party from setup.
- **Renaming** or **changing the shape** of a provider (new secret keys, new config fields).

## Source of truth (provider list)

Registered in `src/infra/providers/index.ts` (`INFRA_PROVIDERS`): **Neon**, **AWS**, **Sentry** (backend + frontend projects), **JWT**, **Resend**, **Stripe** (validates keys, provisions the webhook, auto-creates a dev sandbox via the CLI), **Google OAuth**, **GitHub App (sign-in)** (`github-app-with-oauth` — creates a GitHub App via the manifest flow), **PostHog** (one shared project per env, `<product>-<env>`), **Turnstile** (one widget per env, `<product>-<env>`), **Railway**, **Railway Redis**, **GitHub** (repo/env secrets), **Postman**, **Scalar**. Each appears in multiple places below; keep them in sync.

> **Quickest path to add one:** follow [`src/SETUP_INFRA_PROVIDER_TEMPLATE.md`](../../../src/SETUP_INFRA_PROVIDER_TEMPLATE.md) (10-step checklist + copy-paste `InfraProvider` skeleton). This skill is the exhaustive reference behind that template. Overview of the whole flow + all scripts: [`src/SETUP_INFRA_README.md`](../../../src/SETUP_INFRA_README.md).

## Naming — SINGLE SOURCE OF TRUTH (strict)

`src/setup.config.json` is the **one** place these names are defined. Every script and provider MUST read them from the loaded config — **never hardcode a literal**:

- `project.name` — PROJECT NAME · `project.displayName` — human-readable name · `project.organization` — ORGANIZATION NAME · `environments[].name` — ENVIRONMENT NAMES.

Alias maps (`dev→development`) only normalize input; the canonical value is still config. A default that duplicates a name (e.g. a hardcoded slug `'clinozy-be'`) is a violation — derive from `config.project.*` / `config.environments[]`. Only `init-wizard.ts` may hold seed defaults, because it *writes* the config. Add a `// NAMING (single source of truth = setup.config.json): …` comment in each script that touches org/project/env names.

## Secrets never leak (strict, enforced)

- **Never print a secret value.** Providers log status only (`valid`, `resolved`) — never a key/token/password/connection-string, including in error messages. A `logger.*` that interpolates a secret is a violation.
- **Secrets go to `.env.<environment>` only** (`build-env-vars.ts` → provisioning). `pnpm setup:infra:output` shows a masked inventory; `--copy <KEY>` puts one value on the **clipboard** (never stdout, auto-cleared, audit-logged). `infra/output.ts` masks by key pattern and by value (embedded-credential URLs like `DATABASE_URL`); `common/clipboard.ts` shells out to pbcopy/wl-copy/xclip/xsel/clip.
- **State is ephemeral (in-memory only)** — `common/state.ts` never writes a file; there is no `.setup-state.json`. Provisioned values flow provider → in-memory state → `.env.<environment>` within one run; standalone commands hydrate from live remote (`hydrateStateFromRemote`). **Agent deny-read:** `agent-os/hooks/guardrails.mjs` blocks the agent from Read/Bash-reading `.env.<env>` / `.setup/.setup-credentials` / any `.setup-state.*` file (matcher includes `Read` in `.claude/settings.json`).
- **Every provider starts with the common header** — name · description · NAMING (config only) · SECRETS rule. See the skeleton in `SETUP_INFRA_PROVIDER_TEMPLATE.md`.
- **Idempotent (present? update or skip · absent? create)** — resource-creating providers implement `alreadyDone()`/`alreadyDoneEnvironments()`; `runInteractiveStep` then prompts `(u)pdate / (s)kip` when present (default skip; auto-skip in `--yes`/CI) and creates when absent. Validate-only providers omit it.
- **Enforcement:** `.env*` (except `*.example`) + `.setup-state.*` gitignored; pre-commit runs gitleaks `protect --staged` + the "No secret/state files staged" guard (`src/scripts/tooling/run-pre-commit-guard.ts`); both run in CI. Never weaken these.

---

## Checklist: ADD a new third-party provider

Work through each section. Do not skip; missing any item will break init, preview, or provisioning.

### 1. Config schema and init defaults

- **`src/common/config.ts`** — In `setupConfigSchema.providers`, add the new provider object (e.g. `enabled: z.boolean()`, plus any provider-specific fields: region, repository, fromAddress, etc.). Match the shape used in orchestrator and providers.
- **`src/infra/init-wizard.ts`** — In `buildConfig()`, add the new provider under `config.providers` with sensible defaults (e.g. `newProvider: { enabled: true, ... }`).

### 2. Secrets (env-style .setup/.setup-credentials)

- **`src/common/secrets.ts`** — In `setupSecretsSchema`, add the new provider’s secret shape (e.g. `newProvider: z.object({ apiKey: z.string() })`). Also update `loadSecretsFromEnv` to read the new key(s) and include them in the returned `SetupSecrets` object; update `hasAnyEnvSecret` if the new secrets should count toward “any secret filled”.
- **`src/common/secrets.ts`** (env-secrets / `.setup/.setup-credentials` template logic):
  - **`TOKEN_URLS`** — Add `NEW_PROVIDER_API_KEY: ‘https://...’` (URL where user gets the key).
  - **`SIMPLE_VARS`** — If the provider uses a single env var (or a fixed set), add `[‘NEW_PROVIDER_API_KEY’, TOKEN_URLS.NEW_PROVIDER_API_KEY]` so the template and `appendMissingEnvSetupVariables` include it.
  - **`buildEnvSetupTemplateContent`** — If the provider uses more than the simple vars (e.g. per-env keys), add the corresponding blocks (comments + `KEY=` lines) after the existing loops.
  - **`appendMissingEnvSetupVariables`** — Already uses `SIMPLE_VARS`; if the new provider needs per-env vars, add a loop similar to Stripe (check existing keys, append missing blocks).

### 3. Orchestrator (registry-driven — DO NOT EDIT)

`src/infra/orchestrator.ts` iterates `INFRA_PROVIDERS` and calls each provider's
interface hooks uniformly — there are **no** hardcoded `PREVIEW_PROVIDERS` /
`displaySettingsReview` lists, and **no** rollback/destroy. You add behaviour by
implementing hooks on your `InfraProvider` (step 6), not by editing the orchestrator:

- **`preview(context)`** → returns `{ detail, url, configKey }` (shown in `setup:infra:preview`).
- **`settingsReview(context)`** → returns settings-review entries.
- **`detectExisting(context)`** → optional pre-existence detection.
- **`buildStep(context)`** → the interactive provision step (calls `provision`, then `context.applyStateUpdates(result.stateUpdates ?? {})` for state-backed providers).
- **`check(context)`** → health check for `setup:infra:check`.
- **`deleteInstructions(context)`** → for any provider that provisions tracked resources (records `stateUpdates` on the in-memory run state), return `{ provider, dashboardUrl, steps?, resources: [{ label, identifier }] }` (rendered by `pnpm setup:infra --delete`). Never add `destroy`/`destroyEnvironment` — `setup:infra` does not delete resources or roll back; failures stop the run and the user cleans up via the printed guide.

### 4. Guide (browser + instructions)

- **`src/infra/guide.ts`** — In `buildGuideSteps()`, add a new step:
  - `providerName`: display name (e.g. “NewProvider”).
  - `enabledCheck`: `(config) => config.providers.newProvider.enabled`.
  - `secretsCheck`: function that returns true when the new provider’s secrets are filled in `secrets`.
  - `browserUrls`: one or more URLs for the user to get the token.
  - `instructions`: array of short steps (log in, create key, copy, set in `.setup/.setup-credentials` as `KEY=...`, save).

### 5. Prerequisites (CLI / token)

- **`src/infra/prerequisites.ts`** — If the new provider requires a CLI or token to be present:
  - Add an entry to `PREREQUISITES`: `command`, `versionFlag`, `enabledCheck` for the provider, and optionally `authCheck` and/or `tokenEnvKey` (e.g. `NEW_PROVIDER_TOKEN`) so token-based auth is supported without login.

### 6. Provider module (provision / check / deleteInstructions)

- **`src/infra/providers/setup-<name>/setup-<name>.provider.ts`** — Create (or update) the provider module. Use `@src/...` imports (no parent-relative `../`). Export at least:
  - `provision(config, secrets, state, environments): Promise<ProviderResult>`.
  - `check(state, secrets?, ...): Promise<boolean>` if the provider is health-checked.
  - On the exported `InfraProvider`: implement `deleteInstructions(context)` whenever the provider provisions tracked resources (records `stateUpdates`), returning the dashboard URL plus the identifiers the user must delete by hand. Never add `destroy` / `destroyEnvironment` — `setup:infra` does not delete resources.
- **`src/infra/providers/index.ts`** — Add the new provider to `INFRA_PROVIDERS` (order matters).

### 7. State shape (for resources that persist)

- **`src/common/state.ts`** — In `setupStateSchema`, add an optional key for the new provider (e.g. `newProvider: z.object({ projectId: z.string(), ... }).optional()`). Update `SetupState` type if needed (usually inferred from schema).
- **`src/common/types.ts`** — Only if you add new top-level types for the provider; usually state is enough.

### 8. Runtime env emission (`.env.<environment>` + GitHub env secrets)

- **On YOUR provider — implement `toEnvironmentVariables(context, environmentName)`** returning a `Partial<EnvironmentVariables>` (the keys your provider contributes; declare each key on the `EnvironmentVariables` type in `src/common/types.ts`). clinozy-infra does NOT read or own any env schema — validating those keys is each consuming project's concern. **Do NOT edit `build-env-vars.ts`** — it composes every provider's slice by iterating `INFRA_PROVIDERS`. Validation providers (`createValidationProvider`) pass `toEnvironmentVariables` through the spec (see Resend). Stripe / OAuth emit nothing via the hook — their per-env values are user-entered (or, for Stripe dev, auto-created via the CLI) and written straight to the env file with `upsertEnvFileValue`; Turnstile, Postman, and the GitHub App likewise upsert their provisioned values directly. Those file-written keys are surfaced by `resolveEnvironmentVariables` (the `.env` overlay), not by `buildEnvironmentVariables` alone.

### 9. Documentation

- **`docs/deployment/setup/setup-token-instructions.md`**:
  - **Per-provider token instructions** table — Add row: Provider name, “Where to get token” (URL), “Variable in .setup/.setup-credentials”.
  - **Env-style (.setup/.setup-credentials) variable names** table — Add row: variable name(s), purpose.
  - If the provider is important for automation (like GITHUB_TOKEN), add or extend a **step-by-step** section with URL, scopes, and “set in .setup/.setup-credentials”.
- Run **docs-maintainer** if you added or moved docs; ensure `docs/README.md` still lists setup docs correctly.

### 10. Verify

- Run **`pnpm setup:infra:init`** (defaults should include the new provider if enabled by default).
- Run **`pnpm setup:infra:preview`** — new provider should appear in the list with correct URL and config key.
- Run **`pnpm typecheck`** and fix any type errors.
- Optionally run **`pnpm setup:infra`** in a test repo to confirm provisioning (or at least that the flow reaches the new step without error).

---

## Checklist: REMOVE a third-party provider

Reverse the steps above; remove or disable the provider everywhere.

1. **`src/common/config.ts`** — Remove (or deprecate) the provider from `setupConfigSchema.providers`. If you keep the key for backward compatibility, set a default `enabled: false` and document deprecation.
2. **`src/infra/init-wizard.ts`** — Remove or set `enabled: false` in `buildConfig()` for the provider. Remove the associated env-secrets entries (`TOKEN_URLS`, `SIMPLE_VARS`, `buildEnvSetupTemplateContent`, `appendMissingEnvSetupVariables`) from `src/common/secrets.ts`.
3. **`src/common/secrets.ts`** — Remove from `setupSecretsSchema` (or make optional and stop using). Also remove from `loadSecretsFromEnv` and `hasAnyEnvSecret`.
4. **`src/infra/orchestrator.ts`** — Remove from any provider-specific summary lines in `runStatus`, env-state helpers, and the per-provider blocks in the post-provision summary. The provider’s `deleteInstructions` hook is removed automatically when its module is deleted.
5. **`src/infra/guide.ts`** — Remove the corresponding step from `buildGuideSteps()`.
6. **`src/infra/prerequisites.ts`** — Remove the prerequisite entry for that provider’s CLI/token.
7. **`src/infra/providers/<name>.provider.ts`** — Delete the file and remove its import/usages from the orchestrator.
8. **`src/common/state.ts`** — Remove the provider’s key from `setupStateSchema` (or leave optional and unused).
9. **`src/envs/build-env-vars.ts`** — Nothing to do: the provider's `toEnvironmentVariables()` is deleted with its module, and the composer iterates the registry. (Do not add per-provider mappings here.)
10. **`docs/deployment/setup/setup-token-instructions.md`** — Remove the provider from the per-provider table and env-style table; trim step-by-step section if it was the only one.
11. Run **`pnpm typecheck`** and **`pnpm setup:infra:preview`** to confirm nothing references the removed provider.

---

## File map (quick reference)

| Area                 | Files                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------- |
| Config & init        | `src/common/config.ts`, `src/infra/init-wizard.ts`                   |
| Secrets & .setup/.setup-credentials | `src/common/secrets.ts` (schema + load + hasAny + TOKEN_URLS/SIMPLE_VARS + template) |
| Orchestrator         | `src/infra/orchestrator.ts`                                                     |
| Guide                | `src/infra/guide.ts`                                                            |
| Prerequisites        | `src/infra/prerequisites.ts`                                                    |
| Providers            | `src/infra/providers/*.provider.ts`                                             |
| State & types        | `src/common/state.ts`, `src/common/types.ts`                         |
| Env emission         | per provider: `toEnvironmentVariables()`; composed by `src/envs/build-env-vars.ts` |
| Docs                 | `docs/deployment/setup/setup-token-instructions.md`                                       |

---

## See also

- **setup-token-instructions.md** — User-facing token URLs and variable names.
- **skill-index** — Invoke this skill when you add/remove a third-party in setup:infra; invoke **docs-maintainer** if you add or move setup-related docs.
