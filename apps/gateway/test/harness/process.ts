// Runs a gateway entry point (main.ts, seed-cli.ts) as a real child process through tsx,
// with only the environment the test gives it.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { onTestFinished as globalOnTestFinished } from 'vitest';

const GATEWAY_DIR = fileURLToPath(new URL('../..', import.meta.url));

/**
 * In concurrent tests, pass the test context's `onTestFinished`: the global one can attach to
 * whichever test happens to be current, and would kill another test's process.
 */
export function runScript(
  script: string,
  env: Record<string, string>,
  onTestFinished: (fn: () => void) => void = globalOnTestFinished,
) {
  const child = spawn(process.execPath, ['--import', 'tsx', script], {
    cwd: GATEWAY_DIR,
    env: { PATH: process.env.PATH ?? '', ...env },
  });
  onTestFinished(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });

  const lines: Record<string, unknown>[] = [];
  let stdout = '';
  let stderr = '';
  const waiters: (() => void)[] = [];
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    const complete = stdout.split('\n');
    stdout = complete.pop() ?? '';
    for (const line of complete) {
      if (line.startsWith('{')) lines.push(JSON.parse(line) as Record<string, unknown>);
    }
    for (const wake of waiters.splice(0)) wake();
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));

  return {
    child,
    lines,
    stderr: () => stderr,
    exited,
    /** Resolves with the first JSON log line whose `msg` is `msg`. */
    async waitForLog(msg: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        const found = lines.find((line) => line.msg === msg);
        if (found) return found;
        if (child.exitCode !== null) {
          throw new Error(`Process exited (${child.exitCode}) before "${msg}": ${stderr}`);
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error(`Timed out waiting for "${msg}": ${stderr}`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remaining);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
          child.once('exit', () => resolve());
        });
      }
    },
  };
}
