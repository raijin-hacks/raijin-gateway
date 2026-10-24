import { TIMING } from '@apf/contracts';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG_PATH, loadConfig } from '../src/config.js';

const ADMIN_TOKEN = 'a-long-enough-admin-token';

/** The message loadConfig throws for `env`, or '' if it doesn't throw. */
function errorFor(env: Record<string, string>): string {
  try {
    loadConfig(env);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}

describe('loadConfig', () => {
  it('fills in defaults for everything but the admin token', () => {
    expect(loadConfig({ ADMIN_TOKEN })).toEqual({
      adminToken: ADMIN_TOKEN,
      databasePath: './gateway.db',
      catalogPath: DEFAULT_CATALOG_PATH,
      port: 4000,
      paymentsMode: 'mock',
      judgeMode: 'stub-escalate',
      standingGrants: false,
      paymentSigner: 'local',
      streamHeartbeatMs: TIMING.streamHeartbeatMs,
    });
  });

  it('reads every setting from the environment and ignores unrelated variables', () => {
    expect(
      loadConfig({
        ADMIN_TOKEN,
        DATABASE_PATH: '/tmp/x.db',
        CATALOG_PATH: '/tmp/catalog.json',
        PORT: '4999',
        PAYMENTS_MODE: 'real',
        JUDGE_MODE: 'stub-approve',
        STANDING_GRANTS: 'on',
        PAYMENT_SIGNER: 'cdp',
        CDP_SIGNER_ADDRESS: '0x432D4cEA07086049E9c2125348285A01c084Fe5B',
        WALLET_PRIVATE_KEY: 'not-ours-to-read',
      }),
    ).toEqual({
      adminToken: ADMIN_TOKEN,
      databasePath: '/tmp/x.db',
      catalogPath: '/tmp/catalog.json',
      port: 4999,
      paymentsMode: 'real',
      judgeMode: 'stub-approve',
      standingGrants: true,
      paymentSigner: 'cdp',
      cdpSignerAddress: '0x432D4cEA07086049E9c2125348285A01c084Fe5B',
      streamHeartbeatMs: TIMING.streamHeartbeatMs,
    });
  });

  it('refuses PAYMENT_SIGNER=cdp without a pinned CDP_SIGNER_ADDRESS', () => {
    expect(() => loadConfig({ ADMIN_TOKEN, PAYMENT_SIGNER: 'cdp' })).toThrow(/CDP_SIGNER_ADDRESS/);
  });

  it('refuses an unknown PAYMENT_SIGNER and a malformed CDP_SIGNER_ADDRESS', () => {
    expect(() => loadConfig({ ADMIN_TOKEN, PAYMENT_SIGNER: 'remote' })).toThrow(/PAYMENT_SIGNER/);
    expect(() =>
      loadConfig({ ADMIN_TOKEN, PAYMENT_SIGNER: 'cdp', CDP_SIGNER_ADDRESS: 'cdp-account' }),
    ).toThrow(/CDP_SIGNER_ADDRESS/);
  });

  it.each(['0', '65535'])('accepts PORT=%s', (PORT) => {
    expect(loadConfig({ ADMIN_TOKEN, PORT }).port).toBe(Number(PORT));
  });

  it('accepts an admin token of exactly 16 characters', () => {
    expect(loadConfig({ ADMIN_TOKEN: 'x'.repeat(16) }).adminToken).toHaveLength(16);
  });

  it.each([
    ['a missing admin token', {}, 'ADMIN_TOKEN'],
    ['a 15-character admin token', { ADMIN_TOKEN: 'x'.repeat(15) }, 'ADMIN_TOKEN'],
    ['an unknown payments mode', { ADMIN_TOKEN, PAYMENTS_MODE: 'live' }, 'PAYMENTS_MODE'],
    ['an unknown judge mode', { ADMIN_TOKEN, JUDGE_MODE: 'yolo' }, 'JUDGE_MODE'],
    ['an unknown standing-grants mode', { ADMIN_TOKEN, STANDING_GRANTS: 'yes' }, 'STANDING_GRANTS'],
    ['a port that is not a number', { ADMIN_TOKEN, PORT: 'http' }, 'PORT'],
    ['a fractional port', { ADMIN_TOKEN, PORT: '4000.5' }, 'PORT'],
    ['a negative port', { ADMIN_TOKEN, PORT: '-1' }, 'PORT'],
    ['a port above 65535', { ADMIN_TOKEN, PORT: '65536' }, 'PORT'],
    ['an empty database path', { ADMIN_TOKEN, DATABASE_PATH: '' }, 'DATABASE_PATH'],
    ['an empty catalog path', { ADMIN_TOKEN, CATALOG_PATH: '' }, 'CATALOG_PATH'],
  ])('refuses to start with %s, naming the variable', (_, env, variable) => {
    expect(errorFor(env)).toContain(variable);
  });

  it('names every bad variable at once', () => {
    const message = errorFor({ PORT: 'x', JUDGE_MODE: 'y' });
    for (const variable of ['ADMIN_TOKEN', 'PORT', 'JUDGE_MODE'])
      expect(message).toContain(variable);
  });

  it('never puts a value in its error message', () => {
    const message = errorFor({ ADMIN_TOKEN: 'tiny-secret', PAYMENTS_MODE: 'live-mode-value' });
    expect(message).not.toContain('tiny-secret');
    expect(message).not.toContain('live-mode-value');
  });
});
