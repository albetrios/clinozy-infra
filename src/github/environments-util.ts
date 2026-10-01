import { readFileSync, readdirSync } from 'node:fs';
import { targetPath } from '@setup/common/paths.js';
import { join } from 'node:path';
import { z } from 'zod';
import { omitUndefined } from '@setup/common/object.js';

const ENVIRONMENTS_DIRECTORY = targetPath('.github', 'environments');

const requiredReviewersSchema = z.object({
  users: z.array(z.string().min(1)).default([]),
  teams: z.array(z.string().min(1)).default([]),
  preventSelfReview: z.boolean().optional(),
});

const deploymentBranchPolicySchema = z.object({
  protectedBranches: z.boolean().optional(),
  customBranchPolicies: z.boolean().optional(),
});

const environmentProtectionSchema = z.object({
  requiredReviewers: requiredReviewersSchema.optional(),
  deploymentBranchPolicy: deploymentBranchPolicySchema.optional(),
});

export const githubEnvironmentConfigSchema = z.object({
  name: z.string().min(1),
  protection: environmentProtectionSchema.optional(),
});

export type GitHubEnvironmentConfig = z.infer<typeof githubEnvironmentConfigSchema>;

export type GitHubEnvironmentReviewerSets = {
  users: string[];
  teams: string[];
  preventSelfReview?: boolean;
};

export type GitHubEnvironmentDeploymentBranchPolicy = {
  protectedBranches?: boolean;
  customBranchPolicies?: boolean;
};

export type GitHubEnvironmentLiveState = {
  reviewers: GitHubEnvironmentReviewerSets;
  deploymentBranchPolicy?: GitHubEnvironmentDeploymentBranchPolicy;
};

export type GitHubEnvironmentDriftIssue =
  | { kind: 'missing_in_github'; environment: string; detail: string }
  | { kind: 'extra_in_github'; environment: string; detail: string }
  | { kind: 'mismatch'; environment: string; detail: string };

export type GitHubEnvironmentDriftResult = {
  environment: string;
  configPath: string;
  issues: GitHubEnvironmentDriftIssue[];
};

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function normalizeTeamSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

function sortedUniqueNormalized(values: string[], normalize: (value: string) => string): string[] {
  return [...new Set(values.map(normalize))].sort();
}

export function loadGitHubEnvironmentConfigs(
  environmentsDirectory = ENVIRONMENTS_DIRECTORY,
): GitHubEnvironmentConfig[] {
  const fileNames = readdirSync(environmentsDirectory)
    .filter((fileName) => fileName.endsWith('.json'))
    .sort();

  return fileNames.map((fileName) => {
    const filePath = join(environmentsDirectory, fileName);
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    return githubEnvironmentConfigSchema.parse(raw);
  });
}

export function parseGitHubEnvironmentApiResponse(
  apiResponse: unknown,
): GitHubEnvironmentLiveState {
  const response = apiResponse as {
    protection_rules?: Array<{
      type?: string;
      prevent_self_review?: boolean;
      reviewers?: Array<{
        type?: string;
        reviewer?: { login?: string; slug?: string };
      }>;
    }>;
    deployment_branch_policy?: {
      protected_branches?: boolean;
      custom_branch_policies?: boolean;
    } | null;
  };

  const requiredReviewersRule = response.protection_rules?.find(
    (rule) => rule.type === 'required_reviewers',
  );

  const users: string[] = [];
  const teams: string[] = [];

  for (const entry of requiredReviewersRule?.reviewers ?? []) {
    if (entry.type === 'User' && entry.reviewer?.login) {
      users.push(entry.reviewer.login);
    }
    if (entry.type === 'Team' && entry.reviewer?.slug) {
      teams.push(entry.reviewer.slug);
    }
  }

  return omitUndefined({
    reviewers: omitUndefined({
      users: sortedUniqueNormalized(users, normalizeLogin),
      teams: sortedUniqueNormalized(teams, normalizeTeamSlug),
      preventSelfReview: requiredReviewersRule?.prevent_self_review,
    }),
    deploymentBranchPolicy: response.deployment_branch_policy
      ? omitUndefined({
          protectedBranches: response.deployment_branch_policy.protected_branches,
          customBranchPolicies: response.deployment_branch_policy.custom_branch_policies,
        })
      : undefined,
  });
}

