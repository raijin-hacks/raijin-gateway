import { TIMING } from '@apf/contracts';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG_PATH, loadConfig } from '../src/config.js';

const ADMIN_TOKEN = 'a-long-enough-admin-token';

describe('loadConfig', () => {
  it('fills in defaults for everything but the admin token', () => {
    expect(loadConfig({ ADMIN_TOKEN })).toEqual({
      adminToken: ADMIN_TOKEN,
      databasePath: './gateway.db',
      catalogPath: DEFAULT_CATALOG_PATH,
      port: 4000,
      paymentsMode: 'mock',
      judgeMode: 'stub-escalate',
      streamHeartbeatMs: TIMING.streamHeartbeatMs,
    });
  });

  it('reads every setting from the environment', () => {
    expect(
      loadConfig({
        ADMIN_TOKEN,
        DATABASE_PATH: '/tmp/x.db',
        CATALOG_PATH: '/tmp/catalog.json',
        PORT: '4999',
        PAYMENTS_MODE: 'real',
        JUDGE_MODE: 'real',
      }),
    ).toMatchObject({
      databasePath: '/tmp/x.db',
      catalogPath: '/tmp/catalog.json',
      port: 4999,
      paymentsMode: 'real',
      judgeMode: 'real',
    });
  });

  it.each([
    ['a missing admin token', {}, /ADMIN_TOKEN/],
    ['a short admin token', { ADMIN_TOKEN: 'short' }, /ADMIN_TOKEN/],
    ['an unknown payments mode', { ADMIN_TOKEN, PAYMENTS_MODE: 'live' }, /PAYMENTS_MODE/],
    ['an unknown judge mode', { ADMIN_TOKEN, JUDGE_MODE: 'yolo' }, /JUDGE_MODE/],
    ['a port that is not a number', { ADMIN_TOKEN, PORT: 'http' }, /PORT/],
  ])('refuses to start with %s', (_, env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });

  it('never puts the admin token in its error messages', () => {
    let message = '';
    try {
      loadConfig({ ADMIN_TOKEN: 'tiny-secret' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/ADMIN_TOKEN/);
    expect(message).not.toContain('tiny-secret');
  });
});
