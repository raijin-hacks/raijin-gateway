import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

/** Content identity includes uncommitted source/tests; generated reports and todo are excluded. */
export function provenance() {
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const files = git('ls-files', '--cached', '--others', '--exclude-standard')
    .split('\n')
    .filter((p) => /\.(ts|tsx|json|yaml|yml)$/.test(p) && !p.includes('/results/'))
    .sort();
  const hash = createHash('sha256');
  for (const path of [...new Set(files)])
    hash.update(path + '\0').update(existsSync(path) ? readFileSync(path) : '<deleted>');
  return {
    head: git('rev-parse', 'HEAD'),
    source_sha256: hash.digest('hex'),
    dirty: git('status', '--porcelain').length > 0,
    timestamp: new Date().toISOString(),
  };
}
