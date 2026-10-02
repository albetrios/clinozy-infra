import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import {
  runProvision,
  runCheck,
  runStatus,
  runUpdate,
  runDeleteInstructions,
  runPreview,
  runReconstruct,
  getAvailableProviderKeys,
} from './infra/orchestrator.js';
import { runInitWizard } from './infra/init-wizard.js';
import { runDoctor } from './infra/doctor.js';
import { runPrerequisitesCheck } from './infra/prerequisites.js';
import { runNextSteps } from './infra/next-steps.js';
import { runDeploy } from './infra/deploy.js';
import { loadConfig } from './common/config.js';
import { runExample } from './infra/example.js';
import { runGuide } from './infra/setup-guide/index.js';
import { runVault } from './infra/vault.js';
import { runPlan } from './infra/plan.js';
import { runInspect } from './infra/inspect.js';
import { runFrontend, runOutput } from './infra/output.js';
import { runExportEnv, runExportFrontendEnv } from './envs/export-env-files.js';
import { loadEnvSetupIntoProcess, loadSecrets } from './common/secrets.js';
import { setAssumeYes, setForce } from './common/prompts.js';
import { omitUndefined } from './common/object.js';
import { reportSetupError } from './common/setup-error.js';
import * as logger from './common/logger.js';
import type { ProviderSelectionInput } from './infra/orchestrator.js';

// Node abandons each address of a dual-stack host after 250 ms; on a slow or IPv6-broken network
// every attempt is cut off and fetch fails with ETIMEDOUT. Give each attempt 2 s — here and in the
// child Node processes setup spawns (the backend's postman/scalar/migrate scripts).
const CONNECT_ATTEMPT_MS = 2_000;
setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_MS);
process.env.NODE_OPTIONS = [
  process.env.NODE_OPTIONS,
  `--network-family-autoselection-attempt-timeout=${CONNECT_ATTEMPT_MS}`,
]
  .filter(Boolean)
  .join(' ');

const args = process.argv.slice(2);

loadEnvSetupIntoProcess();

// Non-interactive mode: auto-answer every prompt with its safe default (continue/skip/yes).
// The settings review is still printed; it just isn't gated on stdin.
if (args.includes('--yes') || args.includes('-y')) {
  setAssumeYes(true);
}

// Force mode: re-provision / re-collect even when already set (default keeps existing).
if (args.includes('--force') || args.includes('-f')) {
  setForce(true);
}

function getCommand(): string {
  if (args.includes('--help') || args.includes('-h')) return 'help';
  if (args.includes('--init')) return 'init';
  if (args.includes('--preview')) return 'preview';
  if (args.includes('--dry-run')) return 'dry-run';
  if (args.includes('--reconstruct')) return 'reconstruct';
  if (args.includes('--check')) return 'check';
  if (args.includes('--status')) return 'status';
  if (args.includes('--update')) return 'update';
  if (
    args.includes('--delete') ||
    args.includes('--delete-instructions') ||
    args.includes('--revert') ||
    args.includes('--revert-all')
  ) {
    return 'delete';
  }
  if (args.includes('--prereqs')) return 'prereqs';
  if (args.includes('--doctor')) return 'doctor';
  if (args.includes('--next')) return 'next';
  if (args.includes('--deploy')) return 'deploy';
  if (args.includes('--example')) return 'example';
  if (args.includes('--guide')) return 'guide';
  if (args.includes('--vault')) return 'vault';
  if (args.includes('--plan')) return 'plan';
  if (args.includes('--inspect')) return 'inspect';
  if (args.includes('--frontend')) return 'frontend';
  if (args.includes('--output')) return 'output';
  if (args.includes('--export-env-fe')) return 'export-env-fe';
  if (args.includes('--export-env')) return 'export-env';
  return 'provision';
}

