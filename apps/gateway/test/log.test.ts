import { describe, expect, it, vi } from 'vitest';
import { stdoutSink } from '../src/log.js';
import { TestClock } from './harness/clock.js';
import { captureLogger } from './harness/log.js';

const TOKEN = 'Zx9_-'.repeat(8) + 'abc'; // 43 base64url characters, like a mandate token

describe('createLogger', () => {
  it.each(['info', 'warn', 'error'] as const)(
    'writes %s lines with the level, time and message',
    (level) => {
      const clock = new TestClock();
      const { log, records } = captureLogger({ clock });
      log[level]('something happened', { mandate_id: 'mnd_1' });
      expect(records()).toEqual([
        { level, at: clock.now(), msg: 'something happened', mandate_id: 'mnd_1' },
      ]);
    },
  );

  it('writes one JSON object per line', () => {
    const { log, lines } = captureLogger();
    log.info('first');
    log.info('second\nwith a newline');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).not.toContain('\n');
  });

  it.each([
    ['a Bearer header', 'Authorization: Bearer abc.def-123'],
    ['a lowercase bearer header', 'bearer xyz'],
    ['a 43-character token', `token=${TOKEN}`],
    ['a token at the start of a value', TOKEN],
  ])('redacts %s', (_, value) => {
    const { log, lines } = captureLogger();
    log.warn(value, { field: value, nested: { deeper: [value] } });
    expect(lines[0]).not.toContain(value.replace(/^.*?(bearer|Bearer|token=)\s?/, ''));
    expect(lines[0]).toContain('[redacted]');
  });

  it('redacts named secrets wherever they appear, including JSON-escaped', () => {
    const secret = 'admin"with\\quotes';
    const { log, lines } = captureLogger({ secrets: [secret, 'plain-admin-token'] });
    log.error(`leaked ${secret} and plain-admin-token twice: plain-admin-token`, { secret });
    expect(lines[0]).not.toContain('plain-admin-token');
    expect(lines[0]).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(lines[0]?.match(/\[redacted\]/g)?.length).toBe(4);
  });

  it('ignores an empty secret instead of redacting everything', () => {
    const { log, records } = captureLogger({ secrets: [''] });
    log.info('hello');
    expect(records()[0]?.msg).toBe('hello');
  });

  it.each([
    ['a 42-character string', 'a'.repeat(42)],
    ['a 44-character string', 'a'.repeat(44)],
    ['a ULID-based id', 'mnd_01JB7XK3ABCDEFGHJKMNPQRSTV'],
    ['a SHA-256 hex digest', 'f'.repeat(64)],
    ['a lowercase payee address', '0x1111111111111111111111111111111111111111'],
  ])('keeps %s readable', (_, value) => {
    const { log, records } = captureLogger();
    log.info('value', { value });
    expect(records()[0]?.value).toBe(value);
  });

  it('records errors by name and message, without a stack', () => {
    const { log, records } = captureLogger();
    log.error('boom', { error: new TypeError('bad thing') });
    expect(records()[0]?.error).toEqual({ name: 'TypeError', message: 'bad thing' });
  });
});

describe('stdoutSink', () => {
  it('writes each line to stdout with a newline', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stdoutSink.write('{"msg":"x"}');
    expect(write).toHaveBeenCalledWith('{"msg":"x"}\n');
    write.mockRestore();
  });
});
