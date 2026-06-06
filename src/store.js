const fs = require('fs');
const path = require('path');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = getStorePath();
const DATA_DIR = path.dirname(STORE_PATH);

let storeCache = null;

async function ensureStoreFile(config) {
  const initialStore = createEmptyStore(config);

  ensureJsonStore(initialStore);
  console.log(`Store backend: local JSON cache (${STORE_PATH}).`);
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

function readStore() {
  if (!storeCache && fs.existsSync(STORE_PATH)) {
    storeCache = normalizeStore(readJsonStore(), {});
  }

  if (!storeCache) {
    throw new Error('Store is not initialized.');
  }

  return cloneStore(storeCache);
}

function writeStore(store) {
  storeCache = normalizeStore(cloneStore(store), {});
  writeJsonStore(storeCache);
  return Promise.resolve();
}

async function flushStoreWrites() {
  return Promise.resolve();
}

async function closeStore() {
  return flushStoreWrites();
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
    crmShopByTelegramUser: {},
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
  ensureObject(normalized, 'crmShopByTelegramUser');
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

function cloneStore(store) {
  return JSON.parse(JSON.stringify(store));
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
