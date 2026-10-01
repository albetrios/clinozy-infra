---
name: preset-author
description: Author or modify a clinozy-infra provisioning preset (src/presets/). Use when adding, converting, or changing a setup:infra service now that services are declared as presets over generic providers. Complements setup-infra-maintainer (the file-sync checklist).
---

# Preset author (clinozy-infra)

## Purpose

Services in `setup:infra` are declared as **presets** — data over a small set of
generic providers — and composed in `infra.config.ts`. This skill is how you author a
new preset (or convert a bespoke provider), what the generic providers are, and what
the tests expect. For the broader file-sync checklist (config schema, secrets,
prerequisites, docs), still follow [`setup-infra-maintainer`](../setup-infra-maintainer/SKILL.md).

## The pieces

- **Engine** (`src/engine/`) — generic providers + the `provisionConfig` loop with
  `ctx.get()` chaining and surgical `.env` upsert. Vendored from envforge.
- **Preset model** (`src/presets/types.ts`) — `presetToProvider()` turns a preset into
  the uniform `InfraProvider` the orchestrator drives.
- **Composition** (`infra.config.ts`) — the ordered resource list. Add your preset here.
- **Identity** stays in `setup.config.json` (org/name/env). Never hardcode names.

## Pick a preset kind

| Kind | Use when | Carries |
|------|----------|---------|
| `validate` | A credential is pasted into `.setup-credentials` and only needs checking (Resend). | `validate()` (also run by `--check`), `toEnvironmentVariables`, `outputs`. |
| `guide` | No API to create the resource — the user follows a dashboard walkthrough and pastes values per environment (Stripe, Google OAuth). | `instructions` (array or `(ctx)=>string[]`), `guide.fields` (collected per env with masked/secret input), `outputs`. |
| `managed` | The service calls a real API to create resources and needs full lifecycle (Neon, Railway, AWS, Sentry). | A retained `provider` (the API-client + lifecycle impl) plus declarative `outputs`. |

## Generic providers (for engine-driven resources)

When a preset provisions via the engine rather than a retained client lib, choose a
generic provider by shape:

| Provider | Use for | Key config |
|----------|---------|------------|
| `manual` | Paste a value from a dashboard. | `prompts: { KEY: { secret?, optional? } }`, `steps: string[]`. |
| `httpApi` | Map a REST JSON response into env vars. | `url`, `method?`, `headers?`, `outputs: { KEY: "dot.path[0]" }`. |
| `generate` | Invent a local secret. | `outputs: { KEY: "hex" | { type, bytes } }`. |
| `static` / `mock` | Emit constants / config-derived values. | `outputs: { KEY: "value" | (env)=>value }`. |
| `command` | Run tooling in the target repo and capture stdout. | `command`, `args`, `cwd`, `outputs: { KEY: { stdout } | { match } }`. |

## `ctx.get()` chaining

A resource's `config` may be a function `(env, ctx) => ({...})`. `ctx.get('OTHER_KEY')`
reads a value provisioned earlier in the same run (or already in the `.env` file) — use
it to chain (e.g. an auth token fetched by a `manual` step → an `httpApi` call that reads
`ctx.get('SENTRY_AUTH_TOKEN')`). Order matters: the producing resource must come first.

## Requirements the lint enforces (`src/presets/lint.ts`)

Run `pnpm test` — `preset-lint.unit.test.ts` fails the build unless:

- every preset declares an `outputs` array (use `[]` when it emits no env vars);
- output keys are `UPPER_SNAKE_CASE` and unique;
- every declared output is emitted into the generated `.env.example` (`buildEnvExample`);
- `guide` presets collect ≥1 field, every field is a declared output, and have non-empty
  instructions;
- `validate` presets expose a `validate()`; `managed` presets wrap a provider whose key
  matches the preset key.

## Doc-steps format

Instructions are exact, ordered actions the user performs on the dashboard — copy the
real URLs and the exact field names/paths (see `stripe.preset.ts` /
`google-oauth.preset.ts`). One imperative step per line; blank lines separate
per-environment blocks.

## Steps to add a preset

1. Create `src/presets/<key>.preset.ts` (or add to `managed.presets.ts` for a wrapper).
2. Declare `outputs`, and the kind-specific surface (validate / guide / managed).
3. Export it from `src/presets/index.ts` and add it to `PRESETS`.
4. Add it to the `resources` list in `infra.config.ts` (order matters).
5. Ensure its `key` is listed in `docs/SETUP_INFRA_README.md` (provider-docs-sync test).
6. `pnpm lint && pnpm typecheck && pnpm test` — all green.

## See also

- **setup-infra-maintainer** — the full dependent-file checklist (config schema,
  secrets template, prerequisites, docs).
- `docs/envforge-convergence.md` — why the engine is vendored and what stays here.
