// Test fixture for journal.test.ts: one process journaling an intent, printing its key.
import { createJournal } from './journal.js';

const [path, token] = process.argv.slice(2);
const request = createJournal(path!).intent(token!, {
  url: 'http://localhost:4101/v1/pricing/acme?period=30d',
  method: 'GET',
  expected_price: 10000,
  purpose: 'fetch_data',
});
process.stdout.write(request.idempotency_key);
