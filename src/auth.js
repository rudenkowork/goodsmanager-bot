const crypto = require('crypto');

const { readStore } = require('./store');
const { normalizeAlias } = require('./textUtils');

function createUserRecord(password, role) {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    role,
    passwordSalt: salt,
    passwordHash: hashPassword(password, salt),
    createdAt: new Date().toISOString(),
  };
}

function verifyPassword(password, user) {
  const hash = hashPassword(password, user.passwordSalt);
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.passwordHash));
}

function getSessionUser(msg) {
  const store = readStore();
  const session = store.sessions[String(msg.from.id)];

  if (!session) {
    return null;
  }

  const user = store.users[session.login];
  if (!user) {
    return null;
  }

  return {
    login: session.login,
    role: user.role,
  };
}

function assertLoggedIn(msg) {
  const user = getSessionUser(msg);
  if (!user) {
    throw new Error('Спочатку увійдіть у свій акаунт: /login login password');
  }

  return user;
}

function assertMainAdminTelegram(msg) {
  const username = msg.from && msg.from.username ? msg.from.username.toLowerCase() : '';
  const store = readStore();
  const mainAdmin = store.config.mainAdminTelegramUsername.toLowerCase();

  if (username !== mainAdmin) {
    throw new Error(`Ця команда доступна тільки головному адміну: @${store.config.mainAdminTelegramUsername}.`);
  }
}

function assertMainAdminSession(msg) {
  assertLoggedIn(msg);
  assertMainAdminTelegram(msg);
}

function isMainAdmin(msg) {
  const username = msg.from && msg.from.username ? msg.from.username.toLowerCase() : '';
  const store = readStore();
  return username === store.config.mainAdminTelegramUsername.toLowerCase();
}

function getSelectedApiKey(msg) {
  const user = assertLoggedIn(msg);
  const store = readStore();
  let alias = store.selectedApiKeyByUser[user.login];

  if (!alias || !store.apiKeys[alias]) {
    const aliases = Object.keys(store.apiKeys).sort();
    alias = aliases[0];
  }

  if (!alias || !store.apiKeys[alias]) {
    throw new Error('Спочатку додайте API-ключ Нової пошти.');
  }

  return {
    alias,
    apiKey: store.apiKeys[alias].apiKey,
  };
}

function getApiKeyForCreateFlow(flow) {
  const alias = flow.data && flow.data.apiKeyAlias ? normalizeAlias(flow.data.apiKeyAlias) : '';
  const store = readStore();

  if (!alias || !store.apiKeys[alias]) {
    throw new Error('API-ключ Нової пошти не знайдено. Почніть створення ТТН ще раз.');
  }

  return {
    alias,
    apiKey: store.apiKeys[alias].apiKey,
  };
}

function getOptionalSelectedApiKey(msg) {
  const user = assertLoggedIn(msg);
  const store = readStore();
  const alias = store.selectedApiKeyByUser[user.login];

  if (!alias || !store.apiKeys[alias]) {
    return {
      alias: '',
      apiKey: '',
    };
  }

  return {
    alias,
    apiKey: store.apiKeys[alias].apiKey,
  };
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
}

module.exports = {
  assertLoggedIn,
  assertMainAdminSession,
  assertMainAdminTelegram,
  createUserRecord,
  getApiKeyForCreateFlow,
  getOptionalSelectedApiKey,
  getSelectedApiKey,
  getSessionUser,
  isMainAdmin,
  verifyPassword,
};
