import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadCatalog } from '../catalog/index.js';
import { FIXTURE_CATALOG_PATH } from '../../test/harness/db.js';
import { createDestinationVerifier, isPublicAddress } from './destination.js';

const signal = () => new AbortController().signal;
// The fixture catalog plus one HTTPS merchant: payments only contacts cataloged origins.
const tmp = mkdtempSync(join(tmpdir(), 'destination-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
function httpsCatalog() {
  const path = join(tmp, 'catalog.json');
  writeFileSync(
    path,
    readFileSync(FIXTURE_CATALOG_PATH, 'utf8').replace(
      'http://localhost:4102',
      'https://merchant.test',
    ),
  );
  return loadCatalog(path);
}
const verifier = (answers: { address: string; family: number }[]) =>
  createDestinationVerifier(httpsCatalog(), async () => answers);

describe('J2b address classification groundwork', () => {
  it.each([
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '100.64.0.1',
    '100.127.255.255',
    '127.0.0.1',
    '127.255.255.255',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.0.2.1',
    '192.31.196.1',
    '192.52.193.1',
    '192.88.99.1',
    '192.168.0.1',
    '192.175.48.1',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:8.8.8.8',
    '::127.0.0.1',
    '64:ff9b::7f00:1',
    '64:ff9b:1::1',
    '100::1',
    '100:0:0:1::1',
    '2001::1',
    '2001:2::1',
    '2001:db8::1',
    '2002:7f00:1::',
    '2620:4f:8000::1',
    '3fff::1',
    '5f00::1',
    'fc00::1',
    'fdff::1',
    'fe80::1',
    'ff02::1',
    'fe80::1%lo0',
    '2606:4700::1%lo0',
    '127.1',
    '0177.0.0.1',
    '0x7f000001',
    '2130706433',
    '',
    'example.com',
  ])('denies %s', (address) => expect(isPublicAddress(address)).toBe(false));

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '100.128.0.1',
    '172.15.255.255',
    '172.32.0.1',
    '192.169.0.1',
    '198.17.255.255',
    '198.20.0.1',
    '223.255.255.255',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '2a00:1450::1',
  ])('accepts public %s', (address) => expect(isPublicAddress(address)).toBe(true));
});

describe('J2b checked resolution groundwork (no merchant sockets)', () => {
  it.each([
    [],
    [{ address: '127.0.0.1', family: 4 }],
    [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ],
    [
      { address: '8.8.8.8', family: 4 },
      { address: '::ffff:808:808', family: 6 },
    ],
    [{ address: '8.8.8.8', family: 6 }],
    [{ address: 'not an IP', family: 4 }],
  ])('fails closed on the complete answer set %#', async (...answers) => {
    await expect(verifier(answers)('https://merchant.test/data', signal())).rejects.toMatchObject({
      code: 'TIER_0_DENIAL',
    });
  });

  it('checks all families and re-resolves for every future connection', async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce([
        { address: '8.8.8.8', family: 4 },
        { address: '2606:4700::1111', family: 6 },
      ])
      .mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
    const verify = createDestinationVerifier(httpsCatalog(), resolve);
    expect(await verify('https://merchant.test/data', signal())).toEqual({
      canonicalUrl: 'https://merchant.test/data',
      hostname: 'merchant.test',
      address: '8.8.8.8',
      family: 4,
    });
    await expect(verify('https://merchant.test/data', signal())).rejects.toMatchObject({
      code: 'TIER_0_DENIAL',
    });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('maps DNS errors to denial', async () => {
    const verify = createDestinationVerifier(httpsCatalog(), async () => {
      throw new Error('DNS failure');
    });
    await expect(verify('https://merchant.test/data', signal())).rejects.toMatchObject({
      code: 'TIER_0_DENIAL',
    });
  });

  it('bounds stalled DNS with the caller deadline', async () => {
    const resolve = vi.fn(() => new Promise<never>(() => undefined));
    const verify = createDestinationVerifier(httpsCatalog(), resolve);
    const controller = new AbortController();
    const result = verify('https://merchant.test/data', controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'TIER_0_DENIAL' });
  });

  it.each([
    'https://127.1/data',
    'https://0x7f000001/data',
    'https://2130706433/data',
    'https://[::ffff:7f00:1]/data',
    'https://8.8.8.8/data',
    'http://localhost:4199/data',
    'http://attacker.test/data',
    'https://user:pass@merchant.test/data',
  ])('denies %s without DNS', async (url) => {
    const resolve = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
    const verify = createDestinationVerifier(httpsCatalog(), resolve);
    await expect(verify(url, signal())).rejects.toMatchObject({ code: 'TIER_0_DENIAL' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('preserves the exact operator-bound HTTP loopback exception', async () => {
    expect(
      await verifier([
        { address: '127.0.0.1', family: 4 },
        { address: '::1', family: 6 },
      ])('http://localhost:4101/data', signal()),
    ).toMatchObject({ hostname: 'localhost', address: '127.0.0.1' });
    await expect(
      verifier([
        { address: '127.0.0.1', family: 4 },
        { address: '8.8.8.8', family: 4 },
      ])('http://localhost:4101/data', signal()),
    ).rejects.toMatchObject({ code: 'TIER_0_DENIAL' });
    await expect(
      verifier([{ address: '127.0.0.1', family: 4 }])('https://localhost/data', signal()),
    ).rejects.toMatchObject({ code: 'TIER_0_DENIAL' });
  });
});
