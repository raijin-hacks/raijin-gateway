// `pnpm --filter @apf/gateway db:seed`: migrates and seeds DATABASE_PATH from CATALOG_PATH.
import { systemClock } from '../clock.js';
import { DEFAULT_CATALOG_PATH } from '../config.js';
import { loadCatalog } from '../stubs/catalog-stub.js';
import { openDb } from './client.js';
import { seedDatabase } from './seed.js';

const databasePath = process.env.DATABASE_PATH ?? './gateway.db';
const catalogPath = process.env.CATALOG_PATH ?? DEFAULT_CATALOG_PATH;

const db = openDb(databasePath);
seedDatabase(db, loadCatalog(catalogPath), systemClock);
db.sqlite.close();
console.log(`Seeded ${databasePath} from ${catalogPath}`);
