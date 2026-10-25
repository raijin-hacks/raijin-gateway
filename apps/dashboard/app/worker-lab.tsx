'use client';

import { useEffect, useState } from 'react';
import { LAB_MANDATES_EVENT, loadLabMandates, type LabMandate } from '../lib/lab-session';

type DemoPage = {
  id: string;
  title: string;
  layer: 'judge' | 'precontact';
  intended_purchase: {
    url: string;
    method: 'GET' | 'POST';
    expected_price: number;
    purpose: string;
  };
};

type LabEvent =
  | { type: 'log'; text: string }
  | { type: 'hash'; hash: string; purchase: DemoPage['intended_purchase'] }
  | { type: 'payment'; status: string }
  | { type: 'done'; answer?: string }
  | { type: 'error'; message: string };

const MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929'] as const;

type PaneState = {
  mandateId: string;
  task: string;
  page: string;
  profile: 'live' | 'compromised';
  model: (typeof MODELS)[number];
  runId: string;
  hash: string;
  status: string;
  logs: string[];
  busy: boolean;
};

function emptyPane(): PaneState {
  return {
    mandateId: '',
    task: '',
    page: 'demo',
    profile: 'live',
    model: 'claude-haiku-4-5-20251001',
    runId: '',
    hash: '',
    status: '',
    logs: [],
    busy: false,
  };
}

