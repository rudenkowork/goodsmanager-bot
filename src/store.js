const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = getStorePath();
const DATA_DIR = path.dirname(STORE_PATH);
const STORE_ROW_ID = 1;

let pool = null;
let storeCache = null;
let writeQueue = Promise.resolve();
let lastWriteError = null;

async function ensureStoreFile(config) {
  const initialStore = createEmptyStore(config);

  if (process.env.DATABASE_URL) {
    await ensurePostgresStore(initialStore);
    console.log('Store backend: Postgres.');
    return;
  }

  assertJsonStoreAllowed();
  ensureJsonStore(initialStore);
  console.log(`Store backend: local JSON (${STORE_PATH}).`);
}

function ensureJsonStore(initialStore) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (fs.existsSync(STORE_PATH)) {
    storeCache = normalizeStore(readJsonStore(), initialStore.config);
    return;
  }

  storeCache = initialStore;
  writeJsonStore(storeCache);
}

async function ensurePostgresStore(initialStore) {
  pool = new Pool(createPostgresPoolConfig());

  pool.on('error', (error) => {
    console.error('Unexpected Postgres pool error:', error.message);
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_store (
      id integer PRIMARY KEY CHECK (id = 1),
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const seedStore = readSeedStore(initialStore);
  const inserted = await pool.query(
    `
      INSERT INTO bot_store (id, data, updated_at)
      VALUES ($1, $2::jsonb, now())
      ON CONFLICT (id) DO NOTHING
      RETURNING data
    `,
    [STORE_ROW_ID, JSON.stringify(seedStore)]
  );

  if (inserted.rowCount > 0) {
    storeCache = normalizeStore(inserted.rows[0].data, initialStore.config);
    return;
  }

  const result = await pool.query('SELECT data FROM bot_store WHERE id = $1', [STORE_ROW_ID]);
  if (result.rowCount === 0) {
    storeCache = initialStore;
    await savePostgresStore(storeCache);
    return;
  }

  storeCache = normalizeStore(result.rows[0].data, initialStore.config);
}

function createPostgresPoolConfig() {
  const config = {
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 3,
  };

  if (needsImplicitSsl(process.env.DATABASE_URL)) {
    config.ssl = true;
  }

  return config;
}

function readStore() {
  if (!storeCache && !process.env.DATABASE_URL && fs.existsSync(STORE_PATH)) {
    storeCache = normalizeStore(readJsonStore(), {});
  }

  if (!storeCache) {
    throw new Error('Store is not initialized.');
  }

  return cloneStore(storeCache);
}

function writeStore(store) {
  storeCache = normalizeStore(cloneStore(store), {});

  if (process.env.DATABASE_URL) {
    return queuePostgresWrite(storeCache);
  }

  writeJsonStore(storeCache);
  return Promise.resolve();
}

async function flushStoreWrites() {
  await writeQueue;

  if (lastWriteError) {
    throw lastWriteError;
  }
}

async function closeStore() {
  await flushStoreWrites();

  if (pool) {
    await pool.end();
  }
}

function createEmptyStore(config = {}) {
  return normalizeStore({
    config: {
      mainAdminTelegramUsername: config.mainAdminTelegramUsername,
      novaPostEndpoint: config.novaPostEndpoint,
    },
    users: {},
    sessions: {},
    apiKeys: {},
    selectedApiKeyByUser: {},
    defaultSenders: {},
    defaultSenderWarehouses: {},
    shipments: {},
    flows: {},
    botMessagesByChat: {},
  }, config);
}

function normalizeStore(store, config = {}) {
  const normalized = store && typeof store === 'object' ? store : {};

  if (!normalized.config || typeof normalized.config !== 'object') {
    normalized.config = {};
  }

  if (!normalized.config.mainAdminTelegramUsername && config.mainAdminTelegramUsername) {
    normalized.config.mainAdminTelegramUsername = config.mainAdminTelegramUsername;
  }

  if (!normalized.config.mainAdminTelegramUsername) {
    normalized.config.mainAdminTelegramUsername = configFallbackMainAdmin();
  }

  if (!normalized.config.novaPostEndpoint && config.novaPostEndpoint) {
    normalized.config.novaPostEndpoint = config.novaPostEndpoint;
  }

  ensureObject(normalized, 'users');
  ensureObject(normalized, 'sessions');
  ensureObject(normalized, 'apiKeys');
  ensureObject(normalized, 'selectedApiKeyByUser');
  ensureObject(normalized, 'defaultSenders');
  ensureObject(normalized, 'defaultSenderWarehouses');
  ensureObject(normalized, 'shipments');
  ensureObject(normalized, 'flows');
  ensureObject(normalized, 'botMessagesByChat');

  return normalized;
}

function getFlow(msg) {
  const store = readStore();
  return store.flows[String(msg.from.id)] || null;
}

function setFlow(msg, flow) {
  const store = readStore();
  store.flows[String(msg.from.id)] = flow;
  return writeStore(store);
}

function clearFlow(msg) {
  const store = readStore();
  delete store.flows[String(msg.from.id)];
  return writeStore(store);
}

function configFallbackMainAdmin() {
  return 'timarudy';
}

function ensureObject(store, key) {
  if (!store[key] || typeof store[key] !== 'object' || Array.isArray(store[key])) {
    store[key] = {};
  }
}

function getStorePath() {
  if (process.env.STORE_PATH) {
    return path.resolve(process.env.STORE_PATH);
  }

  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    return path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'store.json');
  }

  return path.join(DEFAULT_DATA_DIR, 'store.json');
}

function readJsonStore() {
  const raw = fs.readFileSync(STORE_PATH, 'utf8');
  return JSON.parse(raw);
}

function writeJsonStore(store) {
  fs.writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`);
}

function readSeedStore(initialStore) {
  if (!fs.existsSync(STORE_PATH)) {
    return initialStore;
  }

  try {
    return normalizeStore(readJsonStore(), initialStore.config);
  } catch (error) {
    console.warn(`Could not read ${STORE_PATH}; starting Postgres store from an empty structure.`);
    return initialStore;
  }
}

function queuePostgresWrite(store) {
  const snapshot = cloneStore(store);
  const writePromise = writeQueue.then(async () => {
    await savePostgresStore(snapshot);
    lastWriteError = null;
  });

  writeQueue = writePromise.catch((error) => {
    lastWriteError = error;
    console.error('Failed to write store to Postgres:', error.message);
  });

  return writePromise;
}

async function savePostgresStore(store) {
  if (!pool) {
    throw new Error('Postgres store is not initialized.');
  }

  await pool.query(
    `
      INSERT INTO bot_store (id, data, updated_at)
      VALUES ($1, $2::jsonb, now())
      ON CONFLICT (id) DO UPDATE
      SET data = EXCLUDED.data,
          updated_at = now()
    `,
    [STORE_ROW_ID, JSON.stringify(store)]
  );
}

function cloneStore(store) {
  return JSON.parse(JSON.stringify(store));
}

function assertJsonStoreAllowed() {
  if (!isProductionRuntime() || process.env.ALLOW_JSON_STORE_IN_PRODUCTION === 'true') {
    return;
  }

  throw new Error('DATABASE_URL is missing. Production must use Neon/Postgres persistence.');
}

function isProductionRuntime() {
  return process.env.NODE_ENV === 'production'
    || Boolean(process.env.RAILWAY_ENVIRONMENT)
    || Boolean(process.env.RAILWAY_SERVICE_ID)
    || Boolean(process.env.RENDER)
    || Boolean(process.env.RENDER_SERVICE_ID);
}

function needsImplicitSsl(connectionString) {
  try {
    const url = new URL(connectionString);

    if (url.searchParams.has('sslmode')) {
      return false;
    }

    return url.hostname.endsWith('.neon.tech');
  } catch (error) {
    return false;
  }
}

module.exports = {
  clearFlow,
  closeStore,
  ensureStoreFile,
  flushStoreWrites,
  getFlow,
  readStore,
  setFlow,
  writeStore,
};
