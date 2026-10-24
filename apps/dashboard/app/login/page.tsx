'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError('');
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }).catch(() => null);
    setSending(false);
    if (res?.ok) {
      setPassword(''); // Next keeps this page mounted (hidden) after leaving; don't keep the password
      router.replace('/');
      return;
    }
    const body = await res?.json().catch(() => null);
    setError(body?.error ?? 'Could not reach the dashboard server.');
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-3 rounded border border-gray-700 p-4"
      >
        <h1 className="text-lg font-semibold">Agent Payment Firewall</h1>
        <p className="text-sm text-gray-400">Operator sign-in</p>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          className="w-full rounded border border-gray-600 bg-transparent px-2 py-1"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Operator password"
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={sending || !password}
          className="w-full rounded bg-blue-600 px-4 py-1 disabled:opacity-50"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
