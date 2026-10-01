# SESSION.md — envforge convergence + setup guide

> Working handoff doc. If this session is interrupted, start here.
> **Branch:** `feat/envforge-convergence` (base: `dev`) · **Status:** all green
> (`pnpm lint && pnpm typecheck && pnpm test` → 22 files / 124 tests).

---

## 1. Goal

Port envforge's generic provisioning **engine + preset model + CLI/UX** into
`clinozy-infra` while keeping everything clinozy-infra does better (lifecycle verbs, audit,
dual-target, GitHub/Railway, tests). Reference (read-only):
`~/random-projects/envforge-env-provisioner`. Full brief + convergence notes:
[`docs/envforge-convergence.md`](docs/envforge-convergence.md).

Then, on top: a **human-facing setup guide** generated from the catalog (the human's
surface), while the agent/CLI orchestrates on the backend and never touches secret values.

---

## 2. What's done (all 8 original tasks + the guide suite)

| Area | Status | Notes |
|---|---|---|
| Task 1 — vendor engine | ✅ | `src/engine/` — 5 generic providers + `command`, `ctx.get()` chaining, surgical upsert, ephemeral state, audit+logger wired |
| Task 2 — surgical `.env` upsert | ✅ | multi-line/PEM-aware; `.env.example` = first-run seed only |
| Task 3 — every service a preset | ✅ | 3 converted outright (resend/stripe/google-oauth, bespoke deleted); 12 **managed wrappers** over retained client libs |
| Task 4 — `infra.config.ts` | ✅ | orchestrator reads it (lazy, cycle-safe); identity stays in `setup.config.json` |
| Task 5 — CLI UX | ✅ | masked input · non-interactive input · doctor · example · `--clear` · status matrix (5.4) · `-e/-r` (5.8) · EOF-safe prompts (5.2) · init scaffolds config (5.3) · `--force` (5.7) |
| Task 6 — KeyStash vault | ✅ | config-gated OFF; `setup:infra:vault` back-fill; injectable client (unit-tested) |
| Task 7 — agent harness | ✅ | `preset-author` skill + `preset-conventions-sync.mdc` rule + preset-lint check |
| Task 8 — convergence doc | ✅ | `docs/envforge-convergence.md` |
| Guide generator | ✅ | `setup:infra:guide` → self-contained HTML from catalog; live per-env status; per-service **"i" button** step walkthrough; shipped by `init` |

**New CLI verbs:** `setup:infra:doctor`, `setup:infra:example`, `setup:infra:guide`,
`setup:infra:vault` (plus existing plan/preview/inspect/check/status/output/frontend/
export-env/reconstruct/delete/init).

---

## 3. Commit log (this branch, oldest → newest)

```
5233769 feat(engine): vendor generic provisioning engine from envforge          (Task 1)
5c9b4d7 feat(envs): replace template-merge with surgical .env upsert            (Task 2)
ccb48cb feat(presets): preset model + command provider; convert 3 providers     (Task 3a)
b469d6b feat(config): orchestrator reads infra.config.ts                         (Task 4)
a5293e2 feat(presets): every service is a preset (managed wrappers)             (Task 3b)
ca586c3 feat(agent-os): preset-author skill + rule + preset-lint check           (Task 7)
2781c50 docs: add envforge-convergence.md                                        (Task 8)
f213303 feat(cli): add doctor + example verbs                                    (Task 5)
1f487b8 feat(cli): mask secret prompts with asterisks                            (Task 5)
bfa7a0d feat(cli): non-interactive input plumbing for guide services            (Task 5)
983986f feat(cli): configurable clipboard auto-clear window (--clear)           (Task 5)
5f90375 feat(cli): setup:infra:guide — generate the human UI from the catalog   (Guide)
87d48aa feat(guide): live per-environment status (cockpit, presence only)       (Guide)
1758297 feat(init): generate the setup guide at the end of the init wizard      (Guide)
b514f1e feat(vault): KeyStash integration + setup:infra:vault (config-gated)     (Task 6)
a4c3a88 feat(cli): offline status matrix in setup:infra:status                   (Task 5.4)
f623f13 feat(cli): -e/--env and -r/--resource scoping                           (Task 5.8)
9e03510 feat(init): scaffold infra.config.ts from the preset catalog            (Task 5.3)
d303ab1 feat(cli): EOF-safe prompts — piped/CI runs never hang                  (Task 5.2)
271681d feat(cli): global --force keep-existing override                        (Task 5.7)
99349f7 feat(guide): per-service "i" button step walkthrough + inline open link (Guide)
```

