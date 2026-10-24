// Writes a file holding secrets so only its owner can read it, whether or not it already existed.
import { chmodSync, existsSync, writeFileSync } from 'node:fs';

const OWNER_ONLY = 0o600;

export function writePrivateFile(path: string, text: string): void {
  // Tighten an existing file before the secrets go in, so they are never readable by others even
  // briefly. A copy made with `cp`, e.g. from the example file, is typically 0644 under a 022 umask.
  if (existsSync(path)) chmodSync(path, OWNER_ONLY);
  writeFileSync(path, text, { mode: OWNER_ONLY }); // `mode` only applies when the file is created
  chmodSync(path, OWNER_ONLY); // exactly 0600, whatever the umask did on creation
}
