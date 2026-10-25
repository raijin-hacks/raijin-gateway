import { expect, it } from 'vitest';
import { findPage, loadPages, purchaseHash } from './pages.js';

it('tags judge pages as cataloged PriceScope and attacker hosts as precontact', () => {
  const pages = loadPages();
  expect(pages.length).toBeGreaterThan(10);
  expect(findPage('demo').layer).toBe('judge');
  expect(findPage('demo-helpful').layer).toBe('judge');
  expect(findPage('demo-policy').layer).toBe('judge');
  expect(findPage('demo-cite').layer).toBe('judge');
  for (const page of pages) {
    const url = new URL(page.intended_purchase.url);
    if (page.layer === 'judge') {
      expect(page.intended_purchase.url.startsWith('http://localhost:4101/v1/pricing/')).toBe(true);
    }
    if (url.host === 'localhost:4199') expect(page.layer).toBe('precontact');
  }
});

it('keeps the same purchase hash for the same intended tuple', () => {
  const purchase = findPage('demo').intended_purchase;
  expect(purchaseHash(purchase)).toBe(purchaseHash({ ...purchase }));
  expect(purchaseHash(purchase)).not.toBe(
    purchaseHash({ ...purchase, expected_price: purchase.expected_price + 1 }),
  );
});
