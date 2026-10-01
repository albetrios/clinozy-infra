# clinozy-infra

Standalone infrastructure-provisioning tool (`setup:infra`) for the **clinozy-be** application repo.
Extracted from `clinozy-be/tooling/setup/` so infra provisioning can evolve independently.

## Roots

`clinozy-infra` is a *tool* that provisions infrastructure **for the application repos**. It keeps
these roots strictly separate (see `src/common/paths.ts`):

- **tool root** = this repo. Holds the tool's own inputs/state — `.setup/.setup-credentials`
  (provider tokens), `.setup-audit.log`, and this repo's copy of `setup.config.json`.
- **target root** = the backend repo being provisioned (default sibling `../clinozy-be`). Holds the
  app artifacts the tool reads/writes — `.env.<environment>`, `.env.example`, `.github/**`.
- **frontend root** = the frontend repo (default sibling `../clinozy-fe`), a **fully independent
  target**. The tool writes its `.env.<environment>` (browser-safe `VITE_*` keys, merged onto
  clinozy-fe's own `.env.example`) exactly the way it writes clinozy-be's.

`clinozy-infra` does **not** read or write either repo's `env-schema` — the env schema is each
project's own property, managed inside that project.

### Pointing at the target

Resolution order for the target repo:
1. `CLINOZY_BE_DIR` environment variable (absolute or relative path), else
2. `target.path` in `setup.config.json` (relative to this repo), else
3. default sibling `../clinozy-be`.

The path is validated to exist, so a mis-pointed target fails loudly.

Resolution order for the frontend repo (clinozy-fe) mirrors it:
1. `CLINOZY_FE_DIR` environment variable, else
2. `frontend.path` in `setup.config.json`, else
3. default sibling `../clinozy-fe`.

If clinozy-fe is absent, the env-export step warns and skips it rather than failing the run.

```bash
# from clinozy-infra/, provisioning the sibling ../clinozy-be (+ ../clinozy-fe)
pnpm setup:infra:plan          # read-only diff, provisions nothing
pnpm setup:infra               # interactive provisioning
CLINOZY_BE_DIR=/path/to/clinozy-be pnpm setup:infra:status
```

## Notes / gotchas

- **`setup.config.json` is duplicated** — a copy lives here (tool root) and one stays in clinozy-be
  (`tooling/setup/setup.config.json`, read by clinozy-be's `project-identity` codegen). Keep them in
  sync; `setup:infra:init` can refresh the target's copy.
- **The docs providers write into the target repo.** The Scalar/Postman providers run
  `pnpm docs:*` inside `../clinozy-be`, so the target repo's dependencies must be installed.
- **clinozy-be and clinozy-fe are independent env targets.** Provisioning writes/overwrites the provisioned
  keys into each repo's own `.env.<environment>` (clinozy-be backend keys; clinozy-fe browser-safe
  `VITE_*`), preserving every non-provisioned key. Managing the env **schema** is each project's job,
  not this tool's.

## Scripts

`pnpm setup:infra[:*]` (incl. `setup:infra:export-env`), `pnpm github:sync`, `pnpm setup:github[:*]`,
`pnpm validate:github-environments`, `pnpm setup:{domain,retention-secrets}`.
Dev: `pnpm health` (lint, typecheck, tests, identity — every phase, one summary), `pnpm lint[:fix]`,
`pnpm format`, `pnpm typecheck`, `pnpm test`.

## Identity and rebrand

The product identity is `package.json` → `name` plus `setup.config.json` → `project.name`,
`project.displayName`, `project.organization`, `product.name`, `frontend.name` and
`providers.github.repository` (see `src/identity/identity.ts`).

- `pnpm rebrand "<Product>"` — dry-run a total rename (identity, derived fields, every prose/code
  spelling: kebab, `UPPER_SNAKE`, `lower_snake`, camelCase); add `--apply` to write. Only files git
  sees are touched, never the gitignored `.setup/` state.
- `pnpm validate:identity` — fails on derived-field drift, on a name from `project.previousNames`
  coming back, or when the sibling backend/frontend's own identity disagrees with this one.
- `pnpm identity:sync` — re-derive the derived fields without renaming.
