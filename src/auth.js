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

function getSessionUser(msg, store) {
  const currentStore = store || readStore();
  const session = currentStore.sessions[String(msg.from.id)];

  if (session) {
    const user = currentStore.users[session.login];
    if (user) {
      return {
        login: session.login,
        role: user.role,
      };
    }
  }

  return getMainAdminTelegramUser(msg, currentStore);
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
  const user = getSessionUser(msg, currentStore);
  const allowMock = Boolean(getMainAdminTelegramUser(msg, currentStore));
  const connectedRefCodes = getConnectedGoodsCrmRefCodes(msg, currentStore);

  return Object.keys(currentStore.apiKeys)
    .filter((alias) => isApiKeyVisibleToUser(currentStore.apiKeys[alias], user, allowMock, connectedRefCodes))
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

function getApiKeyForCreateFlow(flow, msg) {
  const alias = flow.data && flow.data.apiKeyAlias ? normalizeAlias(flow.data.apiKeyAlias) : '';
  const store = readStore();
  const aliases = msg ? getAvailableApiKeyAliases(msg, store) : Object.keys(store.apiKeys);

  if (!alias || !store.apiKeys[alias] || !aliases.includes(alias)) {
    throw new Error('API-ключ Нової пошти не знайдено. Почніть створення ТТН ще раз.');
  }

  return {
    alias,
    apiKey: store.apiKeys[alias].apiKey,
  };
}

function isApiKeyVisibleToUser(apiKeyRecord, user, allowMock, connectedRefCodes) {
  if (!apiKeyRecord || !apiKeyRecord.apiKey) {
    return false;
  }

  if (apiKeyRecord.apiKey === 'MOCK' && !allowMock) {
    return false;
  }

  if (allowMock) {
    return true;
  }

  if (!user) {
    return false;
  }

  if (apiKeyRecord.createdBy === user.login) {
    return true;
  }

  return apiKeyMatchesConnectedShop(apiKeyRecord, connectedRefCodes);
}

function apiKeyMatchesConnectedShop(apiKeyRecord, connectedRefCodes) {
  if (!connectedRefCodes.length) {
    return false;
  }

  const refCodeSet = new Set(connectedRefCodes);
  const fopsByRefCode = apiKeyRecord.crmFopsByRefCode && typeof apiKeyRecord.crmFopsByRefCode === 'object'
    ? apiKeyRecord.crmFopsByRefCode
    : {};

  for (const refCode of Object.keys(fopsByRefCode)) {
    if (refCodeSet.has(normalizeCrmRefCode(refCode))) {
      return true;
    }
  }

  const keyRefCodes = Array.isArray(apiKeyRecord.crmShopRefCodes) ? apiKeyRecord.crmShopRefCodes : [];
  return keyRefCodes.some((refCode) => refCodeSet.has(normalizeCrmRefCode(refCode)));
}

function getConnectedGoodsCrmRefCodes(msg, store) {
  const refCodes = new Set();

  for (const key of getGoodsCrmTelegramLinkKeys(msg)) {
    const shops = store.crmShopsByTelegramUser && store.crmShopsByTelegramUser[key];

    if (shops && typeof shops === 'object' && !Array.isArray(shops)) {
      for (const mapping of Object.values(shops)) {
        const refCode = normalizeCrmRefCode(mapping && mapping.refCode);
        if (refCode) {
          refCodes.add(refCode);
        }
      }
    }

    const legacy = store.crmShopByTelegramUser && store.crmShopByTelegramUser[key];
    const legacyRefCode = normalizeCrmRefCode(legacy && legacy.refCode);

    if (legacyRefCode) {
      refCodes.add(legacyRefCode);
    }
  }

  return Array.from(refCodes);
}

function getGoodsCrmTelegramLinkKeys(msg) {
  return [
    `${String(msg.from.id)}:${String(msg.chat.id)}`,
    String(msg.from.id),
  ];
}

function normalizeCrmRefCode(value) {
  return String(value || '').trim().toUpperCase();
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
