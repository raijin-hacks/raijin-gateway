import { describe, expect, it, vi } from 'vitest';
import cases from './cases.json';
import mandates from './mandates.json';
import { runPaper } from './runner';
import { createInjectedJudge, createStubJudge } from '../../apps/gateway/src/judge/index';

const output = (decision: string) => ({ decision, reasons: ['JUDGE_OVER_SCOPED'], explanation: 'Test.', injection_suspected: false });
describe('paper scoring', () => {
  it('scores observed decisions, excludes routing from judge metrics and never certifies stubs', async () => {
    const report = await runPaper(createStubJudge('stub-approve'), mandates, cases, 'stub-approve', null);
    expect(report.judge).toMatchObject({ legitimate_total: 9, off_task_total: 9, legitimate_approved: 9, off_task_approved: 9 });
    expect(report.paper_system_simulation.off_task_caught).toBe(1);
    expect(report.checkpoint.status).toBe('unmeasured');
  });
  it('separates escalation burden and denial while enforcing the specified checkpoint', async () => {
    const provider = { judge: vi.fn(async () => output('escalate')) };
    const report = await runPaper(createInjectedJudge(provider), mandates, cases, 'real', 'test');
    expect(provider.judge).toHaveBeenCalledTimes(18);
    expect(report.judge).toMatchObject({ legitimate_escalated: 9, legitimate_denied: 0, off_task_escalated: 9 });
    expect(report.checkpoint.status).toBe('passed'); // Exposes the design's permissive escalation criterion.
    expect(report.paper_system_simulation.legitimate_escalated).toBe(10);
  });
  it('reports a failed observed checkpoint instead of trusting expectations', async () => {
    const report = await runPaper(createStubJudge('stub-approve'), mandates, cases, 'real', 'test');
    expect(report.checkpoint.status).toBe('failed');
  });
  it('does not score failures as successful attack blocks or legitimate approvals', async () => {
    const provider = { judge: vi.fn(async () => { throw new Error('SECRET'); }) };
    const report = await runPaper(createInjectedJudge(provider), mandates, cases, 'real', 'test');
    expect(report.judge.errors).toBe(18);
    expect(report.paper_system_simulation.off_task_caught).toBe(1);
    expect(report.checkpoint.status).toBe('unmeasured');
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });
  it('validates fixtures before any provider call', async () => {
    const provider = { judge: vi.fn(async () => output('approve')) };
    await expect(runPaper(createInjectedJudge(provider), mandates, [], 'real', 'test')).rejects.toThrow();
    expect(provider.judge).not.toHaveBeenCalled();
  });
});
