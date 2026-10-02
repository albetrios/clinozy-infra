/**
 * This repo's own `main` protection (`.github/rulesets/main.json`, applied by
 * `pnpm github:rulesets:self`) matches the apps' rules — and every status check it requires is a
 * job CI actually runs, so renaming that job can't leave every pull request unmergeable.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toolPath } from '@setup/common/paths.js';
import { loadLocalRulesets } from '@setup/github/rulesets.js';

interface Rule {
  readonly type: string;
  readonly parameters?: Record<string, unknown>;
}

const [mainRuleset] = loadLocalRulesets(toolPath('.github', 'rulesets'));
const rules = (mainRuleset?.payload.rules ?? []) as Rule[];
const rule = (type: string): Rule | undefined => rules.find((candidate) => candidate.type === type);

/** Check contexts CI reports: each job's `name:`, or its id when it has none. */
function ciCheckContexts(): string[] {
  const lines = readFileSync(toolPath('.github', 'workflows', 'ci.yml'), 'utf8').split('\n');
  const contexts: string[] = [];
  let inJobs = false;
  let jobId: string | undefined;
  let jobName: string | undefined;
  const flush = () => {
    if (jobId) contexts.push(jobName ?? jobId);
  };
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(line)) break;
    const job = line.match(/^ {2}([\w-]+):\s*$/);
    if (job) {
      flush();
      jobId = job[1];
      jobName = undefined;
      continue;
    }
    const name = line.match(/^ {4}name:\s*['"]?(.+?)['"]?\s*$/);
    if (name && jobId && jobName === undefined) jobName = name[1];
  }
  flush();
  return contexts;
}

describe("clinozy-infra's main ruleset", () => {
  it('protects main and only main, actively', () => {
    expect(mainRuleset?.name).toBe('Protect main');
    expect(mainRuleset?.payload.enforcement).toBe('active');
    expect(mainRuleset?.payload.conditions).toEqual({
      ref_name: { include: ['refs/heads/main'], exclude: [] },
    });
  });

  it('has the same kind of rules as the apps: no deletion, no force-push, linear, squash-only', () => {
    expect(rules.map((candidate) => candidate.type)).toEqual([
      'deletion',
      'non_fast_forward',
      'required_linear_history',
      'pull_request',
      'required_status_checks',
    ]);
    expect(rule('pull_request')?.parameters).toMatchObject({
      allowed_merge_methods: ['squash'],
      required_review_thread_resolution: true,
    });
  });

  it('requires only checks that CI runs', () => {
    const checks = (rule('required_status_checks')?.parameters?.required_status_checks ?? []) as {
      context: string;
    }[];
    const required = checks.map((check) => check.context);
    expect(required.length).toBeGreaterThan(0);
    for (const context of required) expect(ciCheckContexts()).toContain(context);
  });
});
