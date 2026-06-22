const DEFAULT_SOURCE_LABEL = 'Telegram bot';

function isGoodsCrmConfigured() {
  const config = getGoodsCrmConfig();

  if (!config.baseUrl) {
    return false;
  }

  return !isProductionRuntime() || Boolean(config.secret);
}

function getGoodsCrmConfig() {
  return {
    baseUrl: normalizeBaseUrl(process.env.GOODSCRM_BASE_URL || process.env.CRM_BASE_URL || ''),
    secret: process.env.BOT_INGEST_SECRET || '',
  };
}

async function resolveGoodsCrmShop(refCode) {
  const normalizedRefCode = normalizeGoodsCrmRefCode(refCode);

  if (!normalizedRefCode) {
    throw createGoodsCrmError('invalid_ref_code', 'GoodsCRM shop code is empty.');
  }

  const result = await callGoodsCrm('/api/bot/shops/resolve', {
    refCode: normalizedRefCode,
  });

  if (!result || !result.shop) {
    throw createGoodsCrmError('shop_not_found', 'Shop ref code not found');
  }

  return {
    shop: result.shop || null,
    defaultFop: normalizeGoodsCrmFop(result.defaultFop),
  };
}

async function getGoodsCrmShopFops(payload) {
  const refCode = normalizeGoodsCrmRefCode(payload && payload.refCode);

  if (!refCode) {
    throw createGoodsCrmError('missing_ref_code', 'GoodsCRM shop code is missing.');
  }

  const result = await callGoodsCrm('/api/bot/shops/fops', {
    refCode,
    telegramUserId: String(payload.telegramUserId || ''),
    chatId: String(payload.chatId || payload.telegramChatId || ''),
    username: String(payload.username || ''),
  });

  return {
    shop: result && result.shop || null,
    defaultFop: normalizeGoodsCrmFop(result && result.defaultFop),
    fops: normalizeGoodsCrmFops(result && result.fops),
  };
}

async function linkTelegramToGoodsCrmShop(payload) {
  const refCode = normalizeGoodsCrmRefCode(payload && payload.refCode);

  if (!refCode) {
    throw createGoodsCrmError('missing_ref_code', 'GoodsCRM shop code is missing.');
  }

  return callGoodsCrm('/api/bot/telegram-links', {
    telegramUserId: String(payload.telegramUserId || ''),
    chatId: String(payload.chatId || ''),
    username: String(payload.username || ''),
    refCode,
  });
}

async function pushTtnToGoodsCrm(payload) {
  const refCode = normalizeGoodsCrmRefCode(payload && payload.refCode);
  const ttns = normalizeTtnPayload(payload);

  if (!refCode) {
    throw createGoodsCrmError('missing_ref_code', 'GoodsCRM shop code is missing.');
  }

  if (!ttns.length) {
    throw createGoodsCrmError('empty_ttns', 'GoodsCRM TTN payload is empty.');
  }

  if (ttns.length > 100) {
    throw createGoodsCrmError('too_many_ttns', 'GoodsCRM accepts at most 100 TTNs per request.');
  }

  return callGoodsCrm('/api/bot/ttns', {
    refCode,
    ttns,
  });
}

async function upsertFopToGoodsCrm(payload) {
  const refCode = normalizeGoodsCrmRefCode(payload && payload.refCode);
  const fopName = String(payload && (payload.fopName || payload.name) || '').trim();
  const apiKey = String(payload && payload.apiKey || '').trim();

  if (!refCode) {
    throw createGoodsCrmError('missing_ref_code', 'GoodsCRM shop code is missing.');
  }

  if (!fopName) {
    throw createGoodsCrmError('fop_name_required', 'GoodsCRM FOP name is missing.');
  }

  if (!apiKey) {
    throw createGoodsCrmError('missing_api_key', 'Nova Poshta API key is missing.');
  }

  return callGoodsCrm('/api/bot/fops', {
    refCode,
    fopName,
    apiKey,
    telegramUserId: String(payload.telegramUserId || ''),
    telegramChatId: String(payload.telegramChatId || payload.chatId || ''),
    username: String(payload.username || ''),
    shopName: String(payload.shopName || ''),
  });
}

async function readStoreFromGoodsCrm() {
  const result = await callGoodsCrm('/api/bot/store', {
    action: 'read',
  });

  if (!result || !result.store || typeof result.store !== 'object' || Array.isArray(result.store)) {
    return null;
  }

  return result.store;
}

async function writeStoreToGoodsCrm(store) {
  if (!store || typeof store !== 'object' || Array.isArray(store)) {
    throw createGoodsCrmError('invalid_store', 'GoodsCRM store payload must be an object.');
  }

  return callGoodsCrm('/api/bot/store', {
    action: 'write',
    store,
  });
}

async function callGoodsCrm(path, payload) {
  const config = getGoodsCrmConfig();

  if (!config.baseUrl) {
    throw createGoodsCrmError('not_configured', 'GoodsCRM base URL is not configured.');
  }

  if (isProductionRuntime() && !config.secret) {
    throw createGoodsCrmError('not_configured', 'GoodsCRM bot secret is not configured.');
  }

  const response = await fetch(`${config.baseUrl}${path}`, {
    method: 'POST',
    headers: getGoodsCrmHeaders(config),
    body: JSON.stringify(payload),
  });
  const body = await parseResponseJson(response);

  if (!response.ok || body && body.ok === false) {
    throw createGoodsCrmHttpError(response, body);
  }

  return body;
}