No PR opened (per instruction). No push unless asked.

---

## 4. Architecture (the end state)

```
  HUMAN ─► generated guide (live per-env status, i-button steps)
              └─ places keys in .setup/.setup-credentials  and  .env.<env>   (human owns secrets)
  AGENT / CLI ─► doctor · plan · provision · status(matrix) · vault
              └─ backend orchestration; NEVER handles the secret values
  everything the guide/status/doctor/example show ⟵ generated from
              infra.config.ts + the preset catalog   (per-project, can't drift)
  init ─► scaffolds setup.config.json (identity) + infra.config.ts (resources) + the guide
```

**Config split:** identity = `setup.config.json`; resources = `infra.config.ts`
(`defineInfraConfig`, resolved lazily by `src/infra/providers/index.ts` →
`getInfraProviders()` / `keystashEnabled()`).

**Preset kinds** (`src/presets/types.ts`):
- `validate` — probe a pasted credential (resend).
- `guide` — dashboard walkthrough + per-env paste (stripe, google-oauth).
- `managed` — thin wrapper over a retained API-orchestrating provider (neon, aws,
  railway, sentry, …) + declarative outputs. Client code stays in the `.provider.ts`.

**Secrets discipline:** copy-only, never printed; `--copy`/UI chips → clipboard,
auto-cleared (default 30s, `--clear <sec>`); `.env*` + `.setup-credentials` gitignored +
agent-deny-read; audit log records key names, never values.

---

## 5. Key files / where things live

| Concern | Path |
|---|---|
| Engine (vendored) | `src/engine/` (`engine.ts`, `env-file.ts`, `registry.ts`, `state.ts`, `prompt.ts`, `providers/`) |
| Preset model + catalog | `src/presets/` (`types.ts`, `managed.presets.ts`, `resend/stripe/google-oauth.preset.ts`, `lint.ts`, `example.ts`, `index.ts`) |
| Resource composition | `infra.config.ts` (root) + `src/infra/config.ts` (`defineInfraConfig`) |
| Provider registry | `src/infra/providers/index.ts` (`getInfraProviders`, `keystashEnabled`) |
| Guide generator | `src/infra/setup-guide/` (`data.ts`, `render.ts`, `template.html`, `index.ts`) |
| Status matrix | `src/infra/status-matrix.ts` |
| Doctor / example / vault / scaffold | `src/infra/doctor.ts`, `example.ts`, `vault.ts`, `scaffold-config.ts` |
| KeyStash | `src/integrations/keystash.ts` |
| Prompts (mask / EOF-safe / force) | `src/common/prompts.ts` |
| Env writers | `src/envs/export-env-files.ts`, `frontend-env-keys.ts`, `env-file-setup.util.ts` |
| Agent harness | `agent-os/skills/preset-author/SKILL.md`, `agent-os/rules/preset-conventions-sync.mdc` |
| Tests | `src/tests/unit/engine/**`, `src/tests/unit/setup/**` |

---

## 6. Decisions locked in (don't re-litigate)

