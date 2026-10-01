# Add a new setup:infra provider

Step-by-step to wire a new third-party into `pnpm setup:infra`. The orchestrator is
**registry-driven**: it iterates `INFRA_PROVIDERS` and calls each provider's interface
hooks — so you do **not** edit `orchestrator.ts`. You touch the config schema, the secret
store, the env emission, and drop one provider file.

Replace `<key>` (kebab-case, e.g. `posthog`) and `<Name>` (PascalCase, e.g. `Posthog`)
throughout. See `setup-resend` (validate-only), `setup-sentry` (writes state), and
`setup-cloudflare-turnstile` (validate a `.setup-credentials` secret + emit env vars) as
worked examples.

---

## 1. Config schema + default (`common/config.ts`, `infra/init-wizard.ts`, `setup.config.json`)

- **`common/config.ts`** → `setupConfigSchema.providers`: add the provider object —
  `<key>: z.object({ enabled: z.boolean() /* + provider-specific fields */ })`.
- **`infra/init-wizard.ts`** → `buildConfig()` under `providers`:
  `<key>: { enabled: true /* + defaults */ }`.
- **`setup.config.json`** → add `"<key>": { "enabled": false }` (ship disabled by default).

## 2. Secret store (`common/secrets.ts`)

Pick the shape:

- **Single global token** → add to `TOKEN_URLS` + `SIMPLE_VARS` (template + append handle it
  automatically) and read it in `loadSecretsFromEnv`.
- **Per-environment keys** → add a per-env Zod schema, read `MYVAR_<ENV>_*` in the
  `for (const env of environmentNames)` loop, and add a block in **both**
  `buildEnvSetupTemplateContent` and `appendMissingEnvSetupVariables`.

```ts
// setupSecretsSchema
<key>: z.object({ apiKey: z.string() }).optional().default({ apiKey: '' }),
// or per-env:
<key>: z.record(z.string(), z.object({ siteKey: z.string(), secretKey: z.string() }))
  .optional().default({}),
```

Then map it in the object `loadSecretsFromEnv` returns. Update `hasAnyEnvSecret` only if the
new secret should count toward "any secret filled".

## Common header (mandatory — every provider starts with this)

Every `setup-<key>.provider.ts` begins with the same TSDoc block so the contract is
obvious at a glance:

```ts
/**
 * <Name> provider for `pnpm setup:infra`.
 *
 * <one line: what it provisions / validates>.
 *
 * NAMING (single source of truth = setup.config.json): organization/project names from
 * `config.project.*`, environment names from `config.environments[].name` — never hardcoded.
 * SECRETS: written to `.env.<environment>` only (via build-env-vars), never printed to the
 * console; setup secret files are gitignored and unreadable by the agent (deny-read guard). See SETUP_INFRA_PROVIDER_TEMPLATE.md.
 */
```

## Security (mandatory — applies to every step)

- **Never print a secret value.** Providers log status only (`valid`, `resolved`) — never the key/token/password/connection-string itself. Don't `logger.*` a secret, don't echo it, don't put it in an error message. Operators view a masked inventory with `pnpm setup:infra:output`, or `--copy <KEY>` to put one value on the clipboard (never stdout, auto-cleared, audit-logged).
- **Secrets land in `.env.<environment>` only**, via `build-env-vars.ts` → provisioning. State is ephemeral (in-memory, never persisted — there is no `.setup-state.json`). Both `.env.*` and `.setup-state.*` are blocked by the pre-commit secret guards (gitleaks + "No secret/state files staged") and unreadable by the agent (the `guardrails.mjs` deny-read hook).
- **Connection strings** with embedded credentials are masked by `output.ts` automatically; no action needed, just don't log them.

## 3. State (`common/state.ts`) — only if the provider resolves/creates something

If `provision` produces a value your `toEnvironmentVariables()` needs later (a DSN, a resolved
key), add it to `setupStateSchema` (mirror `sentry` / `posthog`) and write it via
`stateUpdates`. Validate-only providers (no remote resource) skip this.

## 4. Runtime env emission — `toEnvironmentVariables()` on YOUR provider

