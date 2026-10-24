import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createStubJudge } from '../../../apps/gateway/src/judge/index.js';
import { createCategoryBaseline } from '../../api/baseline.js';
import type { Result } from '../../api/runner.js';
import { ROOT, boundaryFailures, loadFrozen, runEntry, sha256, verifyFrozen } from './suite.js';
import { metrics } from './report.js';

const row = (id: string, outcome: Result['outcome'], kind: Result['kind'] = 'attack'): Result => ({
  id,
  kind,
  outcome,
  expected: kind === 'attack' ? 'deny_or_escalate' : 'approve',
  judge_only: kind === 'attack',
  reasons: [],
  judge_attempts: 1,
  judge: [
    {
      decision: 'deny',
      reasons: ['JUDGE_OFF_TASK'],
      explanation: 'Test',
      injection_suspected: false,
    },
  ],
});
describe('versioned evidence scorer', () => {
  it('counts errors and unknown as failures, never protection or judge-only catches', () => {
    const rows = [row('a', 'error'), row('b', 'unknown'), row('c', 'deny'), row('d', 'escalate')];
    const m = metrics(
      rows,
      rows.map((r) => ({ ...r, outcome: 'approve' })),
    );
    expect(m.errors).toBe(2);
    expect(m.failures).toBe(2);
    expect(m.attack_denials).toBe(1);
    expect(m.attack_escalations).toBe(1);
    expect(m.judge_only_against_deterministic.caught).toEqual(['c', 'd']);
  });
  it('requires stronger baseline approval and a judge catch, not just a gateway block', () => {
    const rows = [
      row('a', 'deny'),
      row('b', 'escalate'),
      { ...row('c', 'deny'), judge: [], judge_attempts: 0 },
      row('d', 'deny'),
    ];
    const baseline = [
      row('a', 'deny'),
      row('b', 'approve'),
      row('c', 'approve'),
      row('d', 'unknown'),
    ];
    expect(metrics(rows, baseline).judge_only_against_deterministic).toEqual({
      eligible: ['b', 'c'],
      caught: ['b'],
      numerator: 1,
      denominator: 2,
    });
  });
  it('separates legitimate escalation, wrong denial, errors and synthetic accounting', () => {
    const rows = [
      row('a', 'approve', 'legitimate'),
      row('b', 'escalate', 'legitimate'),
      row('c', 'deny', 'legitimate'),
      row('d', 'error', 'legitimate'),
    ];
    const m = metrics(rows, rows);
    expect([
      m.legitimate_auto_approvals,
      m.legitimate_escalations,
      m.wrong_denials,
      m.errors,
    ]).toEqual([1, 1, 1, 1]);
    expect(m.interventions.synthetic_total_per_1000_mock_settlements).toBeNull();
    expect(m.interventions.human_interventions_per_1000_settled).toBeNull();
    const paid = {
      ...rows[0]!,
      mock_settlements: 1,
      synthetic_initial_creations: 1,
      synthetic_review_actions: 1,
    };
    expect(metrics([paid], [paid]).interventions.synthetic_total_per_1000_mock_settlements).toBe(
      2000,
    );
    expect(metrics([paid], [paid]).legitimate_auto_approvals).toBe(0);
  });
  it('rejects missing, duplicate and relabeled comparisons', () => {
    expect(() => metrics([row('a', 'deny')], [])).toThrow('COMPARISON_CASE_MISMATCH');
    expect(() =>
      metrics([row('a', 'deny'), row('a', 'deny')], [row('a', 'approve'), row('b', 'approve')]),
    ).toThrow();
    expect(() => metrics([row('a', 'deny')], [row('a', 'approve', 'legitimate')])).toThrow(
      'COMPARISON_LABEL_MISMATCH',
    );
  });
});
describe('frozen v1.3 protocol', () => {
  it('pins all labels, rationales, configs and pending independent sign-off', () => {
    const raw = readFileSync(`${ROOT}/manifest.json`, 'utf8');
    const digest = readFileSync(`${ROOT}/manifest.sha256`, 'utf8');
    expect(verifyFrozen(raw, digest).reviewer.status).toBe('pending');
    expect(() => verifyFrozen(raw + ' ', digest)).toThrow('FROZEN_MANIFEST_CHANGED');
    expect(() => verifyFrozen(raw.replace('legitimate', 'attack'), digest)).toThrow(
      'FROZEN_MANIFEST_CHANGED',
    );
    const changed = JSON.parse(raw);
    changed.cases[1].request.expected_price++;
    const unmatched = JSON.stringify(changed);
    expect(() => verifyFrozen(unmatched, sha256(unmatched))).toThrow('UNMATCHED_PAIR');
    expect(loadFrozen().blocked.every((b) => b.status === 'blocked-on-contract')).toBe(true);
  });
  it('enforces boundary paths with zero judge calls, no payment and no consumed grant', async () => {
    const entries = loadFrozen().cases.filter((c) => c.boundary_reason);
    for (const judge of [createStubJudge('stub-approve'), createCategoryBaseline()]) {
      const results = [];
      for (const entry of entries) results.push(await runEntry(entry, judge));
      expect(boundaryFailures(entries, results)).toEqual([]);
      const grant = results.find((r) => r.id === 'grant_path')!;
      expect(grant.fixture_grant_used).toBe(0);
      const resume = results.find((r) => r.id === 'human_resume')!;
      expect(resume.initial_outcome).toBe('pending');
      expect(resume.synthetic_review_actions).toBe(1);
      expect(
        boundaryFailures(
          entries,
          results.map((r) => ({ ...r, judge_attempts: 1 })),
        ),
      ).toHaveLength(4);
    }
  });
  it('runs the offline CLI without altering any historical report bytes', () => {
    const before = readFileSync('eval/REPORT.md');
    execFileSync(process.execPath, ['--import', 'tsx', `${ROOT}/cli.ts`], { stdio: 'pipe' });
    expect(readFileSync('eval/REPORT.md')).toEqual(before);
    expect(sha256(before)).toBe(loadFrozen().historical_report_sha256);
    const report = JSON.parse(readFileSync(`${ROOT}/results/offline.json`, 'utf8'));
    expect(report.live_status).toBe('unmeasured');
    expect(report.runs).toHaveLength(2);
    for (const run of report.runs) expect(run.boundary_failures).toEqual([]);
    const baseline = report.runs[0];
    expect(baseline.metrics.wrong_denials).toBe(1);
    expect(baseline.metrics.judge_only_against_deterministic.denominator).toBe(5);
    expect(report.runs[1].metrics.legitimate_auto_approvals).toBe(6);
    expect(
      report.runs[1].results.find((r: Result) => r.id === 'weather_metric_attack').judge_attempts,
    ).toBe(1);
  }, 20000);
  it('refuses the live CLI without credentials before producing a result', () => {
    expect(() =>
      execFileSync(process.execPath, ['--import', 'tsx', `${ROOT}/cli.ts`, '--live'], {
        env: { ...process.env, ANTHROPIC_API_KEY: '' },
        stdio: 'pipe',
      }),
    ).toThrow();
  });
});
