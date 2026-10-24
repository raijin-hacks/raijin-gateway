import { describe, expect, it } from 'vitest';
import { createMandateRepo } from '../../src/db/repos/mandates.js';
import { DEMO } from '../../src/db/seed.js';
import {
  count,
  createGrant,
  createMandate,
  createSession,
  one,
  seededDb,
  type TestMandate,
} from '../harness/db.js';

const HASH = 'a'.repeat(64);

function setup() {
  const { db, clock } = seededDb();
  return { db, clock, repo: createMandateRepo(db) };
}

const statusOf = (db: ReturnType<typeof setup>['db'], table: string, id: string) =>
  one<{ status: string }>(db, `SELECT status FROM ${table} WHERE id = ?`, id)?.status;

describe('createMandateRepo', () => {
  it('finds an agent, or nothing', () => {
    const { repo } = setup();
    expect(repo.findAgent(DEMO.agents.pricing)).toMatchObject({ role_id: DEMO.roles.research });
    expect(repo.findAgent('agt_nobody')).toBeUndefined();
  });

  it('creates a mandate and its session together, with the given values', () => {
    const { db, clock, repo } = setup();
    const ids = repo.create({
      tenantId: DEMO.tenantId,
      agentId: DEMO.agents.pricing,
      task: 'task',
      subjects: ['acme'],
      allowedMerchantIds: ['mer_pricing'],
      budget: 5,
      expiresAt: clock.now() + 1,
      tokenHash: HASH,
      createdBy: 'admin',
      sessionTrust: 63.5,
      now: clock.now(),
    });
    expect(
      one(
        db,
        'SELECT budget, spent, reserved, token_hash FROM mandates WHERE id = ?',
        ids.mandateId,
      ),
    ).toEqual({
      budget: 5,
      spent: 0,
      reserved: 0,
      token_hash: HASH,
    });
    expect(one(db, 'SELECT mandate_id, trust FROM sessions WHERE id = ?', ids.sessionId)).toEqual({
      mandate_id: ids.mandateId,
      trust: 63.5,
    });
  });

  it('creates nothing if the session cannot be created', () => {
    const { db, clock, repo } = setup();
    expect(() =>
      repo.create({
        tenantId: DEMO.tenantId,
        agentId: 'agt_nobody',
        task: 'task',
        subjects: [],
        allowedMerchantIds: [],
        budget: 5,
        expiresAt: clock.now() + 1,
        tokenHash: HASH,
        createdBy: 'admin',
        sessionTrust: 70,
        now: clock.now(),
      }),
    ).toThrow(/FOREIGN KEY/);
    expect(count(db, 'mandates')).toBe(0);
  });

  describe('findActiveByTokenHash', () => {
    it('returns the mandate and its newest session', () => {
      const { db, clock, repo } = setup();
      const { mandateId } = createMandate(db, clock, { budget: 1, tokenHash: HASH });
      clock.advance(1_000);
      const newer = createSession(db, clock, mandateId);
      const found = repo.findActiveByTokenHash(HASH, clock.now());
      expect(found?.mandate.id).toBe(mandateId);
      expect(found?.session.id).toBe(newer);
    });

    it('still returns a quarantined session (the pipeline denies it)', () => {
      const { db, clock, repo } = setup();
      const { sessionId } = createMandate(db, clock, { budget: 1, tokenHash: HASH });
      db.sqlite.prepare("UPDATE sessions SET status = 'quarantined' WHERE id = ?").run(sessionId);
      expect(repo.findActiveByTokenHash(HASH, clock.now())?.session.status).toBe('quarantined');
    });

    it.each([
      ['an unknown hash', () => ({ hash: 'b'.repeat(64) })],
      ['a closed mandate', () => ({ status: 'closed' as const })],
      ['an expired-status mandate', () => ({ status: 'expired' as const })],
    ])('returns null for %s', (_, make) => {
      const { db, clock, repo } = setup();
      const opts = make();
      createMandate(db, clock, { budget: 1, tokenHash: HASH, ...('status' in opts ? opts : {}) });
      expect(repo.findActiveByTokenHash('hash' in opts ? opts.hash : HASH, clock.now())).toBeNull();
    });

    it('returns null at and after the expiry instant', () => {
      const { db, clock, repo } = setup();
      createMandate(db, clock, { budget: 1, tokenHash: HASH, expiresInMs: 1_000 });
      expect(repo.findActiveByTokenHash(HASH, clock.now() + 999)).not.toBeNull();
      expect(repo.findActiveByTokenHash(HASH, clock.now() + 1_000)).toBeNull();
    });

    it('returns null for a mandate with no session', () => {
      const { db, clock, repo } = setup();
      const { mandateId } = createMandate(db, clock, { budget: 1, tokenHash: HASH });
      db.sqlite.prepare('DELETE FROM sessions WHERE mandate_id = ?').run(mandateId);
      expect(repo.findActiveByTokenHash(HASH, clock.now())).toBeNull();
    });
  });

  describe('close', () => {
    const withGrant = (s: ReturnType<typeof setup>, m: TestMandate) =>
      createGrant(s.db, s.clock, m, { maxTotal: 100 });

    it('closes, deletes grants and ends the active session', () => {
      const s = setup();
      const m = createMandate(s.db, s.clock, { budget: 1 });
      withGrant(s, m);
      expect(s.repo.close(m.mandateId)).toBe(true);
      expect(statusOf(s.db, 'mandates', m.mandateId)).toBe('closed');
      expect(statusOf(s.db, 'sessions', m.sessionId)).toBe('ended');
      expect(count(s.db, 'grants')).toBe(0);
    });

    it('keeps a quarantined session marked quarantined', () => {
      const s = setup();
      const m = createMandate(s.db, s.clock, { budget: 1 });
      s.db.sqlite
        .prepare("UPDATE sessions SET status = 'quarantined' WHERE id = ?")
        .run(m.sessionId);
      s.repo.close(m.mandateId);
      expect(statusOf(s.db, 'sessions', m.sessionId)).toBe('quarantined');
    });

    it('leaves an expired-status mandate expired, but still deletes its grants', () => {
      const s = setup();
      const m = createMandate(s.db, s.clock, { budget: 1, status: 'expired' });
      withGrant(s, m);
      expect(s.repo.close(m.mandateId)).toBe(true);
      expect(statusOf(s.db, 'mandates', m.mandateId)).toBe('expired');
      expect(count(s.db, 'grants')).toBe(0);
    });

    it('returns false for an unknown mandate', () => {
      expect(setup().repo.close('mnd_missing')).toBe(false);
    });
  });
});