Each provider owns the `.env.<environment>` keys it contributes — **do not edit
`build-env-vars.ts`** (it just composes every provider's slice via the registry). Implement
`toEnvironmentVariables(context, environmentName)` on your `InfraProvider`, returning a
`Partial<EnvironmentVariables>` (the key must be declared on the `EnvironmentVariables` type in
`src/common/types.ts`; the consuming project validates it against its own env schema), gated
by `config.providers.<key>.enabled`. Return `{}` when not applicable.

```ts
toEnvironmentVariables: ({ config, secrets, state }, environmentName) => {
  if (!config.providers.<key>.enabled) return {};
  const value = state.<key>?.value;            // state-backed (DSN, resolved key)
  // …or read secrets.<key> for account-wide tokens
  return value ? { MY_RUNTIME_VAR: value } : {};
},
```

Providers whose per-env values are user-entered or upserted directly to `.env.<environment>`
(Stripe, OAuth, Turnstile, Postman, the GitHub App) emit **nothing** via the hook — omit it and
write with `upsertEnvFileValue`; those keys are surfaced by `resolveEnvironmentVariables` (the
`.env` overlay). Only providers whose value is derived from `config`/`state` use the hook (Neon,
Sentry, PostHog, Resend; the latter passes it through `createValidationProvider`).

## 5. Provider module (`infra/providers/setup-<key>/setup-<key>.provider.ts`)

Implement the `InfraProvider` interface (see `common/types.ts`). Use `@tooling/setup/...`
imports — never `../`. Minimal validate-only skeleton:

```ts
/**
 * <Name> provider for `pnpm setup:infra`.
 *
 * <one line: what it provisions / validates>.
 *
 * NAMING (single source of truth = setup.config.json): organization/project names from
 * `config.project.*`, environment names from `config.environments[].name` — never hardcoded.
 * SECRETS: written to `.env.<environment>` only (via build-env-vars), never printed to the
 * console; setup secret files are gitignored and unreadable by the agent (deny-read guard). See SETUP_INFRA_PROVIDER_TEMPLATE.md.
 */
import * as logger from '@tooling/setup/common/logger.js';
import type {
  SetupConfig, SetupSecrets, ProviderResult,
  InfraProvider, InfraProviderContext,
} from '@tooling/setup/common/types.js';

export async function provision(
  config: SetupConfig, secrets: SetupSecrets, environments: string[],
): Promise<ProviderResult> {
  if (!config.providers.<key>.enabled) {
    return { success: true, message: '<Name>: skipped (disabled)' };
  }
  // validate / resolve here (fetch is fine — no CLI needed)
  return { success: true, message: '<Name>: validated' };
  // state-backed: return { ..., stateUpdates: { <key>: { value } } };
}

export const setup<Name>Provider: InfraProvider = {
  key: '<key>',
  name: '<Name>',
  isEnabled: ({ config }) => config.providers.<key>.enabled,
  disabledReason: () => 'disabled in setup.config.json',
  preview: ({ config }) =>
    config.providers.<key>.enabled
      ? { detail: 'API key', url: 'https://…', configKey: 'MY_RUNTIME_VAR' }
      : null,
  settingsReview: ({ config }) =>
    config.providers.<key>.enabled
      ? [{ bucket: 'extra', provider: '<Name>', detail: 'validate 1 key' }]
      : [],
  buildStep: (context: InfraProviderContext) => ({
    name: '<Name>',
    enabled: setup<Name>Provider.isEnabled(context),
    enabledReason: setup<Name>Provider.disabledReason(context),
    instructions: ['What this step does and where the key comes from.'],
    // IDEMPOTENCY: for resource-creating providers, report existence here. When this
    // returns true the framework prints "Already present" and prompts (u)pdate/(s)kip
    // (default skip; auto-skip in --yes/CI). Absent → the step creates the resource.
    alreadyDone: () => Boolean(context.state.<key>?.id),
    alreadyDoneMessage: '<Name> already in state',
    execute: async () => {
      const result = await provision(context.config, context.secrets, context.environments);
      if (!result.success) throw new Error(result.message);
      // state-backed: context.applyStateUpdates(result.stateUpdates ?? {});
      return result;
    },
  }),
  // optional: inspectRemote (powers `setup:infra:inspect` + `plan --remote` — return
  //   { present, fields: [{ label, expected, remote, matches }] }, never throw),
  //   check, detectExisting, detectRemote, deleteInstructions
};
```

> **Idempotency (present? update or skip · absent? create)** comes for free once a
> resource-creating provider implements `alreadyDone()` (or `alreadyDoneEnvironments()`):
> `runInteractiveStep` detects existence and prompts. Validate-only providers omit it and
> simply re-validate each run.

Implement `deleteInstructions(context)` whenever the provider provisions tracked resources
(records `stateUpdates`) — returns dashboard URL + identifiers for the manual `--delete` guide). Never add a
`destroy` method — `setup:infra` does not delete resources.

## 6. Register (`infra/providers/index.ts`)

Import and add to `INFRA_PROVIDERS` (order = run order). That is the only registry edit.

## 7. Guide (`infra/guide.ts`)

Add a `buildGuideSteps()` entry: `providerName`, `enabledCheck`, `secretsCheck`,
`browserUrls`, `instructions` (the manual fallback for when tokens aren't filled yet).

## 8. Prerequisites (`infra/prerequisites.ts`) — only if a CLI/token is required

Add a `PREREQUISITES` entry (`command`, `versionFlag`, `enabledCheck`, optional
`tokenEnvKey`). HTTP-only providers (using `fetch`) need nothing here.

## 9. Docs

Add rows to **both** tables in `docs/deployment/setup/setup-token-instructions.md`
(per-provider token URLs + env-var names). Add the provider to the registry list in
[SETUP_INFRA_README.md](./SETUP_INFRA_README.md). Run the **docs-maintainer** skill if you
moved docs.

## 10. Verify

```bash
pnpm typecheck
pnpm setup:infra:preview                     # new provider appears in the selected list
pnpm setup:infra --providers <key>           # exercise just this one
npx biome check tooling/setup
```

---

> Run the **`setup-infra-maintainer`** skill when adding/removing a provider — it is the
> authoritative checklist. (Its "edit `PREVIEW_PROVIDERS` / `displaySettingsReview`"
> guidance is stale: the orchestrator became registry-driven, so steps 5–6 here replace it.)
