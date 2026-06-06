const DEFAULT_SOURCE_LABEL = 'Telegram bot';

function isGoodsCrmConfigured() {
  return Boolean(getGoodsCrmConfig().baseUrl);
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

  return result.shop || null;
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

  return callGoodsCrm('/api/bot/ttns', {
    refCode,
    ttns,
  });
}

async function callGoodsCrm(path, payload) {
  const config = getGoodsCrmConfig();

  if (!config.baseUrl) {
    throw createGoodsCrmError('not_configured', 'GoodsCRM base URL is not configured.');
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

  if (statusCode === 404 || normalized.includes('not found') || normalized.includes('shop_not_found')) {
    return 'shop_not_found';
  }

  if (normalized.includes('empty_ttns')) {
    return 'empty_ttns';
  }

  if (statusCode === 400) {
    return 'invalid_request';
  }

  return 'request_failed';
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeGoodsCrmRefCode(value) {
  return String(value || '').trim().toUpperCase();
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
  const ttn = String(item && item.ttn || '').replace(/\D/g, '');

  return {
    ttn,
    sourceLabel: item && item.sourceLabel || DEFAULT_SOURCE_LABEL,
    createdBy: item && item.createdBy || '',
    createdAt: item && item.createdAt || '',
    description: item && item.description || '',
    cabinetName: item && item.cabinetName || '',
    senderName: item && item.senderName || '',
    senderContactName: item && item.senderContactName || '',
    senderPhone: item && item.senderPhone || '',
    senderCity: item && item.senderCity || '',
    senderDeliveryPoint: item && item.senderDeliveryPoint || '',
    recipientName: item && item.recipientName || '',
    recipientPhone: item && item.recipientPhone || '',
    recipientCity: item && item.recipientCity || '',
    recipientDeliveryPoint: item && item.recipientDeliveryPoint || '',
  };
}

module.exports = {
  DEFAULT_SOURCE_LABEL,
  isGoodsCrmConfigured,
  normalizeGoodsCrmRefCode,
  pushTtnToGoodsCrm,
  resolveGoodsCrmShop,
};
