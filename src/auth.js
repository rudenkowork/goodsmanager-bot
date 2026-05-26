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

  if (session) {
    const user = store.users[session.login];
    if (user) {
      return {
        login: session.login,
        role: user.role,
      };
    }
  }

  return getMainAdminTelegramUser(msg, store);
}

function assertLoggedIn(msg) {
  const user = getSessionUser(msg);
  if (!user) {
    throw new Error('Спочатку увійдіть у свій акаунт: /login login password');
  }

  return user;
}

function assertMainAdminTelegram(msg) {
  const store = readStore();

  if (!getMainAdminTelegramUser(msg, store)) {
    throw new Error(`Ця команда доступна тільки головному адміну: @${store.config.mainAdminTelegramUsername}.`);
  }
}

function assertMainAdminSession(msg) {
  assertLoggedIn(msg);
  assertMainAdminTelegram(msg);
}

function isMainAdmin(msg) {
  const store = readStore();
  return Boolean(getMainAdminTelegramUser(msg, store));
}

function getMainAdminTelegramUser(msg, store) {
  const username = normalizeTelegramUsername(msg.from && msg.from.username);
  const mainAdmin = normalizeTelegramUsername(store.config.mainAdminTelegramUsername);

  if (!username || username !== mainAdmin) {
    return null;
  }

  return {
    login: mainAdmin,
    role: 'admin',
  };
}

function normalizeTelegramUsername(value) {
  return String(value || '').trim().replace(/^@/, '').toLowerCase();
}

function getAvailableApiKeyAliases(msg, store) {
  const currentStore = store || readStore();
  const allowMock = isMainAdmin(msg);

  return Object.keys(currentStore.apiKeys)
    .filter((alias) => allowMock || currentStore.apiKeys[alias].apiKey !== 'MOCK')
    .sort();
}

function getSelectedApiKey(msg) {
  const user = assertLoggedIn(msg);
  const store = readStore();
  const aliases = getAvailableApiKeyAliases(msg, store);
  let alias = store.selectedApiKeyByUser[user.login];

  if (!alias || !store.apiKeys[alias] || !aliases.includes(alias)) {
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
  const aliases = getAvailableApiKeyAliases(msg, store);
  const alias = store.selectedApiKeyByUser[user.login];

  if (!alias || !store.apiKeys[alias] || !aliases.includes(alias)) {
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
  getAvailableApiKeyAliases,
  getOptionalSelectedApiKey,
  getSelectedApiKey,
  getSessionUser,
  isMainAdmin,
  verifyPassword,
};