- **State: ephemeral** — no `state.json`; hydrate from remote (preserves reconstruct/inspect).
- **Railway/GitHub → presets too** — as `managed` wrappers (client code retained).
- **Heavy providers = thin preset + retained client lib** — internal API-from-wiring split deferred (needs integration testing).
- **`.env.example` = first-run seed only** (not reconciled on existing files).
- **Task 4 before finishing Task 3** — the orchestrator target must exist first.
- **Secrets: copy-only, never print, auto-clear.** No `--json` that dumps secret values.
- **Human uses the UI; agent stays backend, never touches env values.**
- **Everything generated from config/presets** (per-project, can't drift). Reuse existing files over duplicating.

---

## 7. TODO / follow-ups (nothing blocking; all green)

**Task 3 depth**
- [ ] Split the 12 `managed` providers' API calls from their InfraProvider wiring so they
      shrink toward data (Neon/Railway/AWS/…). **Needs integration testing** (live creds) —
      do per-provider, not in bulk.

**Task 5 polish**
- [ ] `init` interactive **service picker** (currently scaffolds ALL presets; edit to remove).
- [ ] Wire `-e/--env` into the **remote** status dashboard too (today it scopes only the
      offline matrix + guide).

**Guide UX (optional)**
- [ ] Whole-row click to expand steps (even fewer clicks).
- [ ] Auto-expand the first not-yet-`set` service.
- [ ] Optional "mark done" affordance alongside live status.

**Agentic (from the earlier menu, not yet built)**
- [ ] `--json` output on doctor/plan/status/inspect (structure only — never secret values).
- [ ] MCP server wrapping the read verbs (doctor/plan/inspect/status/export-env); `provision` gated.

**Final verification from the brief (needs a real target repo + creds)**
- [ ] `pnpm setup:infra:plan` against sibling `../clinozy-be` → zero writes, doctor clean.
- [ ] Fixture `.env` survives an `up` byte-identical except provisioned keys (unit-covered;
      confirm end-to-end).

---

## 8. How to resume

```bash
cd ~/projects/clinozy/clinozy-infra
git checkout feat/envforge-convergence
pnpm install                 # if needed
pnpm lint && pnpm typecheck && pnpm test    # expect green, 124 tests

# See the generated human guide (reads real ../clinozy-be/.env.* for live status):
pnpm setup:infra:guide       # writes ./setup-guide.html (gitignored) — open in a browser
pnpm setup:infra:doctor      # config footguns
pnpm setup:infra:status      # offline matrix + remote dashboard
```

- Add a service → write `src/presets/<key>.preset.ts` (or a `managed` entry), export it in
  `src/presets/index.ts`, add it to `infra.config.ts`, list its key in
  `docs/SETUP_INFRA_README.md`. The `preset-author` skill + `preset-lint` test enforce shape.
- The generated guide (`template.html`) is a full HTML doc with a
  `window.__GUIDE__ = /*__GUIDE_DATA__*/ null;` marker that `render.ts` injects into.
- Artifact preview URL used during the session (regenerate + redeploy to update):
  `https://claude.ai/code/artifact/ed3d3e7a-f347-4904-b73a-b32b53bd920a`

---

## 9. Conversation history (chronological, condensed)

1. **Plan review** — mapped both repos; produced an item-wise plan (issue → fix → outcome →
   benefits). Answered 4 setup questions (ephemeral state, Railway/GitHub→presets,
   task-by-task, `.env.example` first-run seed).
2. **Task 1** — vendored the engine + 5 providers + tests → `5233769`.
3. **Task 2** — surgical `.env` upsert (multi-line/PEM-aware) → `5c9b4d7`.
4. **Task 3 fork** — chose "Task 4 first, then finish Task 3" + "thin preset + retained lib";
   built preset model + `command` provider, converted resend/stripe/google-oauth → `ccb48cb`.
5. **Task 4** — `infra.config.ts` + lazy cycle-safe resolver → `b469d6b`.
6. **Task 3b** — `managed` wrappers for the other 12 → `a5293e2`.
7. **Tasks 7 & 8** — preset-author skill/rule/lint + convergence doc → `ca586c3`, `2781c50`.
8. **Task 5 start** — doctor + example + masked input → `f213303`, `1f487b8`.
9. **Diagrams** — explained architecture via Mermaid (rendered widget) + terminal-UI mockup.
10. **UI build** — user asked for an easy multi-env setup UI; built the guide artifact,
    iterated: v1 → v2 (grouped + copy-template) → v3 (editorial). Copy-only + 30s auto-clear.
11. **Agentic direction** — chose non-interactive input plumbing → `bfa7a0d`;
    then configurable `--clear` → `983986f`.
12. **C + UI** — generate guide from config (`setup:infra:guide`) → `5f90375`; live status
    → `87d48aa`; init ships guide → `1758297`.
13. **Backend (all 3)** — KeyStash `b514f1e`; status matrix `a4c3a88`; scoping `f623f13`.
14. **Remaining Task 5** — init scaffolds config `9e03510`; EOF-safe prompts `d303ab1`;
    `--force` `271681d`.
15. **Guide "i" button** — per-service step walkthrough + inline Open link → `99349f7`.
16. **This doc.**
