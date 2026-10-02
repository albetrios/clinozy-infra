import { targetPath } from '@setup/common/paths.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gh, resolveRepository } from './gh.js';
import {
  compareGitHubEnvironmentToConfig,
  driftResultsHaveIssues,
  loadGitHubEnvironmentConfigs,
  parseGitHubEnvironmentApiResponse,
  type GitHubEnvironmentDriftResult,
} from './environments-util.js';

export { driftResultsHaveIssues } from './environments-util.js';

/** The backend's `.github/environments` — resolved on use, so importing never needs the repo. */
const defaultEnvironmentsDirectory = (): string => targetPath('.github', 'environments');

function getRepositoryIdentifier(): string {
  return resolveRepository();
}

function fetchGitHubEnvironment(repository: string, environmentName: string): unknown {
  try {
    // Path is a single argv element to `gh` — no shell, so env/repo names can't inject.
    const output = gh(['api', `repos/${repository}/environments/${environmentName}`], {
      timeoutMs: 15_000,
    });
    return JSON.parse(output) as unknown;
  } catch (commandError) {
    const message = commandError instanceof Error ? commandError.message : String(commandError);
    throw new Error(
      `Failed to fetch GitHub environment "${environmentName}" for ${repository}: ${message}`,
    );
  }
}

export type ValidateGitHubEnvironmentsDriftOptions = {
  readonly environmentsDirectory?: string;
  readonly environmentNames?: readonly string[];
};

export function validateGitHubEnvironmentsDrift({
  environmentsDirectory = defaultEnvironmentsDirectory(),
  environmentNames,
}: ValidateGitHubEnvironmentsDriftOptions = {}): GitHubEnvironmentDriftResult[] {
  const repository = getRepositoryIdentifier();
  const configs = loadGitHubEnvironmentConfigs(environmentsDirectory);
  const selectedEnvironmentNames = environmentNames
    ? new Set(environmentNames.map((environmentName) => environmentName.trim()).filter(Boolean))
    : undefined;
  const selectedConfigs = selectedEnvironmentNames
    ? configs.filter((config) => selectedEnvironmentNames.has(config.name))
    : configs;
  const results: GitHubEnvironmentDriftResult[] = [];

  if (selectedEnvironmentNames && selectedConfigs.length !== selectedEnvironmentNames.size) {
    const configuredNames = new Set(configs.map((config) => config.name));
    const missingNames = [...selectedEnvironmentNames].filter(
      (environmentName) => !configuredNames.has(environmentName),
    );
    throw new Error(
      `Missing GitHub environment config file for: ${missingNames.join(', ') || 'unknown'}`,
    );
  }

  console.log(`Validating GitHub environment protection (config ↔ UI)`);
  console.log(`  Repository: ${repository}`);
  console.log(`  Config directory: ${environmentsDirectory}`);
  console.log(`  Environments: ${selectedConfigs.map((config) => config.name).join(', ')}`);
  console.log('');

  for (const config of selectedConfigs) {
    const configPath = join(environmentsDirectory, `${config.name}.json`);
    const apiResponse = fetchGitHubEnvironment(repository, config.name);
    const live = parseGitHubEnvironmentApiResponse(apiResponse);
    const issues = compareGitHubEnvironmentToConfig(config, live);

    results.push({ environment: config.name, configPath, issues });

    if (issues.length === 0) {
      console.log(`  ${config.name}: OK`);
      continue;
    }

    console.error(`  ${config.name}: drift detected (${issues.length} issue(s))`);
    for (const issue of issues) {
      console.error(`    - ${issue.detail}`);
    }
  }

  console.log('');
  return results;
}

function printUsage(): void {
  console.log('Usage: pnpm validate:github-environments [--check]');
  console.log('');
  console.log('  --check   Compare .github/environments/*.json vs GitHub API (default)');
  console.log('  SKIP_GITHUB_ENV=1   Skip API calls');
}

function parseCommandLineArguments(): 'check' {
  const argumentsList = process.argv.slice(2);

  if (argumentsList.includes('--help') || argumentsList.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  if (argumentsList.length === 0 || argumentsList.includes('--check')) {
    return 'check';
  }

  throw new Error(`Unknown argument(s): ${argumentsList.join(' ')}. Use --check or --help.`);
}

export function main(): void {
  const command = parseCommandLineArguments();
  if (command !== 'check') {
    throw new Error(`Unsupported command: ${command}`);
  }

  const skipGitHub = process.env.SKIP_GITHUB_ENV === '1' || process.env.SKIP_GITHUB_ENV === 'true';
  if (skipGitHub) {
    console.log('SKIP_GITHUB_ENV set — skipping GitHub environment protection drift check.');
    process.exit(0);
  }

  const results = validateGitHubEnvironmentsDrift();

  if (!driftResultsHaveIssues(results)) {
    console.log('GitHub environment protection: OK (committed config matches GitHub UI).');
    process.exit(0);
  }

  console.error(
    'GitHub environment protection drift: update GitHub UI or edit .github/environments/*.json so they match.',
  );
  console.error('See docs/deployment/github-production-environment.md');
  process.exit(1);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  main();
}