function parseStringFlag(flagName: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${flagName}=`));
  if (inline) return inline.slice(flagName.length + 1);
  const flagIndex = args.indexOf(flagName);
  const value = flagIndex >= 0 ? args[flagIndex + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function parseNumberFlag(flagName: string): number | undefined {
  const raw = parseStringFlag(flagName);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function parseProviderList(flagName: string): string[] | undefined {
  const inline = args.find((arg) => arg.startsWith(`${flagName}=`));
  const flagIndex = args.indexOf(flagName);
  const rawValue =
    inline?.slice(flagName.length + 1) ?? (flagIndex >= 0 ? args[flagIndex + 1] : undefined);
  if (!rawValue || rawValue.startsWith('--')) return undefined;
  return rawValue
    .split(',')
    .map((providerKey) => providerKey.trim().toLowerCase())
    .filter(Boolean);
}

function getProviderSelection(): ProviderSelectionInput {
  // -r / --resource is an alias for --providers (scope the run to specific resources).
  const includeKeys =
    parseProviderList('--providers') ??
    parseProviderList('--only-providers') ??
    parseProviderList('--resource') ??
    parseProviderList('-r');
  const skipKeys = parseProviderList('--skip-providers');
  return {
    ...(includeKeys !== undefined ? { includeKeys } : {}),
    ...(skipKeys !== undefined ? { skipKeys } : {}),
  };
}

/** `-e` / `--env`: scope to a subset of environments (comma-separated). */
function getEnvScope(): string[] | undefined {
  return parseProviderList('--env') ?? parseProviderList('-e');
}

function printHelp(): void {
  const providerKeys = getAvailableProviderKeys().join(', ');
  logger.info('Usage:');
  logger.info(
    '  pnpm setup --init                    Generate setup.config.json + .setup/.setup-credentials',
  );
  logger.info('  pnpm setup                           Full interactive provisioning');
  logger.info('  pnpm setup --preview                 Show providers + token URLs (no API calls)');
  logger.info(
    '  pnpm setup --plan [--remote]         Diff: what exists vs will be created/updated (read-only; --remote = live)',
  );
  logger.info(
    '  pnpm setup --inspect                 Remote inspection: present/absent + config-vs-remote drift',
  );
  logger.info(
    '  pnpm setup --prereqs                 Check tools, logins, config and credentials (also runs first inside a run)',
  );
  logger.info(
    '  pnpm setup --doctor                  Validate config + flag footguns (also runs first inside --plan)',
  );
  logger.info(
    '  pnpm setup --deploy [--production]   Attestations switch + re-run failed post-merge CI; --production deploys each latest release from main (--app backend|frontend, --tag vX.Y.Z)',
  );
  logger.info(
    '  pnpm setup --example [--force]       Emit committable .env.example files (keys + comments) for both targets',
  );
  logger.info(
    '  pnpm setup --guide [--out <file>]    Generate the human setup guide (HTML) from the catalog — where each key goes',
  );
  logger.info(
    '  pnpm setup --vault                   Back-fill .env.<env> secrets into KeyStash (config-gated; off by default)',
  );
  logger.info('  pnpm setup --dry-run                 Full dry-run of selected steps');
  logger.info('  pnpm setup --status                  All-environments dashboard');
  logger.info(
    '  pnpm setup --output                  Masked env inventory (secrets never printed; --copy <KEY>, or --copy-all for the full .env, to clipboard; --clear <sec> auto-clear window, default 30)',
  );
  logger.info(
    '  pnpm setup --frontend                Print the browser-safe clinozy-fe key bundle (--vite for VITE_ names; --environment <env>)',
  );
  logger.info('  pnpm setup --reconstruct             Rebuild state from remote APIs');
  logger.info('  pnpm setup --check                   Health check selected providers');
  logger.info(
    '  pnpm setup --update                  Re-sync update-capable providers (github today)',
  );
  logger.info(
    '  pnpm setup --delete                  Print manual-delete dashboard URLs (no resources removed)',
  );
  logger.blank();
  logger.info('Provider selection:');
  logger.info(
    '  --yes, -y                            Non-interactive: auto-continue every step (skips on failure, no TTY required)',
  );
  logger.info(
    '  --force, -f                          Re-provision / re-collect even when a value is already set',
  );
  logger.info('  --providers neon,jwt,github           Run only these provider keys');
  logger.info('  -r, --resource neon,jwt               Alias for --providers (scope resources)');
  logger.info('  -e, --env development                 Scope to environment(s) (status / guide)');
  logger.info('  --skip-providers postman,oauth        Run all except these provider keys');
  logger.info('  SETUP_INFRA_PROVIDERS=neon,jwt        Env allow-list for AI/automation prompts');
  logger.info('  SETUP_INFRA_SKIP_PROVIDERS=postman    Env skip-list for AI/automation prompts');
  logger.info(`  Available provider keys: ${providerKeys}`);
}

async function main(): Promise<void> {
  const command = getCommand();
  const providerSelection = getProviderSelection();

  try {
    switch (command) {
      case 'help':
        printHelp();
        break;
      case 'init':
        await runInitWizard();
        break;
      case 'preview':
        runPreview({ providerSelection });
        break;
      case 'plan':
        await runPlan({ providerSelection, remote: args.includes('--remote') });
        break;
      case 'prereqs':
        await runPrerequisitesCheck(loadConfig());
        break;
      case 'doctor':
        runDoctor();
        break;
      case 'next': {
        const config = loadConfig();
        await runNextSteps(config);
        break;
      }
      case 'deploy':
        await runDeploy(
          loadConfig(),
          omitUndefined({
            production: args.includes('--production') || undefined,
            tag: parseStringFlag('--tag'),
            app: parseStringFlag('--app'),
          }),
        );
        break;
      case 'example':
        runExample(omitUndefined({ force: args.includes('--force') || undefined }));
        break;
      case 'guide':
        runGuide(omitUndefined({ out: parseStringFlag('--out'), environments: getEnvScope() }));
        break;
      case 'vault':
        runVault();
        break;
      case 'inspect':
        await runInspect({ providerSelection });
        break;
      case 'dry-run':
        logger.info('Dry-run: full provisioning preview');
        runPreview({ providerSelection });
        break;
      case 'reconstruct':
        await runReconstruct({ providerSelection });
        break;
      case 'provision':
        await runProvision({ providerSelection });
        break;
      case 'check':
        await runCheck({ providerSelection });
        break;
      case 'status':
        await runStatus(omitUndefined({ environments: getEnvScope() }));
        break;
      case 'update':
        await runUpdate({ providerSelection });
        break;
      case 'delete':
        if (args.includes('--revert') || args.includes('--revert-all')) {
          logger.warn(
            '--revert is deprecated — setup:infra never deletes resources. Use --delete to print manual deletion guidance.',
          );
        }
        runDeleteInstructions({ providerSelection });
        break;
      case 'output':
        await runOutput(
          omitUndefined({
            environment: parseStringFlag('--environment'),
            copy: parseStringFlag('--copy'),
            copyAll: args.includes('--copy-all') || undefined,
            clearSeconds: parseNumberFlag('--clear'),
          }),
        );
        break;
      case 'frontend':
        runFrontend(
          omitUndefined({
            environment: parseStringFlag('--environment'),
            vite: args.includes('--vite') || undefined,
          }),
        );
        break;
      case 'export-env-fe':
        runExportFrontendEnv();
        break;
      case 'export-env':
        runExportEnv();
        break;
      default:
        logger.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (error) {
    logger.blank();
    // Single exit point: providers/orchestrator throw SetupError/SetupAbort instead of
    // calling process.exit, so the whole module stays importable and testable.
    process.exit(reportSetupError(error, logger));
  }
}

void main();
