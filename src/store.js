const fs = require('fs');
const path = require('path');

const { CREATE_TTN_FLOW_VERSION } = require('./createTtnConfig');
const {
  isGoodsCrmConfigured,
  readStoreFromGoodsCrm,
  writeStoreToGoodsCrm,
} = require('./goodsCrm');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = getStorePath();
const DATA_DIR = path.dirname(STORE_PATH);

let storeCache = null;
let crmStoreEnabled = false;
let writeQueue = Promise.resolve();

async function ensureStoreFile(config) {
  const initialStore = createEmptyStore(config);

  ensureJsonStore(initialStore);
  crmStoreEnabled = isGoodsCrmConfigured();

  if (!crmStoreEnabled) {
    console.log(`Store backend: local JSON cache (${STORE_PATH}).`);
    return;
  }

  try {
    const remoteStore = await readStoreFromGoodsCrm();

    if (remoteStore) {
      storeCache = normalizeStore(remoteStore, initialStore.config);
      writeJsonStore(storeCache);
    } else {
      storeCache = normalizeStore(storeCache, initialStore.config);
      await writeStoreToGoodsCrm(storeCache);
    }

    console.log(`Store backend: GoodsCRM database via /api/bot/store, local backup at ${STORE_PATH}.`);
  } catch (error) {
    crmStoreEnabled = false;

    if (isProductionRuntime()) {
      throw new Error(`GoodsCRM store is unavailable: ${error.message}`);
    }

    console.warn(`GoodsCRM store unavailable, using local JSON cache: ${error.message}`);
    console.log(`Store backend: local JSON cache (${STORE_PATH}).`);
  }
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

  if (!crmStoreEnabled) {
    return Promise.resolve();
  }

  const snapshot = cloneStore(storeCache);
  writeQueue = writeQueue
    .catch(() => {})
    .then(() => writeStoreToGoodsCrm(snapshot));

  return writeQueue;
}

async function flushStoreWrites() {
  return writeQueue;
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
    crmShopsByTelegramUser: {},
    selectedCrmShopByTelegramUser: {},
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
  ensureObject(normalized, 'crmShopsByTelegramUser');
  ensureObject(normalized, 'selectedCrmShopByTelegramUser');
  ensureObject(normalized, 'shipments');
  ensureObject(normalized, 'flows');
  ensureObject(normalized, 'botMessagesByChat');
  normalizeGoodsCrmShopCollections(normalized);
  migrateLegacyGoodsCrmShopMappings(normalized);
  clearStaleCreateTtnFlows(normalized);

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

function normalizeGoodsCrmShopCollections(store) {
  for (const key of Object.keys(store.crmShopsByTelegramUser)) {
    if (!store.crmShopsByTelegramUser[key]
      || typeof store.crmShopsByTelegramUser[key] !== 'object'
      || Array.isArray(store.crmShopsByTelegramUser[key])) {
      store.crmShopsByTelegramUser[key] = {};
      continue;
    }

    const shops = store.crmShopsByTelegramUser[key];
    for (const storedRefCode of Object.keys(shops)) {
      const mapping = normalizeStoredGoodsCrmShopMapping(shops[storedRefCode]);
      delete shops[storedRefCode];

      if (mapping.refCode) {
        shops[mapping.refCode] = mapping;
      }
    }

    const selectedRefCode = normalizeStoredRefCode(store.selectedCrmShopByTelegramUser[key]);
    if (selectedRefCode && shops[selectedRefCode]) {
      store.selectedCrmShopByTelegramUser[key] = selectedRefCode;
      continue;
    }

    const refCodes = Object.keys(shops);
    if (refCodes.length) {
      store.selectedCrmShopByTelegramUser[key] = refCodes[0];
    } else {
      delete store.selectedCrmShopByTelegramUser[key];
    }
  }
}

function migrateLegacyGoodsCrmShopMappings(store) {
  for (const key of Object.keys(store.crmShopByTelegramUser)) {
    const mapping = normalizeStoredGoodsCrmShopMapping(store.crmShopByTelegramUser[key]);

    if (!mapping.refCode) {
      continue;
    }

    if (!store.crmShopsByTelegramUser[key]
      || typeof store.crmShopsByTelegramUser[key] !== 'object'
      || Array.isArray(store.crmShopsByTelegramUser[key])) {
      store.crmShopsByTelegramUser[key] = {};
    }

    if (!store.crmShopsByTelegramUser[key][mapping.refCode]) {
      store.crmShopsByTelegramUser[key][mapping.refCode] = mapping;
    }

    const selectedRefCode = normalizeStoredRefCode(store.selectedCrmShopByTelegramUser[key]);

    if (selectedRefCode) {
      store.selectedCrmShopByTelegramUser[key] = selectedRefCode;
    } else {
      store.selectedCrmShopByTelegramUser[key] = mapping.refCode;
    }
  }
}

function normalizeStoredGoodsCrmShopMapping(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.assign({}, value, {
    telegramUserId: String(value.telegramUserId || ''),
    chatId: String(value.chatId || ''),
    username: String(value.username || ''),
    crmShopId: String(value.crmShopId || ''),
    refCode: normalizeStoredRefCode(value.refCode),
    shopName: String(value.shopName || ''),
    defaultFopId: String(value.defaultFopId || ''),
    defaultFopName: String(value.defaultFopName || ''),
    connectedBy: String(value.connectedBy || ''),
    connectedAt: String(value.connectedAt || ''),
  });
}

function normalizeStoredRefCode(value) {
  return String(value || '').trim().toUpperCase();
}

function clearStaleCreateTtnFlows(store) {
  for (const key of Object.keys(store.flows)) {
    const flow = store.flows[key];

    if (flow && flow.type === 'createTtn' && flow.version !== CREATE_TTN_FLOW_VERSION) {
      delete store.flows[key];
    }
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

function isProductionRuntime() {
  return process.env.NODE_ENV === 'production'
    || Boolean(process.env.RAILWAY_ENVIRONMENT)
    || Boolean(process.env.RAILWAY_SERVICE_ID)
    || Boolean(process.env.RENDER)
    || Boolean(process.env.RENDER_SERVICE_ID);
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
