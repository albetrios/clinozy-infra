# Setup / Infra — reference

One command, `pnpm setup:infra`, provisions every third-party service for the backend
(`../clinozy-be`) and the frontend (`../clinozy-fe`) and writes each app's `.env.<environment>`.
There is no per-provider script: every service is a preset run by the same engine, plan → apply,
interactive by default (`--yes` for an unattended run).

## How a run works

```
 1. Identity review      setup.config.json — names, environments, product.domain
 2. Prerequisites        1/4 tools · 2/4 logins (GitHub, Railway, Netlify) · 3/4 config + repos
                         · 4/4 credentials — also on its own: pnpm setup:infra:prereqs
 3. Credentials          asks once for each value missing from .setup/.setup-credentials
                         (one line with its link, hidden input) and saves it there
 4. Settings review      what will be created / validated → confirm
 5. Pre-flight           adopts what already exists remotely (nothing is recreated)
 6. Provisioning         every provider for development, then for production
 7. Finalize             writes ../clinozy-be/.env.<env> and ../clinozy-fe/.env.<env>
                         (only provisioned keys; other keys untouched; retired keys removed)
 8. Summary + checklist  numbered "Next steps" with live checks — `pnpm setup:infra:next` re-prints it
 9. Ship (separately)    `pnpm setup:infra:deploy [--production]` — attestations switch, failed
                         post-merge CI re-run, re-deploy a release to production
```

| What | Where |
| --- | --- |
| Identity (names, environments, `product.domain`, which providers are on) | `setup.config.json` |
| Resources (ordered list of presets) | `infra.config.ts` |
| Your credentials (tokens; per-environment Stripe/Google as `KEY__<environment>`) | `.setup/.setup-credentials` — gitignored, `0600`, created on the first run |
| State | **In memory only** for one run (`src/common/state.ts`); standalone commands re-read it from the providers |
| Outputs | each app's `.env.<environment>` |
| Checklist DNS records (public values) | `.setup/next-steps.json` |
| Clipboard-copy audit (key + env + time, never values) | `.setup/.setup-state.audit.log` |

What you must provide, the database users, and the derived hosts:
**[SETUP_INFRA_PREREQUISITES.md](./SETUP_INFRA_PREREQUISITES.md)**.

## Providers (registry)

Composed in [`infra.config.ts`](../infra.config.ts) and resolved by
[`src/infra/providers/index.ts`](../src/infra/providers/index.ts); the orchestrator treats each one
uniformly (preview → settings review → detect existing → interactive step → check → delete guide).

`neon` · `aws` · `sentry` · `jwt` · `resend` · `stripe` · `google-oauth` · `github-app-with-oauth` · `netlify` ·
`posthog` · `turnstile` · `railway` · `railway-redis` · `github` · `postman` · `scalar`

Turn each on or off in `setup.config.json` (`providers.<key>.enabled`).

## Quick start

```bash
pnpm setup:infra:init       # first time: write setup.config.json (interactive)
pnpm setup:infra:plan       # read-only: what exists vs what would be created
pnpm setup:infra            # apply — asks for missing credentials, then provisions step by step
pnpm setup:infra:next       # re-print the "Next steps" checklist (no provisioning)
```

Scope a run to some providers:

```bash
pnpm setup:infra --providers neon,stripe          # or -r neon,stripe
SETUP_INFRA_PROVIDERS=neon pnpm setup:infra --yes  # SETUP_INFRA_SKIP_PROVIDERS=postman skips instead
```

## Idempotent by default

Every step checks what already exists before acting:

- **Absent** → created.
- **Present** → `Already present — …`, then `(u)pdate / (s)kip` (default skip). Under `--yes` existing
  resources are always skipped — setup never changes existing infrastructure unprompted.
- **Neon database users** follow the same rule per user: kept when the saved password still logs in;
  otherwise created or given a login. A user that is in use is never given a new password without
  `--force`, and old users are reported with the SQL to drop them — never deleted.

