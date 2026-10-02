# Setup / Infra (`tooling/setup`)

One declarative, config-driven engine provisions every third-party. There is **no**
per-provider script — all third-party setup flows through `pnpm setup:infra` and the
provider registry. It follows a plan → apply pattern (human-only, interactive).

| Concept            | Where it lives                                                              |
| ------------------ | -------------------------------------------------------------------------- |
| Declarative config | `tooling/setup/setup.config.json` (which providers + environments)         |
| State              | **Ephemeral — in-memory only** (`common/state.ts`); never written to disk  |
| Secret variables   | `.setup/.setup-credentials` (tokens; gitignored)                           |
| Secret template    | `.setup-credentials.example` (committed, at repo root next to `.env.example`) |
| Plan / apply       | `pnpm setup:infra:plan` / `pnpm setup:infra`                              |
| Providers          | `tooling/setup/infra/providers/setup-<key>/setup-<key>.provider.ts`        |

> **State is ephemeral.** There is **no `.setup-state.json`** — provisioned resource ids/urls
> and write-once secrets live only in an in-memory object for the lifetime of a single
> `pnpm setup:infra` run (provider → state → `.env.<environment>` writer, all in-process).
> The durable record is the `.env.<environment>` files plus each provider's own dashboard.
> Standalone commands hydrate state from **live remote** (each provider's `detectRemote`)
> when they need it.
>
> **Where setup files live.** The credentials file (`.setup/.setup-credentials`) and the
> clipboard-reveal audit log (`.setup/.setup-state.audit.log`) live in the gitignored
> **`.setup/`** directory, separate from the app's `.env.<environment>` config. The only
> committed, root-level setup file is the template `.setup-credentials.example` (next to
> `.env.example`). Copy it to `.setup/.setup-credentials` and fill it — or run
> `pnpm setup:infra:init`, which creates the directory and file for you.

To add a provider, see **[SETUP_INFRA_PROVIDER_TEMPLATE.md](./SETUP_INFRA_PROVIDER_TEMPLATE.md)**.

## Providers (registry)

Registered in [`infra/providers/index.ts`](./infra/providers/index.ts) — the orchestrator
iterates this list and treats each one uniformly (preview → settings-review →
detect-existing → interactive step → check → delete-instructions).

`neon` · `aws` · `sentry` · `jwt` · `resend` · `stripe` · `google-oauth` · `github-app-with-oauth` · `netlify` ·
`posthog` · `turnstile` · `railway` · `railway-redis` · `github` · `postman` · `scalar`

Enable/disable each in `setup.config.json` (`providers.<key>.enabled`). Fill its tokens in
`.setup/.setup-credentials` (run `pnpm setup:infra:preview` to see exactly which keys each needs).

## Quick start

```bash
pnpm setup:infra:init       # generate setup.config.json + .setup/.setup-credentials template (interactive)
# → fill tokens in .setup/.setup-credentials  (which keys + where: SETUP_INFRA_PREREQUISITES.md)
pnpm setup:infra:preview    # token checklist: providers, where to get each key
pnpm setup:infra:plan       # diff: what exists vs what will be created/updated (read-only)
pnpm setup:infra            # apply — shows the plan, then walks step-wise (interactive, human-only)
```

Run a **single** provider (replaces the old per-provider scripts):

```bash
pnpm setup:infra --providers posthog
pnpm setup:infra --providers turnstile,oauth,stripe
# or via env: SETUP_INFRA_PROVIDERS=neon,jwt,github   /   SETUP_INFRA_SKIP_PROVIDERS=postman
```

## Idempotent by default — present? update or skip; absent? create

Every provider step checks whether its resource (organization / project / environment-scoped
resource) already exists before doing anything:

- **Absent** → it is **created**.
- **Present** → setup prints `Already present — …` and **asks `(u)pdate / (s)kip`** (default **skip**). Skip keeps what's there; update re-runs the step.
- **Non-interactive** (`--yes` / CI) → existing resources are **always skipped** — setup never mutates existing infrastructure unprompted.

Detection uses the in-memory state for the current run (hydrated from live remote via each
provider's `detectRemote` during the pre-flight reconstruct); remote existence is also surfaced
in `setup:infra:preview` / `detectExisting()`. Validate-only providers (google-oauth, resend) create
nothing, so they simply re-validate each run. `github-app-with-oauth` creates a GitHub App (manifest
flow), `stripe` provisions the webhook (and can auto-create a dev sandbox), and `turnstile` creates a
widget — these provision real resources rather than only validating.

## All scripts

### Provision / inspect (`tooling/setup/setup.ts`)

| Script                       | Action                                                            |
| ---------------------------- | ---------------------------------------------------------------- |
| `setup:infra`                | Apply: show the plan, then provision step-wise (interactive). Add `--yes`/`-y` for non-interactive mode — auto-continues every step (skips on failure, no TTY required) after the settings review |
| `setup:infra:init`           | Interactive wizard → writes config + `.setup/.setup-credentials` template      |
| `setup:infra:preview`        | Token checklist: providers, token URLs, config keys (no writes) |
| `setup:infra:plan`           | Diff (config + in-memory state): CREATE / UP-TO-DATE / UPDATE / VALIDATE per provider (read-only). Pass `--remote`, or use `setup:infra:inspect`, for live truth |
| `setup:infra:inspect`        | Remote inspection: per provider, present/absent + config-vs-remote field diff (project/env/branch/region/org) |
| `setup:infra:output`         | Masked env inventory per environment — **secrets never printed** (`--copy <KEY>` copies one to the clipboard; `--environment <env>` to filter) |
| `setup:infra:reconstruct`    | Hydrate the in-memory state from live remote resources (pre-flight inside apply)          |
| `setup:infra:export-env`     | Regenerate `.env.<environment>` for clinozy-be **and** `../clinozy-fe/.env.<environment>` (browser-safe Vite keys) from state |

> The bare non-infra aliases (`setup:all`, `setup:provision`, `setup:init`, `setup:preview`, `setup:dry-run`, `setup:status`, `setup:reconstruct`) were removed — use the `setup:infra*` forms above. Raw flags still work: `tsx tooling/setup/setup.ts --output|--status|--dry-run|…`.

### Infra subcommands (`tooling/setup/setup.ts`)

| Script                  | Action                                                       |
| ----------------------- | ----------------------------------------------------------- |
| `setup:infra:check`     | Health-check provisioned providers                          |
| `setup:infra:status`    | Per-environment resource status (offline; from local state) |
| `setup:infra:delete`    | Print the **manual** delete guide (setup never deletes resources itself) |

### Env files

Writing `.env.<environment>` into clinozy-be **and** clinozy-fe (independent targets) is handled by
`setup:infra:export-env` (see the table above). The full `setup:infra` run also exports as a
finalize step, so there is no separate env command.

### GitHub repo / environment secrets (`tooling/setup/github/`)

| Script                  | Action                                                          |
| ----------------------- | -------------------------------------------------------------- |
| `setup:github` / `github:sync` | Scaffold repo, branches, rulesets, Environments; push `.env.<env>` |
| `setup:github:check`    | Consistency + remote drift (read-only)                         |
| `setup:github:dry-run` / `github:sync:dry-run` | Preview the sync                              |
| `setup:github:status`   | Repo / environment secret status                              |

### Domain & misc

| Script                                | Action                                            |
| ------------------------------------- | ------------------------------------------------- |
| `setup:domain` / `setup:infra:domain` | Attach a Railway custom domain (`railway/custom-domain.ts`) |
| `setup:retention-secrets` / `setup:push-retention-secrets` | Push retention worker secrets |
| `setup:local`                         | Local-only dev bootstrap (`tooling/dev/setup-local.ts`; not a third-party) |

## Security — secrets never leak (enforced)

Secrets are written to **`.env.<environment>` only** (via provisioning / `setup:infra:export-env`) and never printed to the terminal or committed. This is enforced, not just convention:

- **One home for secrets.** Secret values are only ever written to `.env.<environment>` (by provisioning / `setup:infra:export-env`). For normal setup you never copy/paste — values land in the env file automatically.
- **Never printed.** Providers log status only (`valid` / `resolved`), never a value. `setup:infra:output` shows a masked inventory (`••••`); no secret is ever written to stdout. Connection strings with embedded credentials (`DATABASE_URL`, `REDIS_URL`) are masked by value, not just key name.
- **Clipboard, not terminal.** Need one value elsewhere (e.g. a third-party dashboard)? `setup:infra:output --copy <KEY>` puts it on the **system clipboard** (auto-cleared after ~20s) and prints only a confirmation — it never enters the terminal or an agent transcript. Each copy is recorded to the gitignored `.setup/.setup-state.audit.log` (key + env + timestamp, never the value). No clipboard tool → it refuses and points you at `.env.<environment>`.
- **Unreadable by the agent.** The `guardrails.mjs` PreToolUse hook **denies the agent** Read/Bash access to `.env.<env>`, `.setup/.setup-credentials`, and any `.setup-state.*` file (templates `*.example` stay readable). So secrets are out of reach even though the files sit on disk.
- **Can't be committed.** `.env*` (except `*.example`) and `.setup-state.*` are gitignored; pre-commit runs **gitleaks `protect --staged`** plus a **"No secret/state files staged"** guard that blocks even `git add -f`. Both also run in CI.

> Note: state is **ephemeral (in-memory, never written to disk)** — there is no `.setup-state.json`. The only `.setup-state.*` file is the gitignored clipboard-reveal audit log (`.setup/.setup-state.audit.log`, key + env + timestamp, never values). The deny-read / gitignore / pre-commit guards still cover the whole `.setup-state.*` pattern defensively.

Every provider starts with a standard header (name · description · NAMING source · SECRETS rule). When adding a provider, follow the same header + rules — see the template's security section.

## File map

| Area                 | Files                                                            |
| -------------------- | --------------------------------------------------------------- |
| Config & init        | `common/config.ts`, `infra/init-wizard.ts`, `setup.config.json` |
| Secrets (`.setup/.setup-credentials`) | `common/secrets.ts`                                          |
| State                | `common/state.ts` (ephemeral in-memory singleton; no file on disk) |
| Secret output viewer | `infra/output.ts` + `common/clipboard.ts` (`setup:infra:output --copy`) |
| Agent deny-read      | `agent-os/hooks/guardrails.mjs` (blocks Read/Bash of secret files) |
| Orchestrator         | `infra/orchestrator.ts` (registry-driven)                      |
| Guide                | `infra/guide.ts`                                               |
| Prerequisites        | `infra/prerequisites.ts`                                       |
| Providers            | `infra/providers/setup-<key>/setup-<key>.provider.ts`, `infra/providers/index.ts` |
| Env-var emission     | `envs/build-env-vars.ts`                                       |
| Docs                 | `docs/deployment/setup/setup-token-instructions.md`           |

## Lift into a new product

This module is config-driven and standalone — to reuse it in another product:

1. Copy `tooling/setup/` into the new repo and add the `setup:infra*` scripts to its `package.json`.
2. Run `pnpm setup:infra:init` to generate that product's `setup.config.json` (its own
   organization / project / environment names — the single source of truth) and `.setup/.setup-credentials`.
3. Trim `setup.config.json` providers to the ones the product uses.

The provisioning **engine** (`common/`, `infra/`, `infra/providers/`) has no `@/` (app)
imports, so it ports cleanly. The tool does not read either product's `env-schema` — the env
schema is each project's own property. `clinozy-infra` only writes provisioned values into each
target's `.env.<environment>` (clinozy-be and clinozy-fe, treated as independent repos).

## See also

- **[SETUP_INFRA_PREREQUISITES.md](./SETUP_INFRA_PREREQUISITES.md)** — which credentials you must obtain per provider + where to get them.
- **[SETUP_INFRA_PROVIDER_TEMPLATE.md](./SETUP_INFRA_PROVIDER_TEMPLATE.md)** — add a new provider.
- `docs/deployment/setup/setup-token-instructions.md` — where to get each token.
- `.claude/skills/setup-infra-maintainer/SKILL.md` — the agent checklist (run when adding/removing a provider).
