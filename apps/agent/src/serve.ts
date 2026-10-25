import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAnthropicModel, isLiveModel } from './anthropic.js';
import { createJournal } from './journal.js';
import { findPage, loadPages, purchaseHash } from './pages.js';
import { runCompromised, runLive, type WorkerProfile } from './profiles.js';
import { boundedText, createTools, type Purchase } from './tools.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.AGENT_LAB_PORT || 4010);
const MAX_RUNS = 3;
const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:4000';

type LabEvent =
  | { type: 'log'; text: string }
  | { type: 'hash'; hash: string; purchase: Purchase }
  | { type: 'payment'; status: string }
  | { type: 'done'; answer?: string }
  | { type: 'error'; message: string };

type Run = {
  id: string;
  profile: WorkerProfile;
  page: string;
  hash: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  events: LabEvent[];
  clients: Set<ServerResponse>;
  stop: () => void;
};

const runs = new Map<string, Run>();

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > 16000) {
        req.destroy();
        reject(new Error('BODY_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function emit(run: Run, event: LabEvent) {
  run.events.push(event);
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of run.clients) client.write(line);
}

function redact(runSecrets: string[], line: string) {
  return boundedText(line, runSecrets);
}

function startRun(input: {
  token: string;
  task: string;
  page: string;
  profile: WorkerProfile;
  model?: string;
}): Run {
  const page = findPage(input.page);
  const hash = purchaseHash(page.intended_purchase);
  const id = randomUUID();
  const abort = new AbortController();
  const secrets = [input.token, process.env.ANTHROPIC_API_KEY ?? ''];
  const run: Run = {
    id,
    profile: input.profile,
    page: page.id,
    hash,
    status: 'running',
    events: [],
    clients: new Set(),
    stop: () => abort.abort(),
  };
  runs.set(id, run);

  const journal = createJournal(join('.agent-state/lab', `${id}.json`));
  const inner = createTools({
    gateway: GATEWAY,
    token: input.token,
    journal,
    trace: (line) => emit(run, { type: 'log', text: redact(secrets, line) }),
  });
  const tools = {
    fetch_url: inner.fetch_url,
    resume: inner.resume,
    async paid_fetch(purchase: Purchase) {
      emit(run, { type: 'hash', hash: purchaseHash(purchase), purchase });
      const result = await inner.paid_fetch(purchase);
      emit(run, { type: 'payment', status: result.status });
      return result;
    },
  };

  void (async () => {
    try {
      if (input.profile === 'compromised') {
        emit(run, { type: 'hash', hash, purchase: page.intended_purchase });
        const result = await runCompromised(
          page.id,
          tools,
          (line) => {
            emit(run, { type: 'log', text: redact(secrets, line) });
          },
          abort.signal,
        );
        if (run.status === 'running') {
          run.status = 'done';
          emit(run, { type: 'done' });
        }
        return result;
      }
      const key = process.env.ANTHROPIC_API_KEY;
      const model = input.model ?? '';
      if (!key || !isLiveModel(model)) throw new Error('AGENT_CONFIGURATION_REQUIRED');
      const result = await runLive(
        input.task,
        page.id,
        tools,
        createAnthropicModel(key, model, abort.signal),
        (line) => emit(run, { type: 'log', text: redact(secrets, line) }),
      );
      if (run.status === 'running') {
        run.status = 'done';
        emit(run, { type: 'done', answer: redact(secrets, result.answer ?? '') });
      }
    } catch (error) {
      if (abort.signal.aborted) {
        run.status = 'stopped';
        emit(run, { type: 'error', message: 'stopped' });
        return;
      }
      run.status = 'failed';
      const message =
        error instanceof Error &&
        (error.message === 'AGENT_STEP_LIMIT' ||
          error.message === 'AGENT_CONFIGURATION_REQUIRED' ||
          error.message === 'PAGE_NOT_FOUND' ||
          error.message === 'MODEL_FAILED' ||
          error.message === 'RUN_STOPPED')
          ? error.message
          : 'failed';
      emit(run, { type: 'error', message });
    } finally {
      for (const client of run.clients) client.end();
    }
  })();

  return run;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const host = req.socket.remoteAddress;
  if (host !== '127.0.0.1' && host !== '::1' && host !== '::ffff:127.0.0.1') {
    json(res, 403, { error: 'localhost only' });
    return;
  }
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/pages') {
    json(res, 200, { pages: loadPages() });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/runs') {
    let body: {
      token?: string;
      task?: string;
      page?: string;
      profile?: string;
      model?: string;
    };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      json(res, 400, { error: 'invalid body' });
      return;
    }
    const running = [...runs.values()].filter((run) => run.status === 'running').length;
    if (running >= MAX_RUNS) {
      json(res, 429, { error: 'too many runs' });
      return;
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(body.token ?? '')) {
      json(res, 400, { error: 'invalid token' });
      return;
    }
    if (typeof body.task !== 'string' || body.task.trim() === '') {
      json(res, 400, { error: 'invalid task' });
      return;
    }
    if (body.profile !== 'live' && body.profile !== 'compromised') {
      json(res, 400, { error: 'invalid profile' });
      return;
    }
    try {
      const run = startRun({
        token: body.token!,
        task: body.task.trim(),
        page: body.page ?? '',
        profile: body.profile,
        model: body.model,
      });
      json(res, 202, { id: run.id, hash: run.hash, profile: run.profile, page: run.page });
    } catch (error) {
      json(res, 400, {
        error:
          error instanceof Error && error.message === 'PAGE_NOT_FOUND'
            ? 'unknown page'
            : 'invalid run',
      });
    }
    return;
  }

  const stream = /^\/runs\/([0-9a-f-]{36})\/stream$/.exec(url.pathname);
  if (req.method === 'GET' && stream) {
    const run = runs.get(stream[1]!);
    if (!run) {
      json(res, 404, { error: 'unknown run' });
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    for (const event of run.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (run.status !== 'running') {
      res.end();
      return;
    }
    run.clients.add(res);
    req.on('close', () => run.clients.delete(res));
    return;
  }

  const stop = /^\/runs\/([0-9a-f-]{36})\/stop$/.exec(url.pathname);
  if (req.method === 'POST' && stop) {
    const run = runs.get(stop[1]!);
    if (!run) {
      json(res, 404, { error: 'unknown run' });
      return;
    }
    if (run.status === 'running') run.stop();
    json(res, 200, { ok: true, id: run.id });
    return;
  }

  json(res, 404, { error: 'not found' });
}

const server = createServer((req, res) => {
  void handle(req, res).catch(() => {
    if (!res.headersSent) json(res, 500, { error: 'failed' });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`agent lab: http://${HOST}:${PORT}`);
});
