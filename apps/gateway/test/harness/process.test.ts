import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
import { spawn } from 'node:child_process';
import { runScript } from './process.js';

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(),
  });
}

beforeEach(() => vi.mocked(spawn).mockReset());

it('waits for drained stderr and final stdout after exit, for either entry point', async () => {
  for (const script of ['src/main.ts', 'src/db/seed-cli.ts']) {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const process = runScript(script, {}, () => undefined);
    const settled = vi.fn();
    void process.exited.then(settled);
    child.exitCode = 1;
    child.emit('exit', 1, null);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    child.stderr.write('Invalid catalog\n');
    child.stdout.write('{"msg":"final log"}\n');
    child.emit('close', 1, null);
    expect(await process.exited).toBe(1);
    expect(process.stderr()).toContain('Invalid catalog');
    expect(process.lines).toEqual([{ msg: 'final log' }]);
  }
});

it('lets a log waiter see output drained after exit', async () => {
  const child = fakeChild();
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const process = runScript('src/main.ts', {}, () => undefined);
  const log = process.waitForLog('final log');
  child.exitCode = 0;
  child.emit('exit', 0, null);
  child.stdout.write('{"msg":"final log"}\n');
  child.emit('close', 0, null);
  expect(await log).toEqual({ msg: 'final log' });
  expect(await process.exited).toBe(0);
});

it('reports a signal death instead of treating it as an expected non-zero exit', async () => {
  const child = fakeChild();
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const process = runScript('src/db/seed-cli.ts', {}, () => undefined);
  const log = process.waitForLog('ready');
  child.signalCode = 'SIGKILL';
  child.emit('exit', null, 'SIGKILL');
  child.emit('close', null, 'SIGKILL');
  await expect(process.exited).rejects.toThrow('Process killed by SIGKILL');
  await expect(log).rejects.toThrow('Process killed by SIGKILL');
});

it('reports spawn errors to both exit and log waiters', async () => {
  const child = fakeChild();
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const process = runScript('src/main.ts', {}, () => undefined);
  const log = process.waitForLog('ready');
  child.emit('error', new Error('spawn EAGAIN'));
  child.emit('close', -2, null);
  await expect(process.exited).rejects.toThrow('spawn EAGAIN');
  await expect(log).rejects.toThrow('spawn EAGAIN');
});
