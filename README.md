# clinozy-infra

Standalone provisioning tool for the **clinozy-be** (backend) and **clinozy-fe** (frontend) repos:
one command, `pnpm setup:infra`, sets up every third-party service (Neon, Railway, Netlify, Sentry,
AWS, Resend, PostHog, Turnstile, Stripe, Google/GitHub sign-in, Postman, Scalar, GitHub) for each
environment and writes each app's `.env.<environment>`. Extracted from `clinozy-be/tooling/setup/`
so provisioning can evolve independently.

## Prerequisites — once per machine

Do these in order; `pnpm setup:infra:prereqs` checks all of them (every run also starts with it).

1. **Tools**
   - Node ≥ 24.15 and pnpm ≥ 11.1.1 — the strictest minimums across all three repos; the check fails
     below them and warns when the repos' pinned versions (`.nvmrc`, `packageManager`) differ.
     `nvm install 24 && nvm use 24` · `corepack enable` (this repo pins `pnpm@11.1.1`)
   - GitHub CLI — `brew install gh` · Railway CLI — `brew install railway`
2. **Repos** — clone `clinozy-infra`, `clinozy-be` and `clinozy-fe` side by side, then `pnpm install` in
   each (setup runs the backend's own scripts and writes both apps' env files).
3. **Logins**
   - Netlify — `npx netlify-cli login` (opens the browser). Netlify is used through this login only.
   - GitHub — `GITHUB_TOKEN` in `.setup/.setup-credentials`, or `gh auth login`. A fine-grained
     [token](https://github.com/settings/tokens) needs, on **both** app repos: Administration and
     Environments (read & write) — setup creates their GitHub Environments — and Secrets (read). It
     also becomes the apps' `RELEASE_PLEASE_TOKEN` (Contents + Pull requests write). The check verifies
     the login can manage both repos' environments.
   - Railway — `RAILWAY_API_TOKEN` in `.setup/.setup-credentials` ([create one](https://railway.com/account/tokens)),
     or `railway login`.
   A missing GitHub or Railway token is asked for during the check.
4. **Config** — `setup.config.json` (committed): names, environments, `product.domain`, which
   providers are on. Edit it only to change those; every host is derived from `product.domain`.
5. **Credentials** — nothing to prepare: `pnpm setup:infra` asks once for each value missing from
   `.setup/.setup-credentials` (one line with its link, hidden input) and saves it.

```bash
pnpm setup:infra:prereqs       # 1/4 tools · 2/4 logins · 3/4 config · 4/4 credentials — all ✓?
```

## Quick start

```bash
pnpm setup:infra:plan          # read-only: what exists vs what would be created
pnpm setup:infra               # prerequisites → asks for missing credentials → provisions → checklist
pnpm setup:infra:next          # what is left to do by hand, with live checks
```

Every credential and what gets created: [docs/SETUP_INFRA_PREREQUISITES.md](docs/SETUP_INFRA_PREREQUISITES.md).

## Docs

| Doc | For |
| --- | --- |
| [SETUP_INFRA_PREREQUISITES.md](docs/SETUP_INFRA_PREREQUISITES.md) | Preparing a machine, every credential and where to get it, database users, derived hosts |
| [SETUP_INFRA_README.md](docs/SETUP_INFRA_README.md) | How a run works, all scripts, security, architecture and file map, known limitations |
| [SETUP_INFRA_PROVIDER_TEMPLATE.md](docs/SETUP_INFRA_PROVIDER_TEMPLATE.md) | Adding a provider |
| [envforge-convergence.md](docs/envforge-convergence.md) | Why the provisioning engine is vendored from envforge |
| `.claude/skills/` (`setup-infra-maintainer`, `preset-author`) | Checklists for agents changing providers or presets |

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

- **`setup.config.json` has copies in the apps** — the one here drives provisioning; clinozy-be and
  clinozy-fe each keep their own `tooling/setup/setup.config.json` (read by their identity codegen).
  `pnpm validate:identity` fails when the apps' identity disagrees with this one.
- **The docs providers write into the target repo.** The Scalar/Postman providers run
  `pnpm docs:*` inside `../clinozy-be`, so the target repo's dependencies must be installed.
- **clinozy-be and clinozy-fe are independent env targets.** Provisioning writes/overwrites the provisioned
  keys into each repo's own `.env.<environment>` (clinozy-be backend keys; clinozy-fe browser-safe
  `VITE_*`), preserving every non-provisioned key. Managing the env **schema** is each project's job,
  not this tool's.

## Scripts

`pnpm setup:infra[:*]` (incl. `setup:infra:export-env`), `pnpm github:sync`, `pnpm setup:github[:*]`,
`pnpm validate:github-environments`, `pnpm setup:domain`.
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
