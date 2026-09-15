import { Database } from '../src/db/connection.js';
import { initialize } from '../src/db/initialize.js';

const db = new Database();
try {
  await db.connect(1);
  await initialize(db);
  console.log(`Initialized database ${db.name}`);
} finally { await db.close(); }