Guide providers (`stripe`, `google-oauth`) and validate providers (`resend`) create nothing — they
collect or check values each run. `github` creates any missing GitHub Environment in both app repos
(never touching an existing one; branches and rulesets stay with each app's own `github:sync`),
`github-app-with-oauth` creates a GitHub App (manifest flow), `turnstile` creates a widget per
environment, `netlify` finds or creates the frontend site.

## Scripts

| Script | Action |
| --- | --- |
| `setup:infra` | Apply. `--yes`/`-y` = unattended (never prompts); `--force` re-collects values that are already set and allows re-keying a database user that is in use |
| `setup:infra:init` | Interactive wizard → `setup.config.json` (and the credentials template) |
| `setup:infra:plan` | Read-only diff per provider; `--remote` (or `setup:infra:inspect`) for live truth |
| `setup:infra:inspect` | Live remote inspection: present/absent + config-vs-remote field diff |
| `setup:infra:preview` | Token checklist: providers, where to get each key (no writes) |
| `setup:infra:next` | The "Next steps" checklist with live checks (DNS, GitHub secrets, DB users, …) |
| `setup:infra:deploy` | Ship both apps: `ARTIFACT_ATTESTATIONS` from the plan, re-run the failed post-merge CI on `main`; `--production` re-deploys each latest release from `main` — publishing a release already deploys it (`--app`, `--tag`, `--yes`). Steps: [README → Go live](../README.md#go-live--step-by-step) |
| `setup:infra:prereqs` | The prerequisites check on its own: tools, logins, config, credentials |
| `setup:infra:doctor` | Config footguns (missing domain, wrong URLs, …) |
| `setup:infra:check` / `setup:infra:status` | Health check / per-environment status matrix |
| `setup:infra:output` | Masked env inventory; `--copy <KEY>` puts one value on the clipboard |
| `setup:infra:export-env` / `:export-env:fe` | Re-write the apps' `.env.<environment>` from live state |
| `setup:infra:reconstruct` | Rebuild in-memory state from the providers (runs inside apply too) |
| `setup:infra:guide` | Generate `setup-guide.html` (gitignored) — a browser view of the catalog with live status |
| `setup:infra:example` · `setup:infra:vault` | Print a generated `.env.example` · mirror into KeyStash (off by default) |
| `setup:infra:delete` | Print the **manual** delete guide — setup never deletes resources |
| `setup:github` / `github:sync` (`:check`, `:dry-run`, `:status`) | Backend repo only (from `providers.github.repository`): branches, rulesets, Environments; push `.env.<env>`. Prefer each app's own `pnpm github:sync`, which the checklist uses |
| `github:rulesets:self` (`:check`) | This repo's own `main` protection from `.github/rulesets/main.json` — the apps' rules (no deletion or force-push, linear history, squash-only pull requests) with this repo's CI job `checks` required |
| `setup:domain` | Attach a Railway custom domain by hand (`src/railway/custom-domain.ts`) |
| `rebrand` · `validate:identity` · `identity:sync` | Rename the product / check identity drift (see [README](../README.md)) |
| `health` | Lint, typecheck, tests, identity — every phase, one summary |

## Security — how secrets are kept safe

- **Never printed.** Providers log status only (`valid`, `created`, `left unchanged`); errors are
  redacted (`redactSecrets` in `src/common/setup-fetch.ts`); `setup:infra:output` masks values, and
  connection strings are masked by value, not only by key name.
- **Clipboard, not terminal.** `setup:infra:output --copy <KEY>` copies one value, auto-clears it
  after 30 s (`--clear <seconds>`), and records the copy in the audit log — key, env, time, never the
  value.
- **Files.** `.setup/` and `.env.*` (except `*.example`) are gitignored; credential files are written
  owner-only (`0600`). Database users are created by SQL as the provider's owner (never Neon's REST
  API, which grants BYPASSRLS), and runtime users are checked to stay subject to row-level security.
- **CI and branch protection.** `.github/workflows/ci.yml` runs lint, typecheck and tests on every pull
  request, and `main` only accepts squash-merged pull requests that pass it (`.github/rulesets/main.json`,
  applied by `pnpm github:rulesets:self`). **Not in this repo yet:** a pre-commit secret scan — run
  `pnpm health` before pushing, and never `git add -f` anything under `.setup/`.

Every provider starts with the standard header (name · description · NAMING source · SECRETS rule) —
see [SETUP_INFRA_PROVIDER_TEMPLATE.md](./SETUP_INFRA_PROVIDER_TEMPLATE.md).

## Architecture and file map

```
 setup.config.json (identity) ─┐
 infra.config.ts (resources) ──┼─► orchestrator ─► providers (presets) ─► in-memory state ─► .env writers
 .setup/.setup-credentials ────┘        │                                                  ├─► ../clinozy-be/.env.<env>
                                        └─► next steps (live checks)                       └─► ../clinozy-fe/.env.<env>
```

Preset kinds (`src/presets/types.ts`): **validate** (check a pasted credential — Resend), **guide**
(dashboard walkthrough + per-environment values — Stripe, Google), **managed** (a thin preset over a
retained API client — Neon, AWS, Railway, Sentry, …). Authoring rules: the `preset-author` skill.

| Area | Files |
| --- | --- |
| Entry point + flags | `src/setup.ts` |
| Orchestrator, guide, checklist, deploy | `src/infra/orchestrator.ts`, `src/infra/guide.ts`, `src/infra/next-steps.ts`, `src/infra/deploy.ts` |
| Config + init | `src/common/config.ts` (setup.config.json schema), `src/infra/init-wizard.ts`, `src/infra/infra-config.ts` (`defineInfraConfig`) |
| Credentials | `src/common/secrets.ts` (template, per-environment keys, `TOKEN_URLS`) |
| State | `src/common/state.ts` |
| Presets | `src/presets/` (`types.ts`, `managed.presets.ts`, `*.preset.ts`, `lint.ts`) |
| Providers (API clients) | `src/infra/providers/setup-<key>/setup-<key>.provider.ts` |
| Engine (vendored from envforge) | `src/engine/` — generic providers, surgical `.env` upsert |
| Env writers | `src/envs/` (`build-env-vars.ts`, `export-env-files.ts`, `frontend-env-keys.ts`) |
| Derived hosts (`product.domain`) | `src/envs/env-file-setup.util.ts` |
| DNS records reported by providers | `src/common/dns-requirements.ts` |
| Prerequisites | `src/infra/prerequisites.ts` |
| Output / clipboard | `src/infra/output.ts`, `src/common/clipboard.ts` |
| GitHub | `src/github/` · Railway API: `src/railway/` · Identity / rebrand: `src/identity/` |
| Browser guide | `src/infra/setup-guide/` |
| Tests | `src/tests/unit/**` |

## Decisions (settled)

- **State is ephemeral** — no state file; standalone commands re-read from the providers.
- **Every service is a preset**; heavy ones keep their API client behind a thin `managed` preset.
- **`.env.example` seeds a first-run env file only** — existing files are upserted, never regenerated.
- **Secrets: never printed; copy-only with auto-clear.** No output mode dumps values.
- **Everything is derived from config** (`setup.config.json` + `infra.config.ts`) — names and hosts are
  never hard-coded.
- **Migrations run in the backend's deploy**, never in setup.

## Known limitations

- `JWT_SECRET` and each environment's `RAILWAY_TOKEN` are minted fresh on every full run — run each
  app's `pnpm github:sync` afterwards so GitHub/Railway match.
- Neither GitHub (a GitHub App's callback URLs) nor Google (OAuth redirect URIs) has an API for
  registering them — the checklist prints the exact URLs to add by hand.
- A database first migrated by a different user than `<project>_migrator` keeps that user's default
  privileges (the backend's own local setup behaves the same way).

## Reuse in another product

The tool is standalone (no imports from the apps). Copy the repo, point it at your apps
(`CLINOZY_BE_DIR` / `target.path`, `CLINOZY_FE_DIR` / `frontend.path`), run `pnpm rebrand "<Product>"`,
then `pnpm setup:infra:init` and trim the providers in `setup.config.json`. The tool never reads either
app's env schema — it only writes provisioned values into their `.env.<environment>`.

## See also

- **[SETUP_INFRA_PREREQUISITES.md](./SETUP_INFRA_PREREQUISITES.md)** — what to provide, database users, hosts.
- **[SETUP_INFRA_PROVIDER_TEMPLATE.md](./SETUP_INFRA_PROVIDER_TEMPLATE.md)** — add a provider.
- **[envforge-convergence.md](./envforge-convergence.md)** — why the engine is vendored.
- Agent skills: `.claude/skills/setup-infra-maintainer`, `.claude/skills/preset-author`.
