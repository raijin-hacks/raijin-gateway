'use client';

import { useRouter } from 'next/navigation';

export default function LogoutButton() {
  const router = useRouter();

  async function logout() {
    await fetch('/api/logout', { method: 'POST' }).catch(() => null);
    router.replace('/login');
  }

  return (
    <button type="button" onClick={logout} className="rounded border px-2 text-sm">
      Sign out
    </button>
  );
}