export default function WorkerLab() {
  const [mandates, setMandates] = useState<LabMandate[]>([]);
  const [pages, setPages] = useState<DemoPage[]>([]);
  const [panes, setPanes] = useState<PaneState[]>([
    emptyPane(),
    { ...emptyPane(), profile: 'compromised' },
  ]);
  const [error, setError] = useState('');
  const [mock, setMock] = useState(false);

  useEffect(() => {
    function reload() {
      const list = loadLabMandates();
      setMandates(list);
      setPanes((current) =>
        current.map((pane) => {
          if (pane.mandateId || list.length === 0) return pane;
          const first = list[0]!;
          return { ...pane, mandateId: first.id, task: first.task };
        }),
      );
    }
    reload();
    window.addEventListener(LAB_MANDATES_EVENT, reload);
    return () => window.removeEventListener(LAB_MANDATES_EVENT, reload);
  }, []);

  useEffect(() => {
    fetch('/api/workers', { cache: 'no-store' })
      .then(async (res) => {
        if (res.status === 503) {
          setMock(true);
          return;
        }
        if (!res.ok) throw new Error('lab');
        const body = (await res.json()) as { pages: DemoPage[] };
        setPages(body.pages);
        setError('');
      })
      .catch(() => setError('Worker lab is not running. Start pnpm agent:lab.'));
  }, []);

  function update(index: number, patch: Partial<PaneState>) {
    setPanes((current) => current.map((pane, i) => (i === index ? { ...pane, ...patch } : pane)));
  }

  async function start(index: number) {
    const pane = panes[index]!;
    const mandate = mandates.find((item) => item.id === pane.mandateId);
    if (!mandate) return setError('Create a mandate first. Its token stays in this tab.');
    const task = pane.task.trim() || mandate.task;
    update(index, { busy: true, logs: [], hash: '', status: '', runId: '' });
    setError('');
    const res = await fetch('/api/workers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: mandate.token,
        task,
        page: pane.page,
        profile: pane.profile,
        model: pane.profile === 'live' ? pane.model : undefined,
      }),
    }).catch(() => null);
    if (!res || !res.ok) {
      update(index, { busy: false });
      setError(
        res?.status === 503
          ? 'Worker lab is disabled in MOCK mode.'
          : 'Could not start the worker.',
      );
      return;
    }
    const started = (await res.json()) as { id: string; hash: string };
    update(index, { runId: started.id, hash: started.hash, busy: true });
    const source = new EventSource(`/api/workers/${started.id}/stream`);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as LabEvent;
      setPanes((current) =>
        current.map((item, i) => {
          if (i !== index) return item;
          if (event.type === 'log') return { ...item, logs: [...item.logs, event.text].slice(-80) };
          if (event.type === 'hash') return { ...item, hash: event.hash };
          if (event.type === 'payment') return { ...item, status: event.status };
          if (event.type === 'done') {
            source.close();
            return {
              ...item,
              busy: false,
              logs: event.answer ? [...item.logs, event.answer].slice(-80) : item.logs,
            };
          }
          if (event.type === 'error') {
            source.close();
            return { ...item, busy: false, logs: [...item.logs, event.message].slice(-80) };
          }
          return item;
        }),
      );
    };
    source.onerror = () => {
      source.close();
      update(index, { busy: false });
    };
  }

  async function stop(index: number) {
    const runId = panes[index]?.runId;
    if (!runId) return;
    await fetch(`/api/workers/${runId}/stop`, { method: 'POST' }).catch(() => null);
    update(index, { busy: false });
  }

  const input = 'w-full rounded border border-gray-600 bg-transparent px-2 py-1';

  return (
    <section className="my-6 rounded border border-gray-700 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Worker lab</h2>
          <p className="text-sm text-gray-400">
            Live models may refuse the page. That is competence. The compromised profile always
            sends the same cataloged purchase through the firewall.
          </p>
        </div>
        {panes.length < 3 && (
          <button
            type="button"
            className="rounded border px-2 py-1 text-sm"
            onClick={() => setPanes((current) => [...current, emptyPane()])}
          >
            Add pane
          </button>
        )}
      </div>
      {mock && (
        <p className="mb-3 text-sm text-amber-400">
          MOCK=1: the lab is disabled so we do not invent judge denials. Start a live runner.
        </p>
      )}
      {error && (
        <p role="alert" className="mb-3 text-sm text-red-400">
          {error}
        </p>
      )}
      <div className={`grid gap-3 ${panes.length > 1 ? 'md:grid-cols-2' : ''}`}>
        {panes.map((pane, index) => (
          <article key={index} className="rounded border border-gray-700 p-3">
            <label className="mb-2 block text-sm">
              Mandate
              <select
                className={input}
                value={pane.mandateId}
                onChange={(e) => {
                  const mandate = mandates.find((item) => item.id === e.target.value);
                  update(index, { mandateId: e.target.value, task: mandate?.task ?? pane.task });
                }}
              >
                <option value="" className="text-black">
                  {mandates.length ? 'Pick a mandate from this tab' : 'Create a mandate first'}
                </option>
                {mandates.map((mandate) => (
                  <option key={mandate.id} value={mandate.id} className="text-black">
                    {mandate.id} · {mandate.task.slice(0, 48)}
                  </option>
                ))}
              </select>
            </label>
            <label className="mb-2 block text-sm">
              Task
              <textarea
                className={input}
                rows={2}
                value={pane.task}
                onChange={(e) => update(index, { task: e.target.value })}
              />
            </label>
            <label className="mb-2 block text-sm">
              Page
              <select
                className={input}
                value={pane.page}
                onChange={(e) => update(index, { page: e.target.value })}
              >
                {pages.map((page) => (
                  <option key={page.id} value={page.id} className="text-black">
                    {page.title} · {page.layer}
                  </option>
                ))}
              </select>
            </label>
            <div className="mb-2 grid grid-cols-2 gap-2 text-sm">
              <label>
                Profile
                <select
                  className={input}
                  value={pane.profile}
                  onChange={(e) =>
                    update(index, { profile: e.target.value as PaneState['profile'] })
                  }
                >
                  <option value="live" className="text-black">
                    Live model
                  </option>
                  <option value="compromised" className="text-black">
                    Compromised
                  </option>
                </select>
              </label>
              <label>
                Model
                <select
                  className={input}
                  value={pane.model}
                  disabled={pane.profile !== 'live'}
                  onChange={(e) => update(index, { model: e.target.value as PaneState['model'] })}
                >
                  {MODELS.map((model) => (
                    <option key={model} value={model} className="text-black">
                      {model}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="mb-2 flex gap-2">
              <button
                type="button"
                className="rounded bg-blue-600 px-3 py-1 text-sm disabled:opacity-50"
                disabled={pane.busy || mock}
                onClick={() => void start(index)}
              >
                Run
              </button>
              <button
                type="button"
                className="rounded border px-3 py-1 text-sm"
                disabled={!pane.busy}
                onClick={() => void stop(index)}
              >
                Stop
              </button>
            </div>
            <p className="mb-1 break-all font-mono text-xs text-gray-400">
              hash {pane.hash || '—'}
              {pane.status ? ` · ${pane.status}` : ''}
            </p>
            <pre className="h-40 overflow-auto rounded bg-black/40 p-2 font-mono text-xs whitespace-pre-wrap">
              {pane.logs.join('\n') || 'No run yet.'}
            </pre>
          </article>
        ))}
      </div>
    </section>
  );
}
