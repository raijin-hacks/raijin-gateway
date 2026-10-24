// `pnpm --filter @apf/gateway db:seed`: migrates and seeds DATABASE_PATH from CATALOG_PATH.
import { systemClock } from '../clock.js';
import { DEFAULT_CATALOG_PATH } from '../config.js';
import { loadCatalog } from '../catalog/load.js';
import { openDb } from './client.js';
import { seedDatabase } from './seed.js';

const databasePath = process.env.DATABASE_PATH ?? './gateway.db';
const catalogPath = process.env.CATALOG_PATH ?? DEFAULT_CATALOG_PATH;

// Validate before openDb: opening also creates/migrates the database.
const catalog = loadCatalog(catalogPath);
const db = openDb(databasePath);
seedDatabase(db, catalog, systemClock);
db.sqlite.close();
console.log(`Seeded ${databasePath} from ${catalogPath}`);
