import { CONTRACTS_VERSION } from '@apf/contracts';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('gateway scaffold', () => {
  it('serves /health', async () => {
    const res = await createApp().request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('resolves the contracts workspace package', () => {
    expect(CONTRACTS_VERSION).toBe('1.1');
  });
});