function getGoodsCrmHeaders(config) {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (config.secret) {
    headers['x-bot-secret'] = config.secret;
    headers.Authorization = `Bearer ${config.secret}`;
  }

  return headers;
}

async function parseResponseJson(response) {
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}

function createGoodsCrmHttpError(response, body) {
  const statusCode = response.status;
  const message = body && body.message ? body.message : `GoodsCRM HTTP ${statusCode}`;
  const code = normalizeGoodsCrmErrorCode(message, statusCode);
  const error = createGoodsCrmError(code, message);

  error.statusCode = statusCode;
  return error;
}

function createGoodsCrmError(code, message) {
  const error = new Error(message);

  error.isGoodsCrmError = true;
  error.goodsCrmCode = code;
  return error;
}

function normalizeGoodsCrmErrorCode(message, statusCode) {
  const normalized = String(message || '').trim().toLowerCase();

  if (statusCode === 401) {
    return 'unauthorized';
  }

  if (normalized.includes('fop_not_found')) {
    return 'fop_not_found';
  }

  if (normalized.includes('fop_client_mismatch')) {
    return 'fop_client_mismatch';
  }

  if (normalized.includes('fop_not_assigned_to_shop')) {
    return 'fop_not_assigned_to_shop';
  }

  if (normalized.includes('fop_ambiguous')) {
    return 'fop_ambiguous';
  }

  if (normalized.includes('fop_required')) {
    return 'fop_required';
  }

  if (normalized.includes('fop_name_required')) {
    return 'fop_name_required';
  }

  if (normalized.includes('nova_poshta_api_key_invalid')) {
    return 'nova_poshta_api_key_invalid';
  }

  if (normalized.includes('telegram_identity_required')) {
    return 'telegram_identity_required';
  }

  if (normalized.includes('method_not_allowed')) {
    return 'method_not_allowed';
  }

  if (normalized.includes('empty_ttns')) {
    return 'empty_ttns';
  }

  if (normalized.includes('shop_not_found')
    || normalized.includes('shop ref code not found')
    || normalized.includes('shop code not found')) {
    return 'shop_not_found';
  }

  if (statusCode === 404) {
    return 'not_found';
  }

  if (statusCode === 400) {
    return 'invalid_request';
  }

  return 'request_failed';
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function isProductionRuntime() {
  return process.env.NODE_ENV === 'production'
    || Boolean(process.env.RAILWAY_ENVIRONMENT)
    || Boolean(process.env.RAILWAY_SERVICE_ID)
    || Boolean(process.env.RENDER)
    || Boolean(process.env.RENDER_SERVICE_ID);
}

function normalizeGoodsCrmRefCode(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeGoodsCrmFop(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  return {
    id: String(value.id || ''),
    name: String(value.name || ''),
  };
}

function normalizeGoodsCrmFops(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(normalizeGoodsCrmFopWithApiKey)
    .filter((item) => item.name && item.apiKey);
}

function normalizeGoodsCrmFopWithApiKey(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return {
    id: String(value.id || ''),
    name: String(value.name || ''),
    apiKey: String(value.apiKey || '').trim(),
    apiKeyLast4: String(value.apiKeyLast4 || ''),
    isDefault: Boolean(value.isDefault),
    updatedAt: String(value.updatedAt || ''),
  };
}

function normalizeTtnPayload(payload) {
  if (payload && Array.isArray(payload.ttns)) {
    return payload.ttns.map(normalizeTtnItem).filter((item) => item.ttn);
  }

  if (payload && payload.ttn) {
    return [
      normalizeTtnItem(payload),
    ].filter((item) => item.ttn);
  }

  return [];
}

function normalizeTtnItem(item) {
  const source = typeof item === 'string' || typeof item === 'number'
    ? { ttn: item }
    : item || {};
  const ttn = String(source.ttn || '').replace(/\D/g, '');

  return {
    ttn,
    sourceLabel: source.sourceLabel || DEFAULT_SOURCE_LABEL,
    createdBy: source.createdBy || '',
    createdAt: source.createdAt || '',
    description: source.description || '',
    fopId: source.fopId || '',
    fopName: source.fopName || '',
    cabinetName: source.cabinetName || '',
    senderName: source.senderName || '',
    senderContactName: source.senderContactName || '',
    senderPhone: source.senderPhone || '',
    senderCity: source.senderCity || '',
    senderDeliveryPoint: source.senderDeliveryPoint || '',
    recipientName: source.recipientName || '',
    recipientPhone: source.recipientPhone || '',
    recipientCity: source.recipientCity || '',
    recipientDeliveryPoint: source.recipientDeliveryPoint || '',
  };
}

module.exports = {
  DEFAULT_SOURCE_LABEL,
  getGoodsCrmShopFops,
  isGoodsCrmConfigured,
  linkTelegramToGoodsCrmShop,
  normalizeGoodsCrmRefCode,
  pushTtnToGoodsCrm,
  readStoreFromGoodsCrm,
  resolveGoodsCrmShop,
  upsertFopToGoodsCrm,
  writeStoreToGoodsCrm,
};
