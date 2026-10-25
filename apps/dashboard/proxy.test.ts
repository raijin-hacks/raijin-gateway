import { afterEach, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from './proxy';

const previous = {
  password: process.env.DASHBOARD_PASSWORD,
  mock: process.env.MOCK,
};

afterEach(() => {
  process.env.DASHBOARD_PASSWORD = previous.password;
  process.env.MOCK = previous.mock;
});

it('refuses an unauthenticated POST /api/workers', async () => {
  process.env.DASHBOARD_PASSWORD = 'operator-test-password';
  delete process.env.MOCK;
  const response = proxy(
    new NextRequest('http://localhost:3000/api/workers', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
    }),
  );
  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toEqual({ error: 'sign in required' });
});
