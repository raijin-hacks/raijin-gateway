import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { PayRequestSchema, type PayRequest } from '@apf/contracts';

/**
 * Durable purchase intents for the demo agent (A19). An intent's idempotency key is written
 * to disk before the first POST /pay, so a crash or restart resumes the same logical purchase
 * instead of minting a new key. The journal never holds the mandate token or any other secret:
 * entries are scoped by a one-way fingerprint of the token and contain only the PayRequest.
 *
 * Failure policy: a missing journal starts empty; anything unreadable, malformed or of an unknown
 * version fails closed (JOURNAL_CORRUPT) rather than silently starting fresh, because starting
 * fresh is exactly what would mint a second key for an in-flight purchase.
 */

const VERSION = 1;
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10000;
const MAX_ENTRIES = 1024;

const EntrySchema = z.strictObject({
  mandate: z.string().regex(/^[0-9a-f]{64}$/),
  request: PayRequestSchema,
  created_at: z.number().int().nonnegative(),
});
const FileSchema = z.strictObject({
  version: z.literal(VERSION),
  entries: z.record(z.string(), EntrySchema),
});
type Entry = z.infer<typeof EntrySchema>;
type JournalFile = z.infer<typeof FileSchema>;

export type Intent = Omit<PayRequest, 'idempotency_key'>;

export class JournalError extends Error {
  constructor(
    public readonly code: 'JOURNAL_CORRUPT' | 'JOURNAL_LOCKED' | 'JOURNAL_FULL' | 'JOURNAL_WRITE',
  ) {
    super(code);
    this.name = 'JournalError';
  }
}

/** One-way, scoped fingerprint: lets one journal serve several mandates without storing tokens. */
export function mandateFingerprint(token: string): string {
  return createHash('sha256').update('apf-agent-journal-v1\0').update(token).digest('hex');
}

/** Identity of one logical purchase: same mandate and same request arguments. */
export function intentIdentity(mandate: string, intent: Intent): string {
  return createHash('sha256')
    .update(
      JSON.stringify([mandate, intent.url, intent.method, intent.expected_price, intent.purpose]),
    )
    .digest('hex');
}

function sleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function createJournal(path: string, clock: () => number = () => Date.now()) {
  const lockPath = `${path}.lock`;

  function read(): JournalFile {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: VERSION, entries: {} };
      throw new JournalError('JOURNAL_CORRUPT');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new JournalError('JOURNAL_CORRUPT');
    }
    const result = FileSchema.safeParse(parsed);
    if (!result.success) throw new JournalError('JOURNAL_CORRUPT');
    // Two identities must never share a key: a duplicate means tampering or a bug.
    const keys = Object.values(result.data.entries).map((e) => e.request.idempotency_key);
    if (new Set(keys).size !== keys.length) throw new JournalError('JOURNAL_CORRUPT');
    return result.data;
  }

  function write(file: JournalFile) {
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, 'wx', 0o600);
      writeSync(fd, JSON.stringify(file, null, 2) + '\n');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, path);
    } catch {
      if (fd !== undefined) closeSync(fd);
      rmSync(temp, { force: true });
      throw new JournalError('JOURNAL_WRITE');
    }
  }

  /** Cross-process mutual exclusion around read-modify-write, so concurrent agents agree on keys. */
  function withLock<T>(work: () => T): T {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Real time, not the injected clock: lock waits must progress even under a frozen test clock.
    const deadline = Date.now() + LOCK_WAIT_MS;
    let fd: number | undefined;
    for (;;) {
      try {
        fd = openSync(lockPath, 'wx', 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
          throw new JournalError('JOURNAL_WRITE');
        try {
          // A lock older than the stale bound belongs to a crashed holder; the critical section is ms.
          if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
            rmSync(lockPath, { force: true });
            continue;
          }
        } catch {
          continue; // removed between our open and stat; try again
        }
        if (Date.now() > deadline) throw new JournalError('JOURNAL_LOCKED');
        sleep(10);
      }
    }
    try {
      return work();
    } finally {
      closeSync(fd);
      rmSync(lockPath, { force: true });
    }
  }

  return Object.freeze({
    path,
    /**
     * Returns the durable PayRequest for this intent: the journaled one if it exists (same key,
     * same body), otherwise a new one that is persisted before it is returned. Callers must not
     * send a request this function has not returned.
     */
    intent(token: string, intent: Intent): PayRequest {
      const mandate = mandateFingerprint(token);
      const id = intentIdentity(mandate, intent);
      return withLock(() => {
        const file = read();
        const existing: Entry | undefined = file.entries[id];
        if (existing) {
          if (existing.mandate !== mandate) throw new JournalError('JOURNAL_CORRUPT');
          return existing.request;
        }
        if (Object.keys(file.entries).length >= MAX_ENTRIES) throw new JournalError('JOURNAL_FULL');
        const request = PayRequestSchema.parse({ ...intent, idempotency_key: randomUUID() });
        file.entries[id] = { mandate, request, created_at: clock() };
        write(file);
        return request;
      });
    },
    /** Journaled intents for this mandate, for resuming after a restart. */
    pending(token: string): PayRequest[] {
      const mandate = mandateFingerprint(token);
      return withLock(() =>
        Object.values(read().entries)
          .filter((entry) => entry.mandate === mandate)
          .map((entry) => entry.request),
      );
    },
  });
}

export type Journal = ReturnType<typeof createJournal>;
