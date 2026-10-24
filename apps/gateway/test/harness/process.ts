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
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  const lines: Record<string, unknown>[] = [];
  let stdout = '';
  let stderr = '';
  const waiters = new Set<() => void>();
  const wakeWaiters = () => {
    for (const wake of [...waiters]) wake();
  };
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    const complete = stdout.split('\n');
    stdout = complete.pop() ?? '';
    for (const line of complete) {
      if (line.startsWith('{')) lines.push(JSON.parse(line) as Record<string, unknown>);
    }
    wakeWaiters();
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  // `exit` can precede data still buffered in the stdio pipes. Only `close` means
  // both output streams have drained; callers inspect stderr/logs after awaiting this.
  let closed = false;
  let failure: Error | undefined;
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', (code, signal) => {
      closed = true;
      if (signal) failure = new Error(`Process killed by ${signal}: ${stderr}`);
      if (code === null && !failure)
        failure = new Error(`Process closed without an exit code: ${stderr}`);
      if (failure) reject(failure);
      else resolve(code!);
      wakeWaiters();
    });
  });
  // A caller may be waiting for a log instead of awaiting exited yet.
  void exited.catch(() => undefined);

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
        if (closed) {
          if (failure) throw failure;
          throw new Error(`Process exited (${child.exitCode}) before "${msg}": ${stderr}`);
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error(`Timed out waiting for "${msg}": ${stderr}`);
        await new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            waiters.delete(wake);
            resolve();
          };
          const timer = setTimeout(wake, remaining);
          waiters.add(wake);
        });
      }
    },
  };
}