function compareStringSets(
  expected: string[],
  actual: string[],
  label: string,
  environment: string,
  missingKind: GitHubEnvironmentDriftIssue['kind'],
  extraKind: GitHubEnvironmentDriftIssue['kind'],
): GitHubEnvironmentDriftIssue[] {
  const issues: GitHubEnvironmentDriftIssue[] = [];
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);

  for (const value of expected) {
    if (!actualSet.has(value)) {
      issues.push({
        kind: missingKind,
        environment,
        detail: `${label} "${value}" in config but not in GitHub UI`,
      });
    }
  }

  for (const value of actual) {
    if (!expectedSet.has(value)) {
      issues.push({
        kind: extraKind,
        environment,
        detail: `${label} "${value}" in GitHub UI but not in config`,
      });
    }
  }

  return issues;
}

export function compareGitHubEnvironmentToConfig(
  config: GitHubEnvironmentConfig,
  live: GitHubEnvironmentLiveState,
): GitHubEnvironmentDriftIssue[] {
  const environment = config.name;
  const issues: GitHubEnvironmentDriftIssue[] = [];
  const protection = config.protection;

  if (!protection) {
    return issues;
  }

  if (protection.requiredReviewers) {
    const expectedUsers = sortedUniqueNormalized(
      protection.requiredReviewers.users,
      normalizeLogin,
    );
    const expectedTeams = sortedUniqueNormalized(
      protection.requiredReviewers.teams,
      normalizeTeamSlug,
    );

    issues.push(
      ...compareStringSets(
        expectedUsers,
        live.reviewers.users,
        'User',
        environment,
        'missing_in_github',
        'extra_in_github',
      ),
      ...compareStringSets(
        expectedTeams,
        live.reviewers.teams,
        'Team',
        environment,
        'missing_in_github',
        'extra_in_github',
      ),
    );

    if (
      protection.requiredReviewers.preventSelfReview !== undefined &&
      protection.requiredReviewers.preventSelfReview !== live.reviewers.preventSelfReview
    ) {
      issues.push({
        kind: 'mismatch',
        environment,
        detail: `preventSelfReview: config=${String(protection.requiredReviewers.preventSelfReview)} github=${String(live.reviewers.preventSelfReview)}`,
      });
    }

    if (
      expectedUsers.length + expectedTeams.length > 0 &&
      live.reviewers.users.length + live.reviewers.teams.length === 0
    ) {
      issues.push({
        kind: 'missing_in_github',
        environment,
        detail:
          'Required reviewers rule missing in GitHub — enable Settings → Environments → production → Required reviewers',
      });
    }
  }

  if (protection.deploymentBranchPolicy) {
    const expected = protection.deploymentBranchPolicy;
    const actual = live.deploymentBranchPolicy ?? {};

    if (
      expected.protectedBranches !== undefined &&
      expected.protectedBranches !== actual.protectedBranches
    ) {
      issues.push({
        kind: 'mismatch',
        environment,
        detail: `deploymentBranchPolicy.protectedBranches: config=${String(expected.protectedBranches)} github=${String(actual.protectedBranches)}`,
      });
    }

    if (
      expected.customBranchPolicies !== undefined &&
      expected.customBranchPolicies !== actual.customBranchPolicies
    ) {
      issues.push({
        kind: 'mismatch',
        environment,
        detail: `deploymentBranchPolicy.customBranchPolicies: config=${String(expected.customBranchPolicies)} github=${String(actual.customBranchPolicies)}`,
      });
    }
  }

  return issues;
}

export function driftResultsHaveIssues(results: GitHubEnvironmentDriftResult[]): boolean {
  return results.some((result) => result.issues.length > 0);
}
