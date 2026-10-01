# envforge convergence

clinozy-infra now embeds the **envforge** generic provisioning engine. This note records
what was vendored, the intended end state, and the split of what would move upstream vs.
what stays in clinozy-infra forever.

Reference implementation (read-only): `~/random-projects/envforge-env-provisioner`
(relative to this repo: `../../../random-projects/envforge-env-provisioner`).

## What happened

envforge is a ~1,700-LOC generic engine: a new service is ~20 lines of preset *data*
over five generic providers, instead of a bespoke provider *class*. clinozy-infra was the
inverse — deep but bespoke (per-service providers, rich lifecycle, audit, dual-target).
We ported envforge's engine, preset model, and surgical `.env` writer into clinozy-infra
while keeping everything clinozy-infra does better.

- **Task 1** vendored the engine into `src/engine/` (5 generic providers — `httpApi`,
  `manual`, `generate`, `static`/`mock`, plus a clinozy-infra-added `command` — the
  `ctx.get()` chaining loop, registry, ephemeral state). Logging routes through
  `src/common/logger.ts`; every provisioned key is recorded in `.setup-audit.log`
  (envforge has neither audit nor tests — we added both).
- **Task 2** replaced template-merge env writing with envforge's surgical `upsertEnv`
  (multi-line/PEM-aware), applied to both targets.
- **Task 3** introduced the preset model (`src/presets/`): `validate` / `guide` presets
  replace bespoke validate/guide providers outright; `managed` presets wrap the retained
  API-orchestrating providers (the "client libs") plus declarative outputs.
- **Task 4** made the orchestrator read `infra.config.ts` (resources) instead of a
  hardwired list; identity stays in `setup.config.json`.

## Intended end state

envforge is published as a package; clinozy-infra depends on it and deletes its vendored
copy. Until then the two copies must not silently diverge — changes to the engine here
should be mirrored upstream (or, once packaged, made upstream-first).

## Split: upstream vs. stays here

### Would move upstream (into the envforge package)

- The engine core: `src/engine/engine.ts`, `env-file.ts`, `registry.ts`, `state.ts`,
  `types.ts` (`defineConfig`, `Provider`, `ProvisionContext`, `ctx.get()` chaining).
- The generic providers: `httpApi`, `manual`, `generate`, `static`/`mock`, and the
  clinozy-infra-added `command` provider (generally useful).
- Prompt/UX utilities: the TTY (masked) / piped `Prompter` (`src/engine/prompt.ts`), and
  the CLI UX helpers Task 5 adds (init wizard, status matrix, doctor, example generator).
- The KeyStash vault integration (Task 6), config-gated.

### Stays in clinozy-infra forever

- The lifecycle verbs and their orchestration: `plan`, `preview`, `inspect`, `check`,
  `status`, `delete`, `reconstruct`, `export-env` (`src/infra/`, `src/setup.ts`).
- The audit log (`.setup-audit.log`) and the ephemeral-state / remote-hydration model
  (`--reconstruct` / `--inspect`), which are clinozy-infra's discipline, not envforge's.
- Dual-target resolution (`CLINOZY_BE_DIR` / `CLINOZY_FE_DIR`, loud failure) — `src/common/paths.ts`.
- The GitHub environments/secrets sync and Railway deploy + custom-domain subsystems
  (`src/github/`, `src/railway/`) — deploy/DNS/rulesets, not env-var provisioning.
- The core presets themselves (`src/presets/*`, `managed.presets.ts`) and
  `infra.config.ts` — these describe *this* product's services and identity.
- Retention secrets and the credentials store (`.setup/.setup-credentials`).

## Why some providers are "managed" wrappers, not thin data

The heavy providers (Neon, Railway, AWS, Sentry, PostHog, Turnstile, Postman, Scalar,
GitHub) call live APIs and implement `inspectRemote` (drift), `check` (health),
`deleteInstructions`, and `detectRemote` (reconstruct) — the exact behavior the keep-list
forbids regressing. Their "preset" is a thin catalog entry (`managed` kind) that wraps the
retained client-lib implementation and declares outputs. Splitting API calls from wiring
per-provider (to shrink them further) is deferred until it can be done with integration
testing against the real APIs.
