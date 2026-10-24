import { describe, expect, it } from 'vitest';
import { normalizeSubject, normalizeSubjects } from '../src/index.js';

describe('normalizeSubject', () => {
  it.each([
    ['  Acme Corp ', 'acme corp'],
    ['\tGLOBEX\n', 'globex'],
    ['Initech  Labs', 'initech  labs'], // inner whitespace is kept
    ['ÜMBRELLA', 'ümbrella'],
    ['hooli', 'hooli'],
    ['   ', ''],
  ])('%j becomes %j', (input, output) => {
    expect(normalizeSubject(input)).toBe(output);
  });

  it('is idempotent', () => {
    for (const s of ['  Acme ', 'ÜMBRELLA', 'x']) {
      expect(normalizeSubject(normalizeSubject(s))).toBe(normalizeSubject(s));
    }
  });
});

describe('normalizeSubjects', () => {
  it('dedupes after normalizing, keeping first-seen order', () => {
    expect(normalizeSubjects(['Globex', ' acme', 'ACME', 'globex '])).toEqual(['globex', 'acme']);
  });

  it('returns an empty list for an empty list', () => {
    expect(normalizeSubjects([])).toEqual([]);
  });

  it('does not change its input', () => {
    const input = ['  B', 'a'];
    normalizeSubjects(input);
    expect(input).toEqual(['  B', 'a']);
  });
});
