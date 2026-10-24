import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStubJudge } from '../../../apps/gateway/src/judge/index.js';
import { createCategoryBaseline } from '../../api/baseline.js';
import type { Result } from '../../api/runner.js';
import { ROOT, loadFrozen, runEntry, sha256, verifyFrozen } from './suite.js';

describe('frozen heldout-v2 protocol', () => {
  it('pins labels, pages and pending independent sign-off', () => {
    const raw = readFileSync(`${ROOT}/manifest.json`, 'utf8');
    const digest = readFileSync(`${ROOT}/manifest.sha256`, 'utf8');
    const manifest = verifyFrozen(raw, digest);
    expect(manifest.reviewer.status).toBe('pending');
    expect(manifest.cases).toHaveLength(16);
    expect(Object.keys(manifest.pages)).toHaveLength(8);
    expect(() => verifyFrozen(raw + ' ', digest)).toThrow('FROZEN_MANIFEST_CHANGED');
    expect(() => verifyFrozen(raw.replace('legitimate', 'attack'), digest)).toThrow(
      'FROZEN_MANIFEST_CHANGED',
    );
    const changed = JSON.parse(raw);
    changed.cases[1].request.expected_price++;
    const unmatched = JSON.stringify(changed);
    expect(() => verifyFrozen(unmatched, sha256(unmatched))).toThrow('UNMATCHED_PAIR');
    const missingPage = JSON.parse(raw);
    delete missingPage.pages.press_attack;
    const missing = JSON.stringify(missingPage);
    expect(() => verifyFrozen(missing, sha256(missing))).toThrow('PAGE_NOT_AN_ATTACK');
  });

  it('runs stub and baseline without rewriting committed artifacts', async () => {
    const manifest = loadFrozen();
    const baseline = [];
    const stub = [];
    for (const entry of manifest.cases) {
      baseline.push(await runEntry(entry, createCategoryBaseline(), manifest.pages));
      stub.push(await runEntry(entry, createStubJudge('stub-approve'), manifest.pages));
    }
    expect(stub.every((r) => r.outcome === 'approve' && r.judge_attempts === 1)).toBe(true);
    const lookupAttacks = stub
      .filter((r) => r.kind === 'attack' && !r.id.startsWith('export_'))
      .map((r) => r.id);
    expect(lookupAttacks).toHaveLength(6);
    expect(baseline.filter((r) => lookupAttacks.includes(r.id) && r.outcome === 'approve')).toHaveLength(
      6,
    );
    expect(
      baseline.filter((r) => r.id.startsWith('export_') && r.outcome === 'deny'),
    ).toHaveLength(4);
  });

  it('runs the offline CLI without altering committed results', () => {
    const committed = readFileSync(`${ROOT}/results/offline.json`);
    const committedMd = readFileSync(`${ROOT}/results/offline.md`);
    const outDir = mkdtempSync(join(tmpdir(), 'heldout-v2-offline-'));
    execFileSync(process.execPath, ['--import', 'tsx', `${ROOT}/run.ts`, '--out-dir', outDir], {
      stdio: 'pipe',
    });
    expect(readFileSync(`${ROOT}/results/offline.json`)).toEqual(committed);
    expect(readFileSync(`${ROOT}/results/offline.md`)).toEqual(committedMd);
    const report = JSON.parse(readFileSync(`${outDir}/offline.json`, 'utf8'));
    expect(report.live_status).toBe('unmeasured');
    expect(report.model).toBeNull();
    expect(report.runs).toHaveLength(2);
    expect(report.runs[0].metrics.attack_denials).toBe(2);
    expect(report.runs[0].metrics.wrong_denials).toBe(2);
    expect(report.runs[0].metrics.judge_only_against_deterministic.denominator).toBe(6);
    expect(report.runs[1].metrics.attack_denials).toBe(0);
    expect(report.runs[1].metrics.legitimate_auto_approvals).toBe(8);
    expect(
      report.runs[1].results.find((r: Result) => r.id === 'press_attack').judge_attempts,
    ).toBe(1);
  }, 20000);

  it('refuses the live CLI without credentials before producing a result', () => {
    expect(() =>
      execFileSync(process.execPath, ['--import', 'tsx', `${ROOT}/run.ts`, '--live'], {
        env: { ...process.env, ANTHROPIC_API_KEY: '' },
        stdio: 'pipe',
      }),
    ).toThrow();
  });
});
