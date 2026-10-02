# clinozy-infra

Standalone provisioning tool for the **clinozy-be** (backend) and **clinozy-fe** (frontend) repos:
one command, `pnpm setup:infra`, sets up every third-party service (Neon, Railway, Netlify, Sentry,
AWS, Resend, PostHog, Turnstile, Stripe, Google/GitHub sign-in, Postman, Scalar, GitHub) for each
environment and writes each app's `.env.<environment>`. Extracted from `clinozy-be/tooling/setup/`
so provisioning can evolve independently.

## Prerequisites — once per machine

Do these in order; `pnpm setup:infra:prereqs` checks all of them (every run also starts with it).

1. **Tools**
   - Node ≥ 24.15 and pnpm ≥ 12.8.1 — the strictest minimums across all three repos; the check fails
     below them and warns when the repos' pinned versions (`.nvmrc`, `packageManager`) differ.
     All three pin Node **24.21.0** (latest LTS) and **pnpm 12.8.1**: `nvm install 24.21.0 && nvm use` ·
     `corepack enable` (pnpm 12 note: `pnpm -s` is gone — use `pnpm --reporter=silent`)
   - GitHub CLI — `brew install gh` · Railway CLI — `brew install railway`
2. **Repos** — clone `clinozy-infra`, `clinozy-be` and `clinozy-fe` side by side, then `pnpm install` in
   each (setup runs the backend's own scripts and writes both apps' env files).
3. **Logins**
   - Netlify — `npx netlify-cli login` (opens the browser). Netlify is used through this login only.
   - GitHub — `GITHUB_TOKEN` in `.setup/.setup-credentials`, or `gh auth login`. A fine-grained
     [token](https://github.com/settings/tokens) needs, on **both** app repos: **Actions** (read) to
     list GitHub Environments, **Administration** (read & write) to create them, **Environments**
     (read & write) for their secrets. It also becomes the apps' `RELEASE_PLEASE_TOKEN` (Contents +
     Pull requests write). The check lists both repos' environments and, on a denial, prints the
     permission GitHub reports missing.
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

## Go live — step by step

| # | Step | Command |
| --- | --- | --- |
| 1 | Provision every service and write both apps' `.env.<environment>` | `pnpm setup:infra` |
| 2 | Do what's left by hand — DNS, sign-in callback URLs, Stripe webhooks — until each is ✓ | `pnpm setup:infra:next` |
| 3 | Push each app's env files to its GitHub Environments | in each app: `pnpm github:sync` |
| 4 | Attestations switch + re-run the failed post-merge CI on `main` → development deploys | `pnpm setup:infra:deploy` |
| 5 | Merge each app's release-please Release PR (`chore(main): release X.Y.Z`) → the published release deploys production (`release-deploy.yml`, pinned to the tag) | on GitHub (squash) |
| 6 | Only if a release deploy failed, or to roll forward/back to a tag: re-deploy it from `main` | `pnpm setup:infra:deploy --production` |

What `pnpm setup:infra:deploy` does, per app — as your own `gh auth login` (an owner of both app repos), not setup's narrower `GITHUB_TOKEN`:

1. **Artifact attestations.** GitHub stores them for a private repository only on GitHub Enterprise
   Cloud. Where the plan can't, it sets the repository variable `ARTIFACT_ATTESTATIONS=disabled` (the
   apps' attest steps then skip with a warning); where it can, it removes the variable.
2. **Post-merge CI.** Re-runs the failed jobs of the latest `post-merge-ci.yml` run on `main`.
3. **Production** (`--production` only). Re-deploys the app's latest release by running
   `release-deploy.yml` from `main` with its tag, after a `y/N` confirmation (`--yes` skips it).
   Publishing a release already deploys production by itself (its own `release-deploy.yml` run), so
   this is for a failed release deploy or another tag: `--app backend|frontend` and `--tag vX.Y.Z`.

By hand, the same steps for one app:

```bash
gh variable set ARTIFACT_ATTESTATIONS --body disabled --repo <owner>/<app>   # private repo, not Enterprise
gh run rerun <run-id> --failed --repo <owner>/<app>                          # gh run list --workflow post-merge-ci.yml --branch main
gh workflow run release-deploy.yml --repo <owner>/<app> --ref main -f tag=vX.Y.Z
```

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

**Changing this repo:** `main` is protected like the apps' — changes land through a pull request,
squash-merged, once CI (`checks`: lint, typecheck, tests) passes. The rules live in
`.github/rulesets/main.json`; `pnpm github:rulesets:self` applies them (`:check` reports drift).

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
