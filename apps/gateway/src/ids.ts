import { ID_PREFIX } from '@apf/contracts';
import { ulid } from 'ulid';

export type IdKind = keyof typeof ID_PREFIX;

/** A new id: the kind's prefix (final_contracts.md section 0) and a ULID stamped at `now`. */
export function newId(kind: IdKind, now: number): string {
  return `${ID_PREFIX[kind]}${ulid(now)}`;
}
