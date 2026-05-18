const fs = require('fs');
const path = require('path');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = getStorePath();
const DATA_DIR = path.dirname(STORE_PATH);

function ensureStoreFile(config) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (fs.existsSync(STORE_PATH)) {
    return;
  }

  writeStore({
    config: {
      mainAdminTelegramUsername: config.mainAdminTelegramUsername,
      novaPostEndpoint: config.novaPostEndpoint,
    },
    users: {},
    sessions: {},
    apiKeys: {},
    selectedApiKeyByUser: {},
    defaultSenderWarehouses: {},
    shipments: {},
    flows: {},
    botMessagesByChat: {},
  });
}

function readStore() {
  const raw = fs.readFileSync(STORE_PATH, 'utf8');
  const store = JSON.parse(raw);

  if (!store.config) {
    store.config = {};
  }

  if (!store.config.mainAdminTelegramUsername) {
    store.config.mainAdminTelegramUsername = configFallbackMainAdmin();
  }

  if (!store.users) {
    store.users = {};
  }

  if (!store.sessions) {
    store.sessions = {};
  }

  if (!store.apiKeys) {
    store.apiKeys = {};
  }

  if (!store.selectedApiKeyByUser) {
    store.selectedApiKeyByUser = {};
  }

  if (!store.defaultSenderWarehouses) {
    store.defaultSenderWarehouses = {};
  }

  if (!store.shipments) {
    store.shipments = {};
  }

  if (!store.flows) {
    store.flows = {};
  }

  if (!store.botMessagesByChat) {
    store.botMessagesByChat = {};
  }

  return store;
}

function writeStore(store) {
  fs.writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`);
}

function getFlow(msg) {
  const store = readStore();
  return store.flows[String(msg.from.id)] || null;
}

function setFlow(msg, flow) {
  const store = readStore();
  store.flows[String(msg.from.id)] = flow;
  writeStore(store);
}

function clearFlow(msg) {
  const store = readStore();
  delete store.flows[String(msg.from.id)];
  writeStore(store);
}

function configFallbackMainAdmin() {
  return 'timarudy';
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

module.exports = {
  clearFlow,
  ensureStoreFile,
  getFlow,
  readStore,
  setFlow,
  writeStore,
};
