import { describe, expect, it } from 'vitest';
import { judgeInputSchema } from './index';
import cases from '../../../eval/paper/cases.json';

const fixture = () => structuredClone(cases.find(c => c.id === 'L1')!.input!);
const invalidNumbers = [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1];

describe('chunk3 JudgeInput boundary', () => {
  const numericPaths = [
    ['mandate', 'budget_remaining'], ['mandate', 'expires_in_ms'],
    ['payment', 'price'], ['payment', 'payee', 'prior_calls'],
    ['payment', 'payee', 'recent_prices', '0'],
  ];

  it.each(numericPaths)('requires nonnegative safe integer facts at %j', (...path) => {
    for (const value of invalidNumbers) {
      const input = fixture();
      let parent: any = input;
      for (const key of path.slice(0, -1)) parent = parent[key];
      parent[path.at(-1)!] = value;
      expect(judgeInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it.each([0, Number.MAX_SAFE_INTEGER])('accepts numeric boundary %s', value => {
    const input = fixture();
    input.mandate.budget_remaining = value;
    input.mandate.expires_in_ms = value;
    input.payment.price = value;
    input.payment.payee.prior_calls = value;
    input.payment.payee.recent_prices = [value];
    expect(judgeInputSchema.parse(input)).toEqual(input);
  });

  it.each([
    [], ['mandate'], ['payment'], ['payment', 'merchant'],
    ['payment', 'endpoint'], ['payment', 'payee'], ['payment', 'params', '0'],
  ])('rejects extra fields at nesting path %j', (...path) => {
    const input = fixture();
    let target: any = input;
    for (const key of path) target = target[key];
    target.untrusted = 'CANARY_EXTRA_FIELD';
    expect(judgeInputSchema.safeParse(input).success).toBe(false);
  });

  it.each(['fetch_data', 'fetch_report', 'verify_access', 'subscribe', 'other'])('accepts purpose %s', purpose => {
    const input = fixture();
    expect(judgeInputSchema.safeParse({ ...input, payment: { ...input.payment, purpose } }).success).toBe(true);
  });

  it.each([
    { purpose: 'pay me' }, { price: '10000' },
    { endpoint: { known: true, method: 'DELETE', category: 'data', description: 'data' } },
    { merchant: { known: false, selected_for_mandate: true } },
    { payee: { first_seen: 'false', prior_calls: 0, recent_prices: [] } },
    { params: [{ name: 'secret', kind: 'forbidden', value: 'CANARY' }] },
    { params: [{ name: 'page', kind: 'option', value: 1 }] },
    { params: [{ name: 'extra', kind: 'undeclared' }] },
  ])('rejects invalid payment fact %# without coercion', payment => {
    const input = fixture();
    expect(judgeInputSchema.safeParse({ ...input, payment: { ...input.payment, ...payment } }).success).toBe(false);
  });

  it('allows omitted option values and bounded diagnostic URL shapes', () => {
    const input = fixture();
    const payment = { ...input.payment, params: [{ name: 'page', kind: 'option' }],
      url_shape: { path_segments: [0, 12], query_params: [{ type: 'int', length: 2 }] } };
    expect(judgeInputSchema.safeParse({ ...input, payment }).success).toBe(true);
    for (const url_shape of [
      { ...payment.url_shape, raw_url: 'CANARY_URL' },
      { path_segments: [-1], query_params: [] },
      { path_segments: [1.5], query_params: [] },
      { path_segments: [], query_params: [{ type: 'string', length: -1 }] },
      { path_segments: [], query_params: [{ type: 'float', length: 1 }] },
      { path_segments: [], query_params: [{ type: 'string', length: 1, name: 'CANARY_NAME' }] },
    ]) expect(judgeInputSchema.safeParse({ ...input, payment: { ...payment, url_shape } }).success).toBe(false);
  });

  it('permits unknown diagnostics in the shared schema; provider admission must reject them separately', () => {
    const input = fixture();
    expect(judgeInputSchema.safeParse({ ...input, payment: { ...input.payment,
      merchant: { known: false, selected_for_mandate: false },
      endpoint: { known: false, method: 'GET' },
    } }).success).toBe(true);
  });
});
