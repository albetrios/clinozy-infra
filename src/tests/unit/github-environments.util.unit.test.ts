import { describe, expect, it } from 'vitest';
import {
  compareGitHubEnvironmentToConfig,
  driftResultsHaveIssues,
  parseGitHubEnvironmentApiResponse,
  type GitHubEnvironmentConfig,
} from '@setup/github/environments-util.js';

describe('github-environments.util', () => {
  it('parses required reviewers and deployment branch policy from GitHub API response', () => {
    const live = parseGitHubEnvironmentApiResponse({
      protection_rules: [
        {
          type: 'required_reviewers',
          prevent_self_review: false,
          reviewers: [
            { type: 'User', reviewer: { login: 'ReleaseManager' } },
            { type: 'Team', reviewer: { slug: 'platform' } },
          ],
        },
      ],
      deployment_branch_policy: {
        protected_branches: true,
        custom_branch_policies: false,
      },
    });

    expect(live.reviewers.users).toEqual(['releasemanager']);
    expect(live.reviewers.teams).toEqual(['platform']);
    expect(live.reviewers.preventSelfReview).toBe(false);
    expect(live.deploymentBranchPolicy).toEqual({
      protectedBranches: true,
      customBranchPolicies: false,
    });
  });

  it('reports no drift when config matches GitHub UI', () => {
    const config: GitHubEnvironmentConfig = {
      name: 'production',
      protection: {
        requiredReviewers: {
          users: ['ReleaseManager'],
          teams: ['platform'],
          preventSelfReview: false,
        },
        deploymentBranchPolicy: {
          protectedBranches: true,
          customBranchPolicies: false,
        },
      },
    };

    const live = parseGitHubEnvironmentApiResponse({
      protection_rules: [
        {
          type: 'required_reviewers',
          prevent_self_review: false,
          reviewers: [
            { type: 'User', reviewer: { login: 'releasemanager' } },
            { type: 'Team', reviewer: { slug: 'Platform' } },
          ],
        },
      ],
      deployment_branch_policy: {
        protected_branches: true,
        custom_branch_policies: false,
      },
    });

    expect(compareGitHubEnvironmentToConfig(config, live)).toEqual([]);
  });

  it('detects reviewers missing in GitHub UI', () => {
    const config: GitHubEnvironmentConfig = {
      name: 'production',
      protection: {
        requiredReviewers: {
          users: ['nikunjmavani'],
          teams: [],
        },
      },
    };

    const issues = compareGitHubEnvironmentToConfig(config, {
      reviewers: { users: [], teams: [] },
    });

    expect(issues.some((issue) => issue.kind === 'missing_in_github')).toBe(true);
    expect(issues.some((issue) => issue.detail.includes('nikunjmavani'))).toBe(true);
  });

  it('detects extra reviewers in GitHub UI', () => {
    const config: GitHubEnvironmentConfig = {
      name: 'production',
      protection: {
        requiredReviewers: {
          users: ['nikunjmavani'],
          teams: [],
        },
      },
    };

    const issues = compareGitHubEnvironmentToConfig(config, {
      reviewers: { users: ['nikunjmavani', 'other-reviewer'], teams: [] },
    });

    expect(issues.some((issue) => issue.kind === 'extra_in_github')).toBe(true);
    expect(issues.some((issue) => issue.detail.includes('other-reviewer'))).toBe(true);
  });

  it('aggregates drift across environments', () => {
    expect(
      driftResultsHaveIssues([
        { environment: 'production', configPath: 'production.json', issues: [] },
        {
          environment: 'development',
          configPath: 'development.json',
          issues: [{ kind: 'mismatch', environment: 'development', detail: 'example' }],
        },
      ]),
    ).toBe(true);
  });
});
