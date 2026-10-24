// Subject normalization (section 3 ParamSpec rules). The gateway applies it when storing a
// mandate and when checking a subject param; the judge's input builder compares with it.
// Everyone must use this one function, or the same subject can match in one place and not another.

/** Trims and lowercases a subject value. */
export function normalizeSubject(value: string): string {
  return value.trim().toLowerCase();
}

/** Normalizes a mandate's subjects and drops repeats, keeping first-seen order. */
export function normalizeSubjects(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeSubject))];
}
