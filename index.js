require('dotenv').config();

const http = require('http');
const TelegramBot = require('node-telegram-bot-api');
const {
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
} = require('./src/auth');
const {
  NOVA_POST_ENDPOINT,
  buildTtnProperties,
  callNovaPost,
  checkPaymentControlAvailable,
  firstDataItem,
  getTrackingDocuments,
  isPaymentControlUnavailableError,
  resolveCityRef,
  validateNovaPostApiKey,
} = require('./src/novaPost');
const {
  normalizeFullName,
  normalizeMoney,
  normalizePhone,
  normalizePositiveInteger,
  normalizeWeight,
} = require('./src/validators');
const {
  clearFlow,
  ensureStoreFile,
  getFlow,
  readStore,
  setFlow,
  writeStore,
} = require('./src/store');
const {
  chunkText,
  maskSecret,
  normalizeAlias,
  normalizeLogin,
  normalizeSearchText,
  parseCommand,
  parseJsonArgument,
  parseNovaPostGenericArgs,
  splitArgs,
  trimButtonLabel,
} = require('./src/textUtils');
const {
  BUTTONS,
  CHOICE_PAGE_SIZE,
  CITY_CHOICES_LIMIT,
  CREATE_TTN_FIELDS,
  DELIVERY_TYPE_CHOICES,
  MAIN_CITY_BY_AREA,
  POSTOMAT_TYPE_REFS,
  SETTLEMENT_TYPE_CHOICES,
  WAREHOUSE_SEARCH_LIMIT,
} = require('./src/createTtnConfig');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MAIN_ADMIN_TELEGRAM_USERNAME = process.env.MAIN_ADMIN_TELEGRAM_USERNAME || 'timarudy';
const BOT_MODE = normalizeBotMode(process.env.BOT_MODE);
const IS_WEBHOOK_MODE = BOT_MODE === 'webhook';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || BOT_TOKEN;
const WEBHOOK_PATH = getWebhookPath();
const WEBHOOK_URL = getWebhookUrl();
const WEBHOOK_SECRET_TOKEN = getWebhookSecretToken(process.env.WEBHOOK_SECRET);
const PORT = process.env.PORT || (IS_WEBHOOK_MODE ? '10000' : '');
let httpServer = null;

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is missing. Add it to .env before starting the bot.');
  process.exit(1);
}

ensureStoreFile({
  mainAdminTelegramUsername: MAIN_ADMIN_TELEGRAM_USERNAME,
  novaPostEndpoint: NOVA_POST_ENDPOINT,
});

const bot = new TelegramBot(BOT_TOKEN, { polling: !IS_WEBHOOK_MODE });
const startedAt = new Date();
const DEFAULT_SENDER_WAREHOUSE_FIELDS = [
  {
    key: 'AreaSender',
    prompt: 'Оберіть область стандартного відділення.',
    areaRef: true,
  },
  {
    key: 'CitySender',
    prompt: 'Оберіть населений пункт стандартного відділення.',
    cityRef: true,
    areaKey: 'AreaSender',
  },
  {
    key: 'SenderAddress',
    prompt: 'Введіть номер відділення, з якого зазвичай відправляєте.',
    warehouseRef: true,
    cityKey: 'CitySender',
    fixedDeliveryType: 'branch',
    fixedDeliveryTypeLabel: 'Відділення',
  },
  {
    key: 'name',
    prompt: 'Назвіть це відділення для кнопки. Наприклад: Склад Київ.',
  },
];
const REPORT_LIMIT = 60;
const KYIV_TIME_ZONE = 'Europe/Kiev';

bot.setMyCommands([
  { command: 'start', description: 'Відкрити головне меню' },
  { command: 'menu', description: 'Показати панель дій' },
  { command: 'help', description: 'Підказки по боту' },
  { command: 'status', description: 'Статус бота' },
  { command: 'shipments', description: 'Мої відправки' },
  { command: 'payments', description: 'Оплати' },
  { command: 'returns', description: 'Повернення' },
  { command: 'trackttn', description: 'Відстежити ТТН' },
  { command: 'stop', description: 'Зупинити поточну дію' },
  { command: 'delttn', description: 'Видалити створену ТТН' },
  { command: 'add_default_warehouse', description: 'Зберегти стандартне відділення' },
]).catch((error) => {
  console.error('Failed to set bot commands:', error.message);
});

bot.on('message', async (msg) => {
  if (!msg.text) {
    return;
  }

  try {
    await handleMessage(msg);
  } catch (error) {
    console.error(error);
    await sendText(msg.chat.id, formatUserErrorMessage(error));
  }
});

bot.on('polling_error', (error) => {
  console.error('Polling error:', error.message);
});

process.on('SIGINT', () => {
  shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});

console.log(`Goods Manager bot started in ${BOT_MODE} mode.`);
startHttpServer();
configureTelegramDelivery().catch((error) => {
  console.error('Failed to configure Telegram delivery:', error.message);

  if (IS_WEBHOOK_MODE) {
    process.exit(1);
  }
});

async function shutdown(signal) {
  console.log(`Received ${signal}. Stopping bot.`);

  if (!IS_WEBHOOK_MODE) {
    try {
      await bot.stopPolling();
    } catch (error) {
      console.error('Failed to stop polling:', error.message);
    }
  }

  if (httpServer) {
    try {
      await closeHttpServer();
    } catch (error) {
      console.error('Failed to stop HTTP server:', error.message);
    }
  }

  process.exit(0);
}

async function configureTelegramDelivery() {
  if (!IS_WEBHOOK_MODE) {
    return;
  }

  if (!WEBHOOK_URL) {
    throw new Error('Webhook mode needs WEBHOOK_BASE_URL, WEBHOOK_URL, PUBLIC_URL, or RENDER_EXTERNAL_URL.');
  }

  const options = {};

  if (WEBHOOK_SECRET_TOKEN) {
    options.secret_token = WEBHOOK_SECRET_TOKEN;
  }

  await bot.setWebHook(WEBHOOK_URL, options);
  console.log('Telegram webhook configured.');
}

function startHttpServer() {
  if (!PORT) {
    return;
  }

  httpServer = http.createServer(async (request, response) => {
    if (IS_WEBHOOK_MODE && isWebhookRequest(request)) {
      await handleWebhookRequest(request, response);
      return;
    }

    if (isHealthRequest(request)) {
      sendPlainResponse(response, 200, 'ok');
      return;
    }

    sendPlainResponse(response, 404, 'not found');
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`HTTP server listening on port ${PORT}.`);
  });
}

function closeHttpServer() {
  return new Promise((resolve, reject) => {
    httpServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function handleWebhookRequest(request, response) {
  if (request.method !== 'POST') {
    sendPlainResponse(response, 405, 'method not allowed');
    return;
  }

  if (!hasValidWebhookSecret(request)) {
    sendPlainResponse(response, 403, 'forbidden');
    return;
  }

  try {
    const body = await readRequestBody(request);
    const update = JSON.parse(body);
    bot.processUpdate(update);
    sendPlainResponse(response, 200, 'ok');
  } catch (error) {
    console.error('Webhook request failed:', error.message);
    sendPlainResponse(response, 400, 'bad request');
  }
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';

    request.on('data', (chunk) => {
      body += chunk;

      if (body.length > 1024 * 1024) {
        reject(new Error('Webhook request body is too large.'));
        request.destroy();
      }
    });

    request.on('end', () => {
      resolve(body);
    });

    request.on('error', reject);
  });
}

function hasValidWebhookSecret(request) {
  if (!WEBHOOK_SECRET_TOKEN) {
    return true;
  }

  return request.headers['x-telegram-bot-api-secret-token'] === WEBHOOK_SECRET_TOKEN;
}

function isWebhookRequest(request) {
  return getRequestPath(request) === WEBHOOK_PATH;
}

function isHealthRequest(request) {
  const path = getRequestPath(request);

  if (path === '/') {
    return true;
  }

  if (path === '/health') {
    return true;
  }

  return path === '/healthz';
}

function getRequestPath(request) {
  try {
    const url = new URL(request.url, 'http://localhost');
    return url.pathname;
  } catch (error) {
    return '/';
  }
}

function sendPlainResponse(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain',
  });
  response.end(body);
}

function normalizeBotMode(value) {
  if (value === 'webhook') {
    return 'webhook';
  }

  return 'polling';
}

function getWebhookPath() {
  if (process.env.WEBHOOK_URL) {
    try {
      const url = new URL(process.env.WEBHOOK_URL);
      return url.pathname || '/';
    } catch (error) {
      return '/';
    }
  }

  if (process.env.WEBHOOK_PATH) {
    return normalizeWebhookPath(process.env.WEBHOOK_PATH);
  }

  return `/telegram/${encodeURIComponent(WEBHOOK_SECRET)}`;
}

function getWebhookUrl() {
  if (process.env.WEBHOOK_URL) {
    return process.env.WEBHOOK_URL;
  }

  const baseUrl = process.env.WEBHOOK_BASE_URL || process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';

  if (!baseUrl) {
    return '';
  }

  return `${baseUrl.replace(/\/+$/, '')}${WEBHOOK_PATH}`;
}

function normalizeWebhookPath(value) {
  if (value.startsWith('/')) {
    return value;
  }

  return `/${value}`;
}

function getWebhookSecretToken(secret) {
  if (!secret) {
    return '';
  }

  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    return '';
  }

  return secret;
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === BUTTONS.cancel) {
    clearFlow(msg);
    await sendText(chatId, 'Скасовано ✅ Повертаю Вас у головне меню.', menuOptions(msg));
    return;
  }

  const activeFlow = getFlow(msg);

  if (activeFlow && text === BUTTONS.back) {
    await handleFlowBack(msg, activeFlow);
    return;
  }

  if (activeFlow && !text.startsWith('/')) {
    await handleFlowInput(msg, activeFlow, text);
    return;
  }

  if (!text.startsWith('/')) {
    await handleMenuButton(msg, text);
    return;
  }

  const parsed = parseCommand(text);

  if (!parsed) {
    await sendText(chatId, 'Оберіть дію на панелі нижче або напишіть /help.', menuOptions(msg));
    return;
  }

  const command = parsed.command;
  const args = parsed.args;

  if (command === '/start') {
    await sendStart(msg);
    return;
  }

  if (command === '/stop') {
    await stopCurrentChat(msg, activeFlow);
    return;
  }

  if (command === '/help') {
    await sendHelp(msg);
    return;
  }

  if (command === '/menu') {
    await sendText(msg.chat.id, 'Ось що можна зробити зараз:', menuOptions(msg));
    return;
  }

  if (command === '/status') {
    await sendBotStatus(msg);
    return;
  }

  if (command === '/shipments') {
    await startShipmentsMenu(msg);
    return;
  }

  if (command === '/payments') {
    await startPaymentsMenu(msg);
    return;
  }

  if (command === '/returns') {
    await startReturnsMenu(msg);
    return;
  }

  if (command === '/trackttn') {
    await handleTrackTtnCommand(msg, args);
    return;
  }

  if (command === '/delttn') {
    await handleDeleteCreatedTtn(msg, args);
    return;
  }

  if (command === '/admin_setup') {
    await handleAdminSetup(msg, args);
    return;
  }

  if (command === '/login') {
    await handleLogin(msg, args);
    return;
  }

  if (command === '/logout') {
    await handleLogout(msg);
    return;
  }

  if (command === '/adduser') {
    await handleAddUser(msg, args);
    return;
  }

  if (command === '/deluser') {
    await handleDeleteUser(msg, args);
    return;
  }

  if (command === '/users') {
    await handleUsers(msg);
    return;
  }

  if (command === '/addkey') {
    await handleAddKey(msg, args);
    return;
  }

  if (command === '/add_default_warehouse') {
    await startDefaultSenderWarehouseFlow(msg);
    return;
  }

  if (command === '/delkey') {
    await handleDeleteKey(msg, args);
    return;
  }

  if (command === '/keys') {
    await handleKeys(msg);
    return;
  }

  if (command === '/usekey') {
    await handleUseKey(msg, args);
    return;
  }

  if (command === '/cities') {
    await handleCities(msg, args);
    return;
  }

  if (command === '/warehouses') {
    await handleWarehouses(msg, args);
    return;
  }

  if (command === '/counterparties') {
    await handleCounterparties(msg, args);
    return;
  }

  if (command === '/contacts') {
    await handleContacts(msg, args);
    return;
  }

  if (command === '/cost') {
    await handleCost(msg, args);
    return;
  }

  if (command === '/deliverydate') {
    await handleDeliveryDate(msg, args);
    return;
  }

  if (command === '/npget') {
    await handleNovaPostGeneric(msg, args);
    return;
  }

  await sendText(chatId, 'Не впізнав цю команду 🤔 Напишіть /help, і я підкажу доступні дії.');
}

async function sendStart(msg) {
  clearFlow(msg);

  const name = msg.from && msg.from.first_name ? msg.from.first_name : 'друже';
  const user = getSessionUser(msg);
  const actionLine = user
    ? 'Оберіть потрібну дію на панелі нижче.'
    : 'Щоб почати, натисніть "Увійти" або попросіть головного адміна створити Вам доступ.';

  await sendText(
    msg.chat.id,
    [
      `Вітаю, ${name}! 👋`,
      'Я допоможу швидко створити ТТН, перевірити статус посилки та працювати з кабінетами Нової пошти.',
      '',
      actionLine,
    ].join('\n'),
    menuOptions(msg)
  );
}

async function stopCurrentChat(msg, activeFlow) {
  clearFlow(msg);

  const text = activeFlow
    ? 'Зупинив поточну дію ✅ Можемо почати заново.'
    : 'Активної дії не було 🙂 Можемо почати заново.';

  await sendText(msg.chat.id, text, menuOptions(msg));
}

async function sendHelp(msg) {
  const user = getSessionUser(msg);
  const lines = [
    'Працюйте через кнопки на панелі нижче: так швидше й без зайвих команд 🙂',
    '',
    'Основні дії:',
    `📦 ${BUTTONS.createTtn} - проведу крок за кроком і створю накладну.`,
    `📋 ${BUTTONS.myShipments} - покажу створені ТТН і оновлю статуси.`,
    `💳 ${BUTTONS.payments} - покажу накладені платежі та контроль оплати.`,
    `↩ ${BUTTONS.returns} - покажу повернення та звʼязок із початковою ТТН.`,
    `🔑 ${BUTTONS.addKey} - збережемо API-ключ із кабінету Нової пошти.`,
    `🏤 ${BUTTONS.addDefaultWarehouse} - збережемо відділення відправника для швидких ТТН.`,
    `🗂 ${BUTTONS.keys} - покажу збережені кабінети.`,
    '/trackttn номер - оновити статус однієї ТТН.',
    '/delttn номер - видалити створену в боті ТТН.',
    '/stop - зупинити поточну дію й почати заново.',
  ];

  if (user && isMainAdmin(msg)) {
    lines.push('');
    lines.push('Команди головного адміна:');
    lines.push('/adduser login password - створити користувача');
    lines.push('/deluser login - видалити користувача');
    lines.push('/users - список користувачів');
    lines.push('/delkey alias - видалити кабінет');
  }

  await sendText(msg.chat.id, lines.join('\n'), menuOptions(msg));
}

async function sendBotStatus(msg) {
  const uptimeSeconds = Math.floor((Date.now() - startedAt.getTime()) / 1000);
  const user = getSessionUser(msg);
  const login = user ? user.login : 'не авторизовано';

  await sendText(
    msg.chat.id,
    `Бот на звʼязку ✅\nЧас роботи: ${uptimeSeconds}s\nКористувач: ${login}`,
    menuOptions(msg)
  );
}

function formatUserErrorMessage(error) {
  if (error && error.isNovaPostApiError) {
    return getFriendlyNovaPostApiMessage(error);
  }

  const message = error && error.message ? error.message : 'невідома помилка';
  return `Не вийшло виконати дію: ${message}`;
}

async function handleMenuButton(msg, text) {
  if (text === BUTTONS.login) {
    await startLoginFlow(msg);
    return;
  }

  if (text === BUTTONS.createTtn) {
    await startCreateTtnFlow(msg);
    return;
  }

  if (text === BUTTONS.myShipments) {
    await startShipmentsMenu(msg);
    return;
  }

  if (text === BUTTONS.payments) {
    await startPaymentsMenu(msg);
    return;
  }

  if (text === BUTTONS.returns) {
    await startReturnsMenu(msg);
    return;
  }

  if (text === BUTTONS.accounts) {
    await startAccountsMenu(msg);
    return;
  }

  if (text === BUTTONS.settings) {
    await startSettingsMenu(msg);
    return;
  }

  if (text === BUTTONS.keys) {
    await handleKeys(msg);
    return;
  }

  if (text === BUTTONS.addKey) {
    await startAddKeyFlow(msg);
    return;
  }

  if (text === BUTTONS.addDefaultWarehouse) {
    await startDefaultSenderWarehouseFlow(msg);
    return;
  }

  if (text === BUTTONS.cities) {
    await startCitiesFlow(msg);
    return;
  }

  if (text === BUTTONS.warehouses) {
    await startWarehousesFlow(msg);
    return;
  }

  if (text === BUTTONS.addUser) {
    await startAddUserFlow(msg);
    return;
  }

  if (text === BUTTONS.users) {
    await handleUsers(msg);
    return;
  }

  if (text === BUTTONS.logout) {
    await handleLogout(msg);
    return;
  }

  await sendText(msg.chat.id, 'Не зовсім зрозумів дію. Оберіть кнопку на панелі або напишіть /help.', menuOptions(msg));
}

async function startLoginFlow(msg) {
  setFlow(msg, {
    type: 'login',
    step: 0,
    data: {},
  });

  await sendText(msg.chat.id, 'Введіть логін для входу.', cancelOptions());
}

async function startAddUserFlow(msg) {
  assertMainAdminSession(msg);

  setFlow(msg, {
    type: 'addUser',
    step: 0,
    data: {},
  });

  await sendText(msg.chat.id, 'Введіть логін нового користувача.', cancelOptions());
}

async function startAddKeyFlow(msg) {
  assertLoggedIn(msg);

  setFlow(msg, {
    type: 'addKey',
    step: 0,
    data: {},
  });

  await sendText(
    msg.chat.id,
    'Введіть зручну назву кабінету або ФОП для цього API-ключа.',
    cancelOptions()
  );
}

async function startDefaultSenderWarehouseFlow(msg) {
  assertLoggedIn(msg);
  const store = readStore();
  const aliases = getAvailableApiKeyAliases(msg, store);

  if (!aliases.length) {
    await sendText(
      msg.chat.id,
      'Спочатку додайте кабінет Нової пошти, а потім збережемо стандартне відділення.',
      menuOptions(msg)
    );
    return;
  }

  const flow = {
    type: 'defaultSenderWarehouse',
    step: -1,
    data: {},
  };

  if (aliases.length === 1) {
    flow.data.apiKeyAlias = aliases[0];
    flow.step = 0;
    setFlow(msg, flow);
    await sendText(msg.chat.id, `Кабінет: ${aliases[0]}`);
    await askNextDefaultSenderWarehouseField(msg, flow);
    return;
  }

  setFlow(msg, flow);
  await sendText(
    msg.chat.id,
    'Для якого кабінету зберегти стандартне відділення?',
    keyboardOptions(makeButtonRows(aliases, 2, true))
  );
}

async function startCitiesFlow(msg) {
  assertLoggedIn(msg);

  setFlow(msg, {
    type: 'cities',
    step: 0,
    data: {},
  });

  await sendText(msg.chat.id, 'Введіть назву міста.', cancelOptions());
}

async function startWarehousesFlow(msg) {
  assertLoggedIn(msg);

  setFlow(msg, {
    type: 'warehouses',
    step: 0,
    data: {},
  });

  await sendText(msg.chat.id, 'Введіть місто або Ref міста.', cancelOptions());
}

async function startCreateTtnFlow(msg) {
  assertLoggedIn(msg);
  const store = readStore();
  const aliases = getAvailableApiKeyAliases(msg, store);

  if (!aliases.length) {
    await sendText(
      msg.chat.id,
      'Щоб створити ТТН, спочатку додайте API-ключ Нової пошти.',
      menuOptions(msg)
    );
    return;
  }

  const flow = {
    type: 'createTtn',
    step: -1,
    data: {},
  };

  if (aliases.length === 1) {
    flow.data.apiKeyAlias = aliases[0];
    flow.step = 0;
    setFlow(msg, flow);
    await sendText(
      msg.chat.id,
      [
        'Починаємо створення ТТН 📦',
        `Кабінет: ${aliases[0]}`,
        'Заповнимо тільки необхідне.',
      ].join('\n')
    );
    await askNextCreateTtnField(msg, flow);
    return;
  }

  setFlow(msg, flow);

  await sendText(
    msg.chat.id,
    [
      'Починаємо створення ТТН 📦',
      'Спочатку оберіть кабінет Нової пошти, з якого будемо створювати накладну.',
      'Далі заповнимо тільки необхідне.',
      '',
      'Натисніть потрібний кабінет зі списку нижче.',
    ].join('\n'),
    keyboardOptions(makeButtonRows(aliases, 2, true))
  );
}

async function startShipmentsMenu(msg) {
  assertLoggedIn(msg);
  setFlow(msg, {
    type: 'shipments',
    mode: 'menu',
    data: {},
  });

  await sendText(
    msg.chat.id,
    'Мої відправки: оберіть фільтр.',
    keyboardOptions([
      [BUTTONS.today, BUTTONS.chooseDate],
      [BUTTONS.byCabinet, BUTTONS.allCabinets],
      [BUTTONS.trackTtn],
      [BUTTONS.back, BUTTONS.cancel],
    ])
  );
}

async function startPaymentsMenu(msg) {
  assertLoggedIn(msg);
  setFlow(msg, {
    type: 'payments',
    mode: 'menu',
    data: {},
  });

  await sendText(
    msg.chat.id,
    'Оплати: оберіть фільтр.',
    keyboardOptions([
      [BUTTONS.allPayments],
      [BUTTONS.waitingPayments, BUTTONS.receivedPayments],
      [BUTTONS.byCabinet],
      [BUTTONS.back, BUTTONS.cancel],
    ])
  );
}

async function startReturnsMenu(msg) {
  assertLoggedIn(msg);
  setFlow(msg, {
    type: 'returns',
    mode: 'menu',
    data: {},
  });

  await sendText(
    msg.chat.id,
    'Повернення: оберіть фільтр.',
    keyboardOptions([
      [BUTTONS.allReturns],
      [BUTTONS.byCabinet, BUTTONS.today],
      [BUTTONS.back, BUTTONS.cancel],
    ])
  );
}

async function startAccountsMenu(msg) {
  assertLoggedIn(msg);
  setFlow(msg, {
    type: 'accountsMenu',
    data: {},
  });

  await sendText(
    msg.chat.id,
    'ФОПи / акаунти: що відкриваємо?',
    keyboardOptions([
      [BUTTONS.keys, BUTTONS.addKey],
      [BUTTONS.back, BUTTONS.cancel],
    ])
  );
}

async function startSettingsMenu(msg) {
  assertLoggedIn(msg);
  setFlow(msg, {
    type: 'settingsMenu',
    data: {},
  });

  await sendText(
    msg.chat.id,
    'Налаштування: оберіть дію.',
    keyboardOptions([
      [BUTTONS.addDefaultWarehouse],
      [BUTTONS.cities, BUTTONS.warehouses],
      [BUTTONS.logout],
      [BUTTONS.back, BUTTONS.cancel],
    ])
  );
}

async function handleFlowInput(msg, flow, text) {
  if (flow.type === 'login') {
    await handleLoginFlowInput(msg, flow, text);
    return;
  }

  if (flow.type === 'addUser') {
    await handleAddUserFlowInput(msg, flow, text);
    return;
  }

  if (flow.type === 'addKey') {
    await handleAddKeyFlowInput(msg, flow, text);
    return;
  }

  if (flow.type === 'defaultSenderWarehouse') {
    await handleDefaultSenderWarehouseFlowInput(msg, flow, text);
    return;
  }

  if (flow.type === 'cities') {
    clearFlow(msg);
    await handleCities(msg, text);
    return;
  }

  if (flow.type === 'warehouses') {
    await handleWarehousesFlowInput(msg, flow, text);
    return;
  }

  if (flow.type === 'createTtn') {
    await handleCreateTtnFlowInput(msg, flow, text);
    return;
  }

  if (flow.type === 'shipments') {
    await handleShipmentsFlowInput(msg, flow, text);
    return;
  }

  if (flow.type === 'payments') {
    await handlePaymentsFlowInput(msg, flow, text);
    return;
  }

  if (flow.type === 'returns') {
    await handleReturnsFlowInput(msg, flow, text);
    return;
  }

  if (flow.type === 'accountsMenu') {
    await handleAccountsMenuInput(msg, text);
    return;
  }

  if (flow.type === 'settingsMenu') {
    await handleSettingsMenuInput(msg, text);
    return;
  }

  clearFlow(msg);
  await sendText(msg.chat.id, 'Не вдалося продовжити цю дію. Почніть ще раз із меню.', menuOptions(msg));
}

async function handleFlowBack(msg, flow) {
  if (flow.type === 'defaultSenderWarehouse') {
    await handleDefaultSenderWarehouseBack(msg, flow);
    return;
  }

  if (flow.type !== 'createTtn') {
    clearFlow(msg);
    await sendText(msg.chat.id, 'Повертаю Вас у головне меню.', menuOptions(msg));
    return;
  }

  if (flow.step === -1) {
    clearFlow(msg);
    await sendText(msg.chat.id, 'Повертаю Вас у головне меню.', menuOptions(msg));
    return;
  }

  if (flow.mode === 'cityChoice') {
    const field = getCreateTtnFieldByKey(flow.pendingField);
    delete flow.mode;
    delete flow.pendingField;
    clearPagedChoiceState(flow);
    delete flow.data[`${field.key}SettlementType`];
    delete flow.data[`${field.key}SettlementTypeLabel`];
    await offerSettlementTypeChoices(msg, flow, field);
    return;
  }

  if (flow.mode === 'warehouseNumber') {
    const field = getCreateTtnFieldByKey(flow.pendingField);
    delete flow.mode;
    delete flow.pendingField;
    delete flow.pendingWarehouseMode;
    clearPagedChoiceState(flow);
    delete flow.data[`${field.key}DeliveryType`];
    delete flow.data[`${field.key}DeliveryTypeLabel`];
    if (field.fixedDeliveryType) {
      flow.step -= 1;
      removeCreateFlowValue(flow, CREATE_TTN_FIELDS[flow.step]);
      await askNextCreateTtnField(msg, flow);
      return;
    }
    await offerDeliveryTypeChoices(msg, flow, field);
    return;
  }

  if (flow.mode) {
    delete flow.mode;
    delete flow.pendingField;
    delete flow.pendingWarehouseMode;
    clearPagedChoiceState(flow);
  }

  flow.step -= 1;

  if (flow.step < 0) {
    flow.step = -1;
    setFlow(msg, flow);
    await startCreateTtnFlow(msg);
    return;
  }

  removeCreateFlowValue(flow, CREATE_TTN_FIELDS[flow.step]);
  await askNextCreateTtnField(msg, flow);
}

async function handleDefaultSenderWarehouseBack(msg, flow) {
  if (flow.step <= 0) {
    clearFlow(msg);
    await sendText(msg.chat.id, 'Повертаю Вас у головне меню.', menuOptions(msg));
    return;
  }

  if (flow.mode === 'cityChoice') {
    const field = getDefaultSenderWarehouseFieldByKey(flow.pendingField);
    delete flow.mode;
    delete flow.pendingField;
    clearPagedChoiceState(flow);
    delete flow.data[`${field.key}SettlementType`];
    delete flow.data[`${field.key}SettlementTypeLabel`];
    await offerSettlementTypeChoices(msg, flow, field);
    return;
  }

  if (flow.mode === 'warehouseNumber') {
    delete flow.mode;
    delete flow.pendingField;
    delete flow.pendingWarehouseMode;
    clearPagedChoiceState(flow);
  }

  if (flow.mode) {
    delete flow.mode;
    delete flow.pendingField;
    clearPagedChoiceState(flow);
  }

  flow.step -= 1;
  removeDefaultSenderWarehouseValue(flow, DEFAULT_SENDER_WAREHOUSE_FIELDS[flow.step]);
  await askNextDefaultSenderWarehouseField(msg, flow);
}

async function handleLoginFlowInput(msg, flow, text) {
  if (flow.step === 0) {
    flow.data.login = normalizeLogin(text);
    flow.step = 1;
    setFlow(msg, flow);
    await sendText(msg.chat.id, 'Тепер введіть пароль.', cancelOptions());
    return;
  }

  const login = flow.data.login;
  const password = text;
  const store = readStore();
  const user = store.users[login];

  if (!user || !verifyPassword(password, user)) {
    clearFlow(msg);
    await sendText(msg.chat.id, 'Логін або пароль не підійшли. Натисніть "Увійти" і спробуйте ще раз.', menuOptions(msg));
    return;
  }

  store.sessions[String(msg.from.id)] = {
    login,
    loggedInAt: new Date().toISOString(),
  };
  delete store.flows[String(msg.from.id)];
  writeStore(store);

  await sendText(msg.chat.id, `Вхід виконано. Раді бачити Вас, ${login}!`, menuOptions(msg));
}

async function handleAddUserFlowInput(msg, flow, text) {
  assertMainAdminSession(msg);

  if (flow.step === 0) {
    flow.data.login = normalizeLogin(text);
    flow.step = 1;
    setFlow(msg, flow);
    await sendText(msg.chat.id, 'Введіть пароль для нового користувача.', cancelOptions());
    return;
  }

  const store = readStore();
  const login = flow.data.login;

  if (store.users[login]) {
    clearFlow(msg);
    await sendText(msg.chat.id, 'Користувач із таким логіном уже існує.', menuOptions(msg));
    return;
  }

  store.users[login] = createUserRecord(text, 'user');
  delete store.flows[String(msg.from.id)];
  writeStore(store);

  await sendText(msg.chat.id, `Готово, користувача створено: ${login}`, menuOptions(msg));
}

async function handleAddKeyFlowInput(msg, flow, text) {
  const user = assertLoggedIn(msg);

  if (flow.step === 0) {
    flow.data.alias = normalizeAlias(text);
    flow.step = 1;
    setFlow(msg, flow);
    await sendText(msg.chat.id, 'Тепер вставте API-ключ із кабінету Нової пошти.', cancelOptions());
    return;
  }

  const store = readStore();
  const alias = flow.data.alias;
  const apiKey = text.trim();

  if (apiKey === 'MOCK' && !isMainAdmin(msg)) {
    await sendText(msg.chat.id, 'Тестовий MOCK-кабінет доступний тільки адміну.', cancelOptions());
    return;
  }

  const keyValidation = await validateNovaPostApiKey(apiKey);

  if (!keyValidation.ok) {
    await sendText(msg.chat.id, keyValidation.message, cancelOptions());
    return;
  }

  store.apiKeys[alias] = {
    apiKey,
    createdBy: user.login,
    createdAt: new Date().toISOString(),
  };
  store.selectedApiKeyByUser[user.login] = alias;
  delete store.flows[String(msg.from.id)];
  writeStore(store);

  await sendText(
    msg.chat.id,
    `Готово, кабінет "${alias}" збережено. Якщо це єдиний кабінет, я використаю його для ТТН автоматично.`,
    menuOptions(msg)
  );
}

async function handleDefaultSenderWarehouseFlowInput(msg, flow, text) {
  if (flow.step === -1) {
    await handleDefaultSenderWarehouseKeySelection(msg, flow, text);
    return;
  }

  if (flow.mode === 'areaChoice') {
    await handleDefaultSenderWarehouseAreaChoice(msg, flow, text);
    return;
  }

  if (flow.mode === 'settlementTypeChoice') {
    await handleDefaultSenderWarehouseSettlementTypeChoice(msg, flow, text);
    return;
  }

  if (flow.mode === 'cityChoice') {
    await handleDefaultSenderWarehouseCityChoice(msg, flow, text);
    return;
  }

  if (flow.mode === 'warehouseNumber') {
    await handleDefaultSenderWarehouseChoice(msg, flow, text);
    return;
  }

  const field = DEFAULT_SENDER_WAREHOUSE_FIELDS[flow.step];
  const value = text.trim();

  if (!value) {
    await sendText(msg.chat.id, 'Введіть назву, будь ласка.', textInputOptions());
    return;
  }

  flow.data[field.key] = value;
  await saveDefaultSenderWarehouse(msg, flow.data);
}

async function handleDefaultSenderWarehouseKeySelection(msg, flow, text) {
  const alias = normalizeAlias(text);
  const store = readStore();
  const aliases = getAvailableApiKeyAliases(msg, store);

  if (!store.apiKeys[alias] || !aliases.includes(alias)) {
    await sendText(msg.chat.id, 'Не бачу такого кабінету. Натисніть один із варіантів нижче.', keyboardOptions(makeButtonRows(aliases, 2, true)));
    return;
  }

  flow.data.apiKeyAlias = alias;
  flow.step = 0;
  setFlow(msg, flow);
  await askNextDefaultSenderWarehouseField(msg, flow);
}

async function handleDefaultSenderWarehouseAreaChoice(msg, flow, text) {
  if (handleLocalChoicePageChange(flow, text)) {
    setFlow(msg, flow);
    await sendPagedChoiceList(msg, flow);
    return;
  }

  const choice = findChoiceByText(getCurrentPageChoices(flow), text);

  if (!choice) {
    setFlow(msg, flow);
    await sendText(msg.chat.id, 'Натисніть область зі списку нижче.', pagedChoiceOptions(flow));
    return;
  }

  flow.data[flow.pendingField] = choice.value;
  flow.data[`${flow.pendingField}Description`] = choice.description;
  flow.step += 1;
  delete flow.mode;
  delete flow.pendingField;
  clearPagedChoiceState(flow);

  await askNextDefaultSenderWarehouseField(msg, flow);
}

async function handleDefaultSenderWarehouseSettlementTypeChoice(msg, flow, text) {
  const choice = findChoiceByText(SETTLEMENT_TYPE_CHOICES, text);

  if (!choice) {
    await sendText(msg.chat.id, 'Натисніть тип населеного пункту зі списку нижче.', listChoiceOptions(SETTLEMENT_TYPE_CHOICES, 2));
    return;
  }

  const field = getDefaultSenderWarehouseFieldByKey(flow.pendingField);
  flow.data[`${field.key}SettlementType`] = choice.value;
  flow.data[`${field.key}SettlementTypeLabel`] = choice.label;
  delete flow.mode;
  delete flow.pendingField;
  clearPagedChoiceState(flow);

  await offerCityChoices(msg, flow, field, 1);
}

async function handleDefaultSenderWarehouseCityChoice(msg, flow, text) {
  if (handleLocalChoicePageChange(flow, text)) {
    setFlow(msg, flow);
    await sendPagedChoiceList(msg, flow);
    return;
  }

  const choice = findChoiceByText(getCurrentPageChoices(flow), text);

  if (!choice) {
    setFlow(msg, flow);
    await sendText(msg.chat.id, 'Натисніть населений пункт зі списку нижче.', pagedChoiceOptions(flow));
    return;
  }

  flow.data[flow.pendingField] = choice.value;
  flow.data[`${flow.pendingField}Description`] = choice.description;
  flow.step += 1;
  delete flow.mode;
  delete flow.pendingField;
  clearPagedChoiceState(flow);

  await askNextDefaultSenderWarehouseField(msg, flow);
}

async function handleDefaultSenderWarehouseChoice(msg, flow, text) {
  const field = getDefaultSenderWarehouseFieldByKey(flow.pendingField);
  const warehouseNumber = normalizeWarehouseNumberInput(text);

  if (!warehouseNumber) {
    setFlow(msg, flow);
    await sendText(msg.chat.id, 'Номер виглядає некоректно. Введіть коректний номер, будь ласка.', textInputOptions());
    return;
  }

  const key = getApiKeyForCreateFlow(flow);
  const warehouse = await findWarehouseByNumber(key.apiKey, flow.data[field.cityKey], 'branch', warehouseNumber);

  if (!warehouse) {
    setFlow(msg, flow);
    await sendText(msg.chat.id, 'Не знайшов таке відділення. Перевірте номер і введіть його ще раз.', textInputOptions());
    return;
  }

  flow.data[flow.pendingField] = warehouse.Ref;
  flow.data[`${flow.pendingField}Number`] = warehouse.Number || warehouseNumber;
  flow.data[`${flow.pendingField}Description`] = warehouse.Description;
  flow.data[`${flow.pendingField}Ref`] = warehouse.Ref;
  flow.data[`${flow.pendingField}DeliveryType`] = 'branch';
  flow.data[`${flow.pendingField}DeliveryTypeLabel`] = 'Відділення';
  flow.step += 1;
  delete flow.mode;
  delete flow.pendingField;
  delete flow.pendingWarehouseMode;
  clearPagedChoiceState(flow);

  await sendText(msg.chat.id, formatWarehouseConfirmation(flow, field, warehouse), textInputOptions());
  await askNextDefaultSenderWarehouseField(msg, flow);
}

async function askNextDefaultSenderWarehouseField(msg, flow) {
  const field = DEFAULT_SENDER_WAREHOUSE_FIELDS[flow.step];

  if (!field) {
    await saveDefaultSenderWarehouse(msg, flow.data);
    return;
  }

  setFlow(msg, flow);

  if (field.areaRef) {
    await offerAreaChoices(msg, flow, field, 1);
    return;
  }

  if (field.cityRef) {
    await offerSettlementTypeChoices(msg, flow, field);
    return;
  }

  if (field.warehouseRef) {
    await offerWarehouseStep(msg, flow, field);
    return;
  }

  await sendText(msg.chat.id, field.prompt, textInputOptions());
}

async function saveDefaultSenderWarehouse(msg, data) {
  const user = assertLoggedIn(msg);
  const store = readStore();
  const alias = normalizeAlias(data.apiKeyAlias);
  const warehouse = {
    id: `${Date.now()}`,
    name: trimButtonLabel(data.name || `Відділення №${data.SenderAddressNumber || ''}`),
    areaRef: data.AreaSender,
    areaDescription: data.AreaSenderDescription,
    cityRef: data.CitySender,
    cityDescription: data.CitySenderDescription,
    settlementType: data.CitySenderSettlementType,
    settlementTypeLabel: data.CitySenderSettlementTypeLabel,
    warehouseRef: data.SenderAddressRef || data.SenderAddress,
    warehouseNumber: data.SenderAddressNumber || '',
    warehouseDescription: data.SenderAddressDescription,
    createdAt: new Date().toISOString(),
  };

  if (!store.defaultSenderWarehouses) {
    store.defaultSenderWarehouses = {};
  }

  if (!store.defaultSenderWarehouses[user.login]) {
    store.defaultSenderWarehouses[user.login] = {};
  }

  if (!store.defaultSenderWarehouses[user.login][alias]) {
    store.defaultSenderWarehouses[user.login][alias] = [];
  }

  store.defaultSenderWarehouses[user.login][alias].push(warehouse);
  delete store.flows[String(msg.from.id)];
  writeStore(store);

  await sendText(
    msg.chat.id,
    [
      'Готово, стандартне відділення збережено ✅',
      `${warehouse.name}: ${warehouse.warehouseDescription}`,
      '',
      'Під час створення ТТН воно буде кнопкою у виборі відправника.',
    ].join('\n'),
    menuOptions(msg)
  );
}

async function handleWarehousesFlowInput(msg, flow, text) {
  if (flow.step === 0) {
    flow.data.city = text.trim();
    flow.step = 1;
    setFlow(msg, flow);
    await sendText(
      msg.chat.id,
      'Введіть текст для пошуку відділення або натисніть "Пропустити".',
      flowOptions({ defaultValue: '' })
    );
    return;
  }

  const search = text === BUTTONS.skip ? '' : text.trim();
  clearFlow(msg);
  await handleWarehouses(msg, `${flow.data.city} ${search}`.trim());
}

async function handleCreateTtnFlowInput(msg, flow, text) {
  if (flow.step === -1) {
    await handleCreateTtnKeySelection(msg, flow, text);
    return;
  }

  if (flow.mode === 'createTtnCorrectionChoice') {
    await handleCreateTtnCorrectionChoice(msg, flow, text);
    return;
  }

  if (flow.mode === 'cityChoice') {
    await handleCreateTtnCityChoice(msg, flow, text);
    return;
  }

  if (flow.mode === 'areaChoice') {
    await handleCreateTtnAreaChoice(msg, flow, text);
    return;
  }

  if (flow.mode === 'settlementTypeChoice') {
    await handleCreateTtnSettlementTypeChoice(msg, flow, text);
    return;
  }

  if (flow.mode === 'deliveryTypeChoice') {
    await handleCreateTtnDeliveryTypeChoice(msg, flow, text);
    return;
  }

  if (flow.mode === 'warehouseNumber') {
    await handleCreateTtnWarehouseChoice(msg, flow, text);
    return;
  }

  if (flow.mode === 'senderWarehouseDefaultChoice') {
    await handleCreateTtnSenderWarehouseDefaultChoice(msg, flow, text);
    return;
  }

  if (flow.mode === 'senderChoice') {
    await handleCreateTtnSenderChoice(msg, flow, text);
    return;
  }

  if (flow.mode === 'senderContactChoice') {
    await handleCreateTtnSenderContactChoice(msg, flow, text);
    return;
  }

  if (flow.mode === 'paymentControlUnavailableChoice') {
    await handlePaymentControlUnavailableChoice(msg, flow, text);
    return;
  }

  const field = CREATE_TTN_FIELDS[flow.step];
  let value = text.trim();

  if (value === BUTTONS.skip && field.defaultValue !== undefined) {
    value = field.defaultValue;
  }

  if (!value && field.defaultValue === undefined) {
    await sendText(msg.chat.id, 'Це поле потрібно заповнити. Введіть значення, будь ласка.', createTtnFieldOptions(field));
    return;
  }

  const validation = normalizeFieldValue(field, value);
  if (!validation.ok) {
    await sendText(msg.chat.id, validation.message, createTtnFieldOptions(field));
    return;
  }
  value = validation.value;

  if (field.paymentAmount && Number(value) <= 0) {
    await sendText(msg.chat.id, 'Сума оплати має бути більшою за 0.', createTtnFieldOptions(field));
    return;
  }

  if (field.key === 'PaymentType') {
    await handleCreateTtnPaymentType(msg, flow, value);
    return;
  }

  if (field.areaRef) {
    await offerAreaChoices(msg, flow, field, 1);
    return;
  }

  if (field.cityRef) {
    await offerSettlementTypeChoices(msg, flow, field);
    return;
  }

  if (field.warehouseRef || field.warehouseName) {
    await offerWarehouseStep(msg, flow, field);
    return;
  }

  if (field.senderCounterparty) {
    await offerSenderChoices(msg, flow, field);
    return;
  }

  if (field.senderContact) {
    await offerSenderContactChoices(msg, flow, field);
    return;
  }

  flow.data[field.key] = value;
  flow.step += 1;

  if (field.key === 'SendersPhone') {
    flow.senderSummaryShown = true;
    await sendText(msg.chat.id, formatSenderReadyMessage(flow));
  }

  if (flow.step < CREATE_TTN_FIELDS.length) {
    await askNextCreateTtnField(msg, flow);
    return;
  }

  await finishCreateTtnFlow(msg, flow);
}

async function handleCreateTtnPaymentType(msg, flow, value) {
  const key = getApiKeyForCreateFlow(flow);

  flow.data.PaymentType = value;
  flow.data.PaymentTypeLabel = getPaymentTypeLabel(value);
  delete flow.data.PaymentAmount;

  if (value === 'paymentControl') {
    const available = await checkPaymentControlAvailable(key.apiKey, flow.data);

    if (!available) {
      flow.mode = 'paymentControlUnavailableChoice';
      flow.pendingChoices = getPaymentControlUnavailableChoices();
      setFlow(msg, flow);
      await sendPaymentControlUnavailableMessage(msg, flow);
      return;
    }
  }

  flow.step += 1;
  await askNextCreateTtnField(msg, flow);
}

async function handlePaymentControlUnavailableChoice(msg, flow, text) {
  const choice = findChoiceByText(flow.pendingChoices || [], text);

  if (!choice) {
    await sendPaymentControlUnavailableMessage(msg, flow);
    return;
  }

  delete flow.mode;
  delete flow.pendingChoices;

  if (choice.value === 'cod') {
    flow.data.PaymentType = 'cod';
    flow.data.PaymentTypeLabel = getPaymentTypeLabel('cod');
    flow.step = getCreateTtnFieldIndex('PaymentAmount');
    setFlow(msg, flow);
    await sendText(msg.chat.id, getCreateTtnFieldByKey('PaymentAmount').prompt, textInputOptions());
    return;
  }

  flow.data.PaymentType = 'none';
  flow.data.PaymentTypeLabel = getPaymentTypeLabel('none');
  delete flow.data.PaymentAmount;
  flow.step = getCreateTtnFieldIndex('PaymentAmount') + 1;
  await askNextCreateTtnField(msg, flow);
}

async function sendPaymentControlUnavailableMessage(msg, flow) {
  await sendText(
    msg.chat.id,
    [
      'На цьому акаунті Нової пошти недоступний контроль оплати.',
      'Щоб використовувати цю функцію, потрібно підписати договір з Новою Поштою в особистому кабінеті.',
    ].join('\n'),
    listChoiceOptions(flow.pendingChoices || getPaymentControlUnavailableChoices(), 1)
  );
}

function getPaymentControlUnavailableChoices() {
  return [
    {
      label: BUTTONS.useCashOnDelivery,
      value: 'cod',
      description: BUTTONS.useCashOnDelivery,
    },
    {
      label: BUTTONS.withoutPaymentControl,
      value: 'none',
      description: BUTTONS.withoutPaymentControl,
    },
  ];
}

function getPaymentTypeLabel(value) {
  if (value === 'cod') {
    return 'Накладений платіж';
  }

  if (value === 'paymentControl') {
    return 'Контроль оплати';
  }

  return 'Без оплати';
}

async function handleShipmentsFlowInput(msg, flow, text) {
  if (flow.mode === 'menu') {
    if (text === BUTTONS.today) {
      clearFlow(msg);
      await sendShipmentsReport(msg, {
        dateKey: getTodayDateKey(),
      });
      return;
    }

    if (text === BUTTONS.chooseDate) {
      flow.mode = 'date';
      setFlow(msg, flow);
      await sendText(msg.chat.id, 'Введіть дату у форматі ДД.ММ.РРРР.', textInputOptions());
      return;
    }

    if (text === BUTTONS.byCabinet) {
      await startCabinetSelection(msg, flow, 'Оберіть один або кілька ФОПів для списку відправок.');
      return;
    }

    if (text === BUTTONS.allCabinets) {
      clearFlow(msg);
      await sendShipmentsReport(msg, {});
      return;
    }

    if (text === BUTTONS.trackTtn) {
      flow.mode = 'trackNumber';
      setFlow(msg, flow);
      await sendText(msg.chat.id, 'Введіть номер ТТН для відстеження.', textInputOptions());
      return;
    }
  }

  if (flow.mode === 'date') {
    const dateKey = normalizeDateInput(text);

    if (!dateKey) {
      await sendText(msg.chat.id, 'Дата виглядає некоректно. Введіть, наприклад: 26.05.2026.', textInputOptions());
      return;
    }

    clearFlow(msg);
    await sendShipmentsReport(msg, {
      dateKey,
    });
    return;
  }

  if (flow.mode === 'cabinetSelect') {
    await handleCabinetSelectionInput(msg, flow, text);
    return;
  }

  if (flow.mode === 'trackNumber') {
    clearFlow(msg);
    await handleTrackTtnCommand(msg, text);
    return;
  }

  await sendText(msg.chat.id, 'Оберіть фільтр для відправок.', menuOptions(msg));
}

async function handlePaymentsFlowInput(msg, flow, text) {
  if (flow.mode === 'menu') {
    if (text === BUTTONS.allPayments) {
      clearFlow(msg);
      await sendPaymentsReport(msg, {});
      return;
    }

    if (text === BUTTONS.waitingPayments) {
      clearFlow(msg);
      await sendPaymentsReport(msg, {
        paymentStatus: 'waiting',
      });
      return;
    }

    if (text === BUTTONS.receivedPayments) {
      clearFlow(msg);
      await sendPaymentsReport(msg, {
        paymentStatus: 'received',
      });
      return;
    }

    if (text === BUTTONS.byCabinet) {
      await startCabinetSelection(msg, flow, 'Оберіть один або кілька ФОПів для оплат.');
      return;
    }
  }

  if (flow.mode === 'cabinetSelect') {
    await handleCabinetSelectionInput(msg, flow, text);
    return;
  }

  await sendText(msg.chat.id, 'Оберіть фільтр для оплат.', menuOptions(msg));
}

async function handleReturnsFlowInput(msg, flow, text) {
  if (flow.mode === 'menu') {
    if (text === BUTTONS.allReturns) {
      clearFlow(msg);
      await sendReturnsReport(msg, {});
      return;
    }

    if (text === BUTTONS.byCabinet) {
      await startCabinetSelection(msg, flow, 'Оберіть один або кілька ФОПів для повернень.');
      return;
    }

    if (text === BUTTONS.today) {
      clearFlow(msg);
      await sendReturnsReport(msg, {
        dateKey: getTodayDateKey(),
      });
      return;
    }
  }

  if (flow.mode === 'cabinetSelect') {
    await handleCabinetSelectionInput(msg, flow, text);
    return;
  }

  await sendText(msg.chat.id, 'Оберіть фільтр для повернень.', menuOptions(msg));
}

async function handleAccountsMenuInput(msg, text) {
  clearFlow(msg);

  if (text === BUTTONS.keys) {
    await handleKeys(msg);
    return;
  }

  if (text === BUTTONS.addKey) {
    await startAddKeyFlow(msg);
    return;
  }

  await sendText(msg.chat.id, 'Повертаю Вас у головне меню.', menuOptions(msg));
}

async function handleSettingsMenuInput(msg, text) {
  clearFlow(msg);

  if (text === BUTTONS.addDefaultWarehouse) {
    await startDefaultSenderWarehouseFlow(msg);
    return;
  }

  if (text === BUTTONS.cities) {
    await startCitiesFlow(msg);
    return;
  }

  if (text === BUTTONS.warehouses) {
    await startWarehousesFlow(msg);
    return;
  }

  if (text === BUTTONS.logout) {
    await handleLogout(msg);
    return;
  }

  await sendText(msg.chat.id, 'Повертаю Вас у головне меню.', menuOptions(msg));
}

async function startCabinetSelection(msg, flow, title) {
  const store = readStore();
  const aliases = getAvailableApiKeyAliases(msg, store);

  if (!aliases.length) {
    clearFlow(msg);
    await sendText(msg.chat.id, 'Кабінетів Нової пошти ще немає.', menuOptions(msg));
    return;
  }

  flow.mode = 'cabinetSelect';
  flow.data.selectedAliases = [];
  flow.data.cabinetSelectionTitle = title;
  setFlow(msg, flow);
  await sendCabinetSelectionPrompt(msg, flow);
}

async function handleCabinetSelectionInput(msg, flow, text) {
  if (text === BUTTONS.showSelected) {
    const aliases = flow.data.selectedAliases || [];

    if (!aliases.length) {
      await sendText(msg.chat.id, 'Оберіть хоча б один ФОП зі списку.', cabinetSelectionOptions(msg, flow));
      return;
    }

    clearFlow(msg);

    if (flow.type === 'shipments') {
      await sendShipmentsReport(msg, {
        aliases,
      });
      return;
    }

    if (flow.type === 'payments') {
      await sendPaymentsReport(msg, {
        aliases,
      });
      return;
    }

    if (flow.type === 'returns') {
      await sendReturnsReport(msg, {
        aliases,
      });
      return;
    }
  }

  const store = readStore();
  const aliases = getAvailableApiKeyAliases(msg, store);
  const alias = normalizeCabinetSelectionLabel(text);

  if (!aliases.includes(alias)) {
    await sendText(msg.chat.id, 'Натисніть ФОП зі списку нижче.', cabinetSelectionOptions(msg, flow));
    return;
  }

  flow.data.selectedAliases = toggleSelectedAlias(flow.data.selectedAliases || [], alias);
  setFlow(msg, flow);
  await sendCabinetSelectionPrompt(msg, flow);
}

async function sendCabinetSelectionPrompt(msg, flow) {
  await sendText(
    msg.chat.id,
    flow.data.cabinetSelectionTitle || 'Оберіть ФОП.',
    cabinetSelectionOptions(msg, flow)
  );
}

function cabinetSelectionOptions(msg, flow) {
  const store = readStore();
  const aliases = getAvailableApiKeyAliases(msg, store);
  const selected = new Set(flow.data.selectedAliases || []);
  const buttons = aliases.map((alias) => formatCabinetSelectionLabel(alias, selected.has(alias)));
  const rows = makeButtonRows(buttons, 2, false);

  rows.push([BUTTONS.showSelected]);
  rows.push([BUTTONS.back, BUTTONS.cancel]);

  return keyboardOptions(rows);
}

function formatCabinetSelectionLabel(alias, selected) {
  const prefix = selected ? '[x]' : '[ ]';
  return `${prefix} ${alias}`;
}

function normalizeCabinetSelectionLabel(text) {
  return normalizeAlias(String(text || '').replace(/^\[[ xX]\]\s*/, ''));
}

function toggleSelectedAlias(aliases, alias) {
  if (aliases.includes(alias)) {
    return aliases.filter((item) => item !== alias);
  }

  return aliases.concat(alias);
}

async function handleTrackTtnCommand(msg, args) {
  assertLoggedIn(msg);
  const number = normalizeTtnNumber(args);

  if (!number) {
    await sendText(msg.chat.id, 'Формат команди: /trackttn номер');
    return;
  }

  const store = readStore();
  const entry = getVisibleShipmentEntries(msg, store).find((item) => item.number === number);

  if (!entry) {
    await sendText(msg.chat.id, 'Не знайшов таку ТТН серед створених у цьому боті.', menuOptions(msg));
    return;
  }

  await refreshTrackingForEntries(store, [entry]);
  await sendText(msg.chat.id, formatShipmentDetails(entry.number, entry.shipment), menuOptions(msg));
}

async function sendShipmentsReport(msg, filters) {
  const store = readStore();
  let entries = getVisibleShipmentEntries(msg, store);

  entries = filterShipmentEntries(entries, filters);
  entries = sortShipmentEntries(entries).slice(0, REPORT_LIMIT);
  await refreshTrackingForEntries(store, entries);

  const title = getShipmentsReportTitle(filters);

  if (!entries.length) {
    await sendText(msg.chat.id, `${title}\n\nВідправок не знайдено.`, menuOptions(msg));
    return;
  }

  await sendText(msg.chat.id, formatShipmentsReport(title, entries), menuOptions(msg));
}

async function sendPaymentsReport(msg, filters) {
  const store = readStore();
  let entries = getVisibleShipmentEntries(msg, store);

  entries = filterShipmentEntries(entries, filters);
  entries = sortShipmentEntries(entries).slice(0, REPORT_LIMIT);
  await refreshTrackingForEntries(store, entries);
  entries = entries.filter((entry) => shipmentHasPayment(entry.shipment));
  entries = filterPaymentEntries(entries, filters);

  const title = getPaymentsReportTitle(filters);

  if (!entries.length) {
    await sendText(msg.chat.id, `${title}\n\nОплат не знайдено.`, menuOptions(msg));
    return;
  }

  await sendText(msg.chat.id, formatPaymentsReport(title, entries), menuOptions(msg));
}

async function sendReturnsReport(msg, filters) {
  const store = readStore();
  let entries = getVisibleShipmentEntries(msg, store);

  entries = filterShipmentEntries(entries, filters);
  entries = sortShipmentEntries(entries).slice(0, REPORT_LIMIT);
  await refreshTrackingForEntries(store, entries);
  entries = entries.filter((entry) => shipmentHasReturn(entry.shipment));

  const title = getReturnsReportTitle(filters);

  if (!entries.length) {
    await sendText(msg.chat.id, `${title}\n\nПовернень не знайдено.`, menuOptions(msg));
    return;
  }

  await sendText(msg.chat.id, formatReturnsReport(title, entries), menuOptions(msg));
}

function getVisibleShipmentEntries(msg, store) {
  const user = assertLoggedIn(msg);

  return Object.keys(store.shipments || {}).map((number) => ({
    number,
    shipment: store.shipments[number],
  })).filter((entry) => {
    return entry.shipment.createdBy === user.login || isMainAdmin(msg);
  });
}

function filterShipmentEntries(entries, filters) {
  return entries.filter((entry) => {
    if (filters.dateKey && getShipmentDateKey(entry.shipment) !== filters.dateKey) {
      return false;
    }

    if (filters.aliases && filters.aliases.length && !filters.aliases.includes(entry.shipment.apiKeyAlias)) {
      return false;
    }

    return true;
  });
}

function filterPaymentEntries(entries, filters) {
  if (!filters.paymentStatus) {
    return entries;
  }

  return entries.filter((entry) => {
    const status = getPaymentStatusValue(entry.shipment.payment);

    if (filters.paymentStatus === 'received') {
      return status === 'received' || status === 'paid';
    }

    return status === filters.paymentStatus;
  });
}

function sortShipmentEntries(entries) {
  return entries.slice().sort((left, right) => {
    return getShipmentTime(right.shipment) - getShipmentTime(left.shipment);
  });
}

async function refreshTrackingForEntries(store, entries) {
  const groups = {};

  for (const entry of entries) {
    const alias = entry.shipment.apiKeyAlias;
    const key = store.apiKeys && store.apiKeys[alias] ? store.apiKeys[alias] : null;

    if (!key) {
      continue;
    }

    if (!groups[alias]) {
      groups[alias] = {
        apiKey: key.apiKey,
        entries: [],
      };
    }

    groups[alias].entries.push(entry);
  }

  let changed = false;

  for (const group of Object.values(groups)) {
    const documents = group.entries.map((entry) => ({
      number: entry.number,
      phone: getTrackingPhone(entry.shipment),
    }));

    try {
      const trackingItems = await getTrackingDocuments(group.apiKey, documents);
      const trackingByNumber = mapTrackingItemsByNumber(trackingItems);

      for (const entry of group.entries) {
        const tracking = trackingByNumber[entry.number];

        if (tracking) {
          applyTrackingToShipment(entry.number, entry.shipment, tracking);
          changed = true;
        }
      }
    } catch (error) {
      for (const entry of group.entries) {
        entry.shipment.statusUpdateError = new Date().toISOString();
      }
      changed = true;
    }
  }

  if (changed) {
    writeStore(store);
  }
}

function mapTrackingItemsByNumber(items) {
  const result = {};

  for (const item of items || []) {
    const number = normalizeTtnNumber(item.Number || item.DocumentNumber);

    if (number) {
      result[number] = item;
    }
  }

  return result;
}

function applyTrackingToShipment(number, shipment, tracking) {
  const now = new Date().toISOString();
  const deliveryPoint = tracking.WarehouseRecipientAddress
    || tracking.WarehouseRecipient
    || tracking.RecipientAddress
    || shipment.recipientDeliveryPoint
    || '';

  shipment.status = {
    code: String(tracking.StatusCode || ''),
    text: tracking.Status || shipment.status && shipment.status.text || 'Статус оновлено',
    deliveryPoint,
    scheduledDeliveryDate: tracking.ScheduledDeliveryDate || '',
    actualDeliveryDate: tracking.ActualDeliveryDate || tracking.RecipientDateTime || '',
    updatedAt: now,
    trackingUpdatedAt: tracking.TrackingUpdateDate || '',
  };

  applyPaymentTracking(shipment, tracking, now);
  applyReturnTracking(number, shipment, tracking, now);
}

function applyPaymentTracking(shipment, tracking, updatedAt) {
  const payment = shipment.payment || inferPaymentFromTracking(tracking);

  if (!payment) {
    return;
  }

  const amount = payment.amount
    || tracking.AfterpaymentOnGoodsCost
    || tracking.RedeliverySum
    || tracking.AmountToPay
    || tracking.ExpressWaybillAmountToPay
    || '';

  shipment.payment = {
    type: payment.type || inferPaymentTypeFromTracking(tracking),
    label: payment.label || getPaymentTypeLabel(payment.type || inferPaymentTypeFromTracking(tracking)),
    amount,
    status: normalizePaymentStatus(tracking),
    statusText: getPaymentStatusText(tracking),
    paymentStatusDate: tracking.PaymentStatusDate || tracking.LastTransactionDateTimeGM || '',
    updatedAt,
  };
}

function inferPaymentFromTracking(tracking) {
  const type = inferPaymentTypeFromTracking(tracking);

  if (!type) {
    return null;
  }

  return {
    type,
    label: getPaymentTypeLabel(type),
    amount: tracking.AfterpaymentOnGoodsCost || tracking.RedeliverySum || '',
    status: 'waiting',
  };
}

function inferPaymentTypeFromTracking(tracking) {
  if (tracking.AfterpaymentOnGoodsCost) {
    return 'paymentControl';
  }

  if (isTruthyApiValue(tracking.Redelivery) || tracking.RedeliverySum || tracking.RedeliveryNum) {
    return 'cod';
  }

  return '';
}

function normalizePaymentStatus(tracking) {
  const code = String(tracking.StatusCode || '');
  const text = getPaymentStatusText(tracking).toLowerCase();

  if (isReturnTracking(tracking)) {
    return 'returned';
  }

  if (code === '11' || hasAnyText(text, ['перерах', 'зарах', 'отриман', 'received', 'transfer'])) {
    return 'received';
  }

  if (code === '10' || hasAnyText(text, ['оплач', 'paid', 'success', 'успіш'])) {
    return 'paid';
  }

  if (Number(tracking.AmountPaid || 0) > 0) {
    return 'paid';
  }

  return 'waiting';
}

function getPaymentStatusText(tracking) {
  return [
    tracking.PaymentStatus,
    tracking.ExpressWaybillPaymentStatus,
    tracking.LastTransactionStatusGM,
  ].filter(Boolean).join(', ');
}

function applyReturnTracking(number, shipment, tracking, updatedAt) {
  if (!isReturnTracking(tracking)) {
    return;
  }

  let returnNumber = normalizeTtnNumber(tracking.LastCreatedOnTheBasisNumber || tracking.CreatedOnTheBasis);

  if (!returnNumber && tracking.OwnerDocumentNumber && tracking.OwnerDocumentNumber !== number) {
    returnNumber = normalizeTtnNumber(tracking.OwnerDocumentNumber);
  }

  shipment.return = {
    originalNumber: number,
    returnNumber,
    status: tracking.Status || '',
    statusCode: String(tracking.StatusCode || ''),
    reason: tracking.UndeliveryReasonsSubtypeDescription || tracking.UndeliveryReasons || '',
    updatedAt,
  };
}

function isReturnTracking(tracking) {
  const code = String(tracking.StatusCode || '');
  const text = [
    tracking.Status,
    tracking.UndeliveryReasonsSubtypeDescription,
    tracking.LastCreatedOnTheBasisDocumentType,
    tracking.OwnerDocumentType,
  ].filter(Boolean).join(' ').toLowerCase();

  return ['102', '103', '105', '106'].includes(code)
    || hasAnyText(text, ['повер', 'возврат', 'return', 'відмова'])
    || Boolean(tracking.LastCreatedOnTheBasisNumber);
}

function shipmentHasPayment(shipment) {
  return Boolean(shipment.payment && shipment.payment.type && shipment.payment.type !== 'none');
}

function shipmentHasReturn(shipment) {
  return Boolean(shipment.return && (shipment.return.status || shipment.return.returnNumber));
}

function getTrackingPhone(shipment) {
  return shipment.recipientPhone || shipment.senderPhone || '';
}

function getShipmentsReportTitle(filters) {
  if (filters.dateKey === getTodayDateKey()) {
    return 'Мої відправки за сьогодні:';
  }

  if (filters.dateKey) {
    return `Мої відправки за ${formatDateForUser(filters.dateKey)}:`;
  }

  if (filters.aliases && filters.aliases.length) {
    return `Мої відправки по ФОПах: ${filters.aliases.join(', ')}`;
  }

  return 'Мої відправки по всіх ФОПах:';
}

function getPaymentsReportTitle(filters) {
  if (filters.paymentStatus === 'waiting') {
    return 'Оплати, що очікуються:';
  }

  if (filters.paymentStatus === 'received') {
    return 'Отримані оплати:';
  }

  if (filters.aliases && filters.aliases.length) {
    return `Оплати по ФОПах: ${filters.aliases.join(', ')}`;
  }

  return 'Усі оплати:';
}

function getReturnsReportTitle(filters) {
  if (filters.dateKey === getTodayDateKey()) {
    return 'Повернення за сьогодні:';
  }

  if (filters.aliases && filters.aliases.length) {
    return `Повернення по ФОПах: ${filters.aliases.join(', ')}`;
  }

  return 'Усі повернення:';
}

function formatShipmentsReport(title, entries) {
  const lines = [title, ''];

  for (const group of groupEntriesByAlias(entries)) {
    lines.push(formatCabinetTitle(group.alias));

    for (const entry of group.entries) {
      lines.push(...formatShipmentSummaryLines(entry));
      lines.push('');
    }
  }

  if (entries.length === REPORT_LIMIT) {
    lines.push(`Показано останні ${REPORT_LIMIT} відправок.`);
  }

  return lines.join('\n').trim();
}

function formatPaymentsReport(title, entries) {
  const lines = [title, ''];

  for (const group of groupEntriesByAlias(entries)) {
    lines.push(formatCabinetTitle(group.alias));

    for (const entry of group.entries) {
      const payment = entry.shipment.payment || {};
      lines.push(`  ТТН: ${entry.number}`);
      lines.push(`  Отримувач: ${formatRecipientName(entry.shipment)}`);
      lines.push(`  Сума: ${formatMoneyText(payment.amount)}`);
      lines.push(`  Тип: ${payment.label || getPaymentTypeLabel(payment.type)}`);
      lines.push(`  Статус: ${formatPaymentStatus(payment)}`);
      lines.push('');
    }
  }

  return lines.join('\n').trim();
}

function formatReturnsReport(title, entries) {
  const lines = [title, ''];

  for (const group of groupEntriesByAlias(entries)) {
    lines.push(formatCabinetTitle(group.alias));

    for (const entry of group.entries) {
      const returnInfo = entry.shipment.return || {};
      lines.push(`  Початкова ТТН: ${entry.number}`);
      lines.push(`  Отримувач: ${formatRecipientName(entry.shipment)}`);
      lines.push(`  Статус: ${returnInfo.reason || returnInfo.status || getShipmentStatusText(entry.shipment)}`);
      lines.push(`  ТТН повернення: ${returnInfo.returnNumber || 'ще не отримано від Нової пошти'}`);
      lines.push(`  Статус повернення: ${returnInfo.status || 'оновлюється'}`);
      lines.push('');
    }
  }

  return lines.join('\n').trim();
}

function formatShipmentSummaryLines(entry) {
  const lines = [
    `  ТТН: ${entry.number}`,
    `  Отримувач: ${formatRecipientName(entry.shipment)}`,
    `  Дата: ${formatDateTimeForUser(entry.shipment.createdAt)}`,
    `  Статус: ${getShipmentStatusText(entry.shipment)}`,
  ];

  if (entry.shipment.recipientDeliveryPoint || entry.shipment.status && entry.shipment.status.deliveryPoint) {
    lines.push(`  Доставка: ${entry.shipment.status && entry.shipment.status.deliveryPoint || entry.shipment.recipientDeliveryPoint}`);
  }

  if (shipmentHasPayment(entry.shipment)) {
    lines.push(`  Оплата: ${formatPaymentLine(entry.shipment.payment)}`);
  }

  return lines;
}

function formatShipmentDetails(number, shipment) {
  const lines = [
    `ТТН: ${number}`,
    `ФОП: ${shipment.apiKeyAlias || 'невідомо'}`,
    `Дата створення: ${formatDateTimeForUser(shipment.createdAt)}`,
    `Отримувач: ${formatRecipientName(shipment)}`,
    `Статус доставки: ${getShipmentStatusText(shipment)}`,
    `Точка доставки: ${shipment.status && shipment.status.deliveryPoint || shipment.recipientDeliveryPoint || 'немає даних'}`,
  ];

  if (shipmentHasPayment(shipment)) {
    lines.push(`Оплата: ${formatPaymentLine(shipment.payment)}`);
    lines.push(`Статус оплати: ${formatPaymentStatus(shipment.payment)}`);
  } else {
    lines.push('Оплата: без накладеного платежу або контролю оплати');
  }

  if (shipment.return && (shipment.return.status || shipment.return.returnNumber)) {
    lines.push(`Повернення: ${shipment.return.returnNumber || 'номер ще не отримано'}, ${shipment.return.status || 'статус оновлюється'}`);
  }

  return lines.join('\n');
}

function groupEntriesByAlias(entries) {
  const groups = [];
  const byAlias = {};

  for (const entry of entries) {
    const alias = entry.shipment.apiKeyAlias || 'без кабінету';

    if (!byAlias[alias]) {
      byAlias[alias] = {
        alias,
        entries: [],
      };
      groups.push(byAlias[alias]);
    }

    byAlias[alias].entries.push(entry);
  }

  return groups;
}

function formatCabinetTitle(alias) {
  return `ФОП ${alias}`;
}

function formatRecipientName(shipment) {
  const name = shipment.recipientName || shipment.recipientContactName || 'немає даних';
  return shortenFullName(name);
}

function shortenFullName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);

  if (parts.length >= 2) {
    return `${parts[0]} ${parts[1].slice(0, 1)}.`;
  }

  return name || 'немає даних';
}

function getShipmentStatusText(shipment) {
  if (shipment.status && shipment.status.text) {
    return shipment.status.text;
  }

  if (shipment.raw && shipment.raw.StateName) {
    return shipment.raw.StateName;
  }

  return 'Створено, статус ще не оновлено';
}

function formatPaymentLine(payment) {
  if (!payment || !payment.type || payment.type === 'none') {
    return 'без оплати';
  }

  return `${payment.label || getPaymentTypeLabel(payment.type)}, ${formatMoneyText(payment.amount)}, ${formatPaymentStatus(payment)}`;
}

function formatPaymentStatus(payment) {
  const status = getPaymentStatusValue(payment);

  if (status === 'paid') {
    return 'оплачено';
  }

  if (status === 'received') {
    return 'отримано';
  }

  if (status === 'returned') {
    return 'повернено';
  }

  return 'очікується';
}

function getPaymentStatusValue(payment) {
  return payment && payment.status ? payment.status : 'waiting';
}

function formatMoneyText(value) {
  if (value === undefined || value === null || value === '') {
    return 'сума невідома';
  }

  return `${value} грн`;
}

function getShipmentDateKey(shipment) {
  return formatDateKey(shipment.createdAt);
}

function getShipmentTime(shipment) {
  const time = Date.parse(shipment.createdAt || '');
  return Number.isFinite(time) ? time : 0;
}

function getTodayDateKey() {
  return formatDateKey(new Date());
}

function formatDateKey(value) {
  const date = value instanceof Date ? value : new Date(value || '');

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: KYIV_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = getDatePart(parts, 'year');
  const month = getDatePart(parts, 'month');
  const day = getDatePart(parts, 'day');

  return `${year}-${month}-${day}`;
}

function getDatePart(parts, type) {
  const part = parts.find((item) => item.type === type);
  return part ? part.value : '';
}

function normalizeDateInput(value) {
  const text = String(value || '').trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (iso) {
    return validDateKey(iso[1], iso[2], iso[3]);
  }

  const dotted = text.match(/^(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?$/);

  if (!dotted) {
    return '';
  }

  let year = dotted[3] || getTodayDateKey().slice(0, 4);

  if (year.length === 2) {
    year = `20${year}`;
  }

  return validDateKey(year, dotted[2], dotted[1]);
}

function validDateKey(yearValue, monthValue, dayValue) {
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return '';
  }

  const date = new Date(Date.UTC(year, month - 1, day));

  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return '';
  }

  return [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0'),
  ].join('-');
}

function formatDateForUser(dateKey) {
  const parts = String(dateKey || '').split('-');

  if (parts.length !== 3) {
    return dateKey || 'невідома дата';
  }

  return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

function formatDateTimeForUser(value) {
  const date = new Date(value || '');

  if (Number.isNaN(date.getTime())) {
    return 'невідома дата';
  }

  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: KYIV_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function isTruthyApiValue(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

async function handleCreateTtnKeySelection(msg, flow, text) {
  const alias = normalizeAlias(text);
  const store = readStore();
  const aliases = getAvailableApiKeyAliases(msg, store);

  if (!store.apiKeys[alias] || !aliases.includes(alias)) {
    await sendText(msg.chat.id, 'Не бачу такого кабінету. Натисніть один із варіантів нижче.', keyboardOptions(makeButtonRows(aliases, 2, true)));
    return;
  }

  clearCreateTtnCabinetData(flow);
  flow.data.apiKeyAlias = alias;
  flow.step = 0;
  setFlow(msg, flow);

  await sendText(
    msg.chat.id,
    [
      `Обрано кабінет: ${alias}`,
      '',
      'Переходимо до даних відправлення.',
    ].join('\n'),
  );
  await askNextCreateTtnField(msg, flow);
}

async function offerAreaChoices(msg, flow, field, page) {
  const key = getApiKeyForCreateFlow(flow);
  const response = await callNovaPost(key.apiKey, 'Address', 'getAreas', {});
  const areas = response.data.map((area) => ({
    label: area.Description,
    value: area.Ref,
    description: area.Description,
    search: area.Description,
  }));

  if (!areas.length) {
    await sendText(msg.chat.id, 'Не вдалося знайти області. Натисніть "Назад" і спробуйте ще раз.', listChoiceOptions([]));
    return;
  }

  flow.mode = 'areaChoice';
  flow.pendingField = field.key;
  setPagedChoiceState(flow, field.prompt, areas, 2, page, areas.length);
  setFlow(msg, flow);

  await sendPagedChoiceList(msg, flow);
}

async function offerSettlementTypeChoices(msg, flow, field) {
  flow.mode = 'settlementTypeChoice';
  flow.pendingField = field.key;
  flow.pendingTitle = 'Оберіть тип населеного пункту.';
  flow.pendingChoices = SETTLEMENT_TYPE_CHOICES;
  setFlow(msg, flow);

  await sendText(msg.chat.id, flow.pendingTitle, listChoiceOptions(SETTLEMENT_TYPE_CHOICES, 2));
}

async function offerCityChoices(msg, flow, field, page) {
  const key = getApiKeyForCreateFlow(flow);
  const areaRef = flow.data[field.areaKey];

  if (!areaRef) {
    await sendText(msg.chat.id, 'Спочатку оберіть область, будь ласка.', flowOptions(field));
    return;
  }

  const methodProperties = {
    AreaRef: areaRef,
    Limit: String(CITY_CHOICES_LIMIT),
  };

  const response = await callNovaPost(key.apiKey, 'Address', 'getCities', methodProperties);
  let cities = response.data.map((city) => {
    const settlementType = city.SettlementTypeDescription || city.SettlementTypeDescriptionRu || '';
    const district = city.RegionsDescription || city.RegionDescription || city.DistrictDescription || '';
    const details = [settlementType, district].filter(Boolean).join(', ');
    const suffix = details ? ` (${details})` : '';
    return {
      label: `${city.Description}${suffix}`,
      value: city.Ref,
      description: city.Description,
      settlementType,
      search: `${city.Description} ${settlementType} ${district} ${city.AreaDescription || ''}`,
    };
  });
  const selectedType = flow.data[`${field.key}SettlementType`] || '';

  if (selectedType) {
    cities = cities.filter((city) => normalizeSearchText(city.settlementType) === normalizeSearchText(selectedType));
  }

  cities = sortCitiesByAreaMainCity(cities, flow.data[`${field.areaKey}Description`]);

  if (!cities.length) {
    await sendText(msg.chat.id, 'Населені пункти цього типу не знайдено. Натисніть "Назад" і оберіть інший тип.', listChoiceOptions([]));
    return;
  }

  flow.mode = 'cityChoice';
  flow.pendingField = field.key;
  setPagedChoiceState(flow, field.prompt, cities, 1, page);
  setFlow(msg, flow);

  await sendPagedChoiceList(msg, flow);
}

async function handleCreateTtnAreaChoice(msg, flow, text) {
  if (handleLocalChoicePageChange(flow, text)) {
    setFlow(msg, flow);
    await sendPagedChoiceList(msg, flow);
    return;
  }

  const choice = findChoiceByText(getCurrentPageChoices(flow), text);

  if (!choice) {
    setFlow(msg, flow);
    await sendText(msg.chat.id, 'Натисніть область зі списку нижче.', pagedChoiceOptions(flow));
    return;
  }

  flow.data[flow.pendingField] = choice.value;
  flow.data[`${flow.pendingField}Description`] = choice.description;
  flow.step += 1;
  delete flow.mode;
  delete flow.pendingField;
  clearPagedChoiceState(flow);

  await askNextCreateTtnField(msg, flow);
}

async function handleCreateTtnSettlementTypeChoice(msg, flow, text) {
  const choice = findChoiceByText(SETTLEMENT_TYPE_CHOICES, text);

  if (!choice) {
    await sendText(msg.chat.id, 'Натисніть тип населеного пункту зі списку нижче.', listChoiceOptions(SETTLEMENT_TYPE_CHOICES, 2));
    return;
  }

  const field = getCreateTtnFieldByKey(flow.pendingField);
  flow.data[`${field.key}SettlementType`] = choice.value;
  flow.data[`${field.key}SettlementTypeLabel`] = choice.label;
  delete flow.mode;
  delete flow.pendingField;
  clearPagedChoiceState(flow);

  await offerCityChoices(msg, flow, field, 1);
}

async function handleCreateTtnCityChoice(msg, flow, text) {
  if (handleLocalChoicePageChange(flow, text)) {
    setFlow(msg, flow);
    await sendPagedChoiceList(msg, flow);
    return;
  }

  const choice = findChoiceByText(getCurrentPageChoices(flow), text);

  if (!choice) {
    setFlow(msg, flow);
    await sendText(msg.chat.id, 'Натисніть населений пункт зі списку нижче.', pagedChoiceOptions(flow));
    return;
  }

  flow.data[flow.pendingField] = choice.value;
  flow.data[`${flow.pendingField}Description`] = choice.description;
  flow.step += 1;
  delete flow.mode;
  delete flow.pendingField;
  clearPagedChoiceState(flow);

  await askNextCreateTtnField(msg, flow);
}

async function offerDeliveryTypeChoices(msg, flow, field) {
  flow.mode = 'deliveryTypeChoice';
  flow.pendingField = field.key;
  flow.pendingTitle = 'Оберіть тип точки доставки.';
  flow.pendingChoices = DELIVERY_TYPE_CHOICES;
  setFlow(msg, flow);

  await sendText(msg.chat.id, flow.pendingTitle, listChoiceOptions(DELIVERY_TYPE_CHOICES, 2));
}

async function offerWarehouseStep(msg, flow, field) {
  if (field.fixedDeliveryType) {
    flow.data[`${field.key}DeliveryType`] = field.fixedDeliveryType;
    flow.data[`${field.key}DeliveryTypeLabel`] = field.fixedDeliveryTypeLabel || 'Відділення';
    await offerWarehouseChoices(msg, flow, field);
    return;
  }

  await offerDeliveryTypeChoices(msg, flow, field);
}

async function handleCreateTtnDeliveryTypeChoice(msg, flow, text) {
  const choice = findChoiceByText(DELIVERY_TYPE_CHOICES, text);

  if (!choice) {
    await sendText(msg.chat.id, 'Натисніть тип точки доставки зі списку нижче.', listChoiceOptions(DELIVERY_TYPE_CHOICES, 2));
    return;
  }

  const field = getCreateTtnFieldByKey(flow.pendingField);
  flow.data[`${field.key}DeliveryType`] = choice.value;
  flow.data[`${field.key}DeliveryTypeLabel`] = choice.label;
  delete flow.mode;
  delete flow.pendingField;
  clearPagedChoiceState(flow);

  await offerWarehouseChoices(msg, flow, field);
}

async function offerWarehouseChoices(msg, flow, field) {
  const cityRef = flow.data[field.cityKey];

  if (!cityRef) {
    await sendText(msg.chat.id, 'Спочатку потрібно обрати населений пункт. Почніть створення ТТН ще раз.', menuOptions(msg));
    clearFlow(msg);
    return;
  }

  const selectedDeliveryType = flow.data[`${field.key}DeliveryType`] || 'branch';
  const deliveryLabel = getDeliveryTypeText(selectedDeliveryType);

  flow.mode = 'warehouseNumber';
  flow.pendingField = field.key;
  flow.pendingWarehouseMode = field.warehouseRef ? 'ref' : 'name';
  setFlow(msg, flow);

  await sendText(
    msg.chat.id,
    `Введіть номер ${deliveryLabel}. Я перевірю його й покажу повну адресу.`,
    textInputOptions()
  );
}

async function handleCreateTtnWarehouseChoice(msg, flow, text) {
  const field = getCreateTtnFieldByKey(flow.pendingField);
  const warehouseNumber = normalizeWarehouseNumberInput(text);

  if (!warehouseNumber) {
    setFlow(msg, flow);
    await sendText(msg.chat.id, 'Номер виглядає некоректно. Введіть коректний номер, будь ласка.', textInputOptions());
    return;
  }

  const key = getApiKeyForCreateFlow(flow);
  const selectedDeliveryType = flow.data[`${field.key}DeliveryType`] || 'branch';
  const warehouse = await findWarehouseByNumber(key.apiKey, flow.data[field.cityKey], selectedDeliveryType, warehouseNumber);

  if (!warehouse) {
    setFlow(msg, flow);
    await sendText(msg.chat.id, 'Не знайшов таку точку доставки. Перевірте номер і введіть його ще раз.', textInputOptions());
    return;
  }

  flow.data[flow.pendingField] = getWarehouseFlowValue(field, warehouse, warehouseNumber);
  flow.data[`${flow.pendingField}Number`] = warehouse.Number || warehouseNumber;
  flow.data[`${flow.pendingField}Description`] = warehouse.Description;
  flow.data[`${flow.pendingField}Ref`] = warehouse.Ref;
  flow.step += 1;
  delete flow.mode;
  delete flow.pendingField;
  delete flow.pendingWarehouseMode;
  clearPagedChoiceState(flow);

  const confirmation = formatWarehouseStepConfirmation(flow, field, warehouse);

  if (confirmation) {
    if (field.key === 'SenderAddress') {
      flow.senderSummaryShown = true;
    }

    await sendText(msg.chat.id, confirmation, textInputOptions());
  }
  await askNextCreateTtnField(msg, flow);
}

function getWarehouseFlowValue(field, warehouse, warehouseNumber) {
  if (field.warehouseRef) {
    return warehouse.Ref || warehouse.Number || warehouse.Description;
  }

  return warehouse.Number || warehouseNumber;
}

function formatWarehouseStepConfirmation(flow, field, warehouse) {
  if (field.key === 'SenderAddress') {
    if (!flow.data.SendersPhone) {
      return '';
    }

    return formatSenderReadyMessage(flow);
  }

  return formatWarehouseConfirmation(flow, field, warehouse);
}

async function handleCreateTtnCorrectionChoice(msg, flow, text) {
  const choice = findChoiceByText(flow.pendingChoices || [], text);

  if (!choice) {
    await sendText(msg.chat.id, 'Натисніть, що потрібно змінити.', listChoiceOptions(flow.pendingChoices || [], 1));
    return;
  }

  delete flow.mode;
  delete flow.pendingChoices;
  clearPagedChoiceState(flow);

  if (choice.value === 'apiKeyAlias') {
    await offerCreateTtnCabinetCorrection(msg, flow);
    return;
  }

  if (choice.value === 'cod' || choice.value === 'none') {
    if (choice.value === 'cod') {
      flow.data.PaymentType = 'cod';
      flow.data.PaymentTypeLabel = getPaymentTypeLabel('cod');
      flow.step = getCreateTtnFieldIndex('PaymentAmount');
      setFlow(msg, flow);
      await sendText(msg.chat.id, getCreateTtnFieldByKey('PaymentAmount').prompt, textInputOptions());
      return;
    }

    flow.data.PaymentType = 'none';
    flow.data.PaymentTypeLabel = getPaymentTypeLabel('none');
    delete flow.data.PaymentAmount;
    flow.step = getCreateTtnFieldIndex('PaymentAmount') + 1;
    await askNextCreateTtnField(msg, flow);
    return;
  }

  const field = getCreateTtnFieldByKey(choice.value);
  removeCreateFlowValueAndDependents(flow, field);
  flow.step = getCreateTtnFieldIndex(field.key);
  await askNextCreateTtnField(msg, flow);
}

async function offerCreateTtnCabinetCorrection(msg, flow) {
  const store = readStore();
  const aliases = getAvailableApiKeyAliases(msg, store);

  clearCreateTtnCabinetData(flow);

  if (!aliases.length) {
    clearFlow(msg);
    await sendText(msg.chat.id, 'Додайте актуальний API-ключ Нової пошти й почніть створення ТТН ще раз.', menuOptions(msg));
    return;
  }

  if (aliases.length === 1) {
    clearFlow(msg);
    await sendText(
      msg.chat.id,
      'У боті зараз один кабінет НП, і Нова пошта не прийняла його дані. Перевірте цей кабінет або додайте інший API-ключ, а потім створіть ТТН ще раз.',
      menuOptions(msg)
    );
    return;
  }

  flow.step = -1;
  setFlow(msg, flow);
  await sendText(msg.chat.id, 'Оберіть кабінет Нової пошти.', keyboardOptions(makeButtonRows(aliases, 2, true)));
}

async function offerSenderWarehouseDefaults(msg, flow, field) {
  const defaults = getDefaultSenderWarehouses(msg, flow.data.apiKeyAlias);

  if (!defaults.length) {
    return false;
  }

  const choices = defaults.map((warehouse) => ({
    label: trimButtonLabel(formatDefaultSenderWarehouseButtonLabel(warehouse)),
    value: warehouse.id,
    description: warehouse.name,
    warehouse,
  }));

  choices.push({
    label: BUTTONS.customSenderWarehouse,
    value: BUTTONS.customSenderWarehouse,
    description: BUTTONS.customSenderWarehouse,
  });

  flow.mode = 'senderWarehouseDefaultChoice';
  flow.pendingField = field.key;
  flow.pendingChoices = choices;
  setFlow(msg, flow);

  await sendText(
    msg.chat.id,
    'Звідки відправляємо?',
    listChoiceOptions(choices, 1)
  );
  return true;
}

async function handleCreateTtnSenderWarehouseDefaultChoice(msg, flow, text) {
  const choice = findChoiceByText(flow.pendingChoices || [], text);

  if (!choice) {
    await sendText(msg.chat.id, 'Натисніть відділення зі списку нижче.', listChoiceOptions(flow.pendingChoices || [], 1));
    return;
  }

  const field = getCreateTtnFieldByKey(flow.pendingField);
  delete flow.mode;
  delete flow.pendingField;
  clearPagedChoiceState(flow);

  if (choice.value === BUTTONS.customSenderWarehouse) {
    await offerAreaChoices(msg, flow, field, 1);
    return;
  }

  applyDefaultSenderWarehouse(flow, choice.warehouse);
  flow.step = getCreateTtnFieldIndex('SenderAddress') + 1;

  const confirmation = flow.data.SendersPhone ? formatSenderReadyMessage(flow) : '';

  if (confirmation) {
    flow.senderSummaryShown = true;
    await sendText(msg.chat.id, confirmation);
  }
  await askNextCreateTtnField(msg, flow);
}

async function offerSenderChoices(msg, flow, field) {
  const key = getApiKeyForCreateFlow(flow);
  const senders = await fetchSenderChoices(key.apiKey);

  if (!senders.length) {
    const choices = addSenderActionChoices([]);
    flow.mode = 'senderChoice';
    flow.pendingField = field.key;
    setPagedChoiceState(flow, 'У цьому кабінеті не знайдено відправників.', choices, 1, 1);
    setFlow(msg, flow);
    await sendText(msg.chat.id, 'Створіть відправника в кабінеті Нової пошти й натисніть "Оновити список".', pagedChoiceOptions(flow));
    return;
  }

  flow.data[field.key] = senders[0].value;
  flow.data[`${field.key}Description`] = senders[0].description;
  flow.step += 1;
  delete flow.mode;
  delete flow.pendingField;
  clearPagedChoiceState(flow);

  await askNextCreateTtnField(msg, flow);
}

async function handleCreateTtnSenderChoice(msg, flow, text) {
  if (handleLocalChoicePageChange(flow, text)) {
    setFlow(msg, flow);
    await sendPagedChoiceList(msg, flow);
    return;
  }

  if (await handleSenderActionChoice(msg, flow, text, () => offerSenderChoices(msg, flow, getCreateTtnFieldByKey(flow.pendingField)))) {
    return;
  }

  const choice = findChoiceByText(getCurrentPageChoices(flow), text);

  if (!choice) {
    setFlow(msg, flow);
    await sendText(msg.chat.id, 'Натисніть ФОП або компанію зі списку нижче.', pagedChoiceOptions(flow));
    return;
  }

  flow.data[flow.pendingField] = choice.value;
  flow.data[`${flow.pendingField}Description`] = choice.description;
  flow.step += 1;
  delete flow.mode;
  delete flow.pendingField;
  clearPagedChoiceState(flow);

  await askNextCreateTtnField(msg, flow);
}

async function offerSenderContactChoices(msg, flow, field) {
  const key = getApiKeyForCreateFlow(flow);
  const senderRef = flow.data[field.senderKey];

  if (!senderRef) {
    await sendText(msg.chat.id, 'Спочатку оберіть ФОП або компанію відправника.', listChoiceOptions([]));
    return;
  }

  const contacts = await fetchSenderContactChoices(key.apiKey, senderRef);

  if (!contacts.length) {
    await sendText(msg.chat.id, 'Для цього відправника не знайдено контактних осіб.', listChoiceOptions([]));
    return;
  }

  const contact = pickPreferredSenderContact(contacts);
  flow.data[field.key] = contact.value;
  flow.data[`${field.key}Description`] = contact.description;

  if (contact.phone) {
    flow.data.SendersPhone = contact.phone;
  }

  flow.step += 1;
  delete flow.mode;
  delete flow.pendingField;
  clearPagedChoiceState(flow);

  await askNextCreateTtnField(msg, flow);
}

async function handleCreateTtnSenderContactChoice(msg, flow, text) {
  if (handleLocalChoicePageChange(flow, text)) {
    setFlow(msg, flow);
    await sendPagedChoiceList(msg, flow);
    return;
  }

  const choice = findChoiceByText(getCurrentPageChoices(flow), text);

  if (!choice) {
    setFlow(msg, flow);
    await sendText(msg.chat.id, 'Натисніть контактну особу зі списку нижче.', pagedChoiceOptions(flow));
    return;
  }

  flow.data[flow.pendingField] = choice.value;
  flow.data[`${flow.pendingField}Description`] = choice.description;

  if (choice.phone) {
    flow.data.SendersPhone = choice.phone;
  }

  flow.step += 1;
  delete flow.mode;
  delete flow.pendingField;
  clearPagedChoiceState(flow);

  await askNextCreateTtnField(msg, flow);
}

async function askNextCreateTtnField(msg, flow) {
  if (flow.step < CREATE_TTN_FIELDS.length) {
    while (flow.step < CREATE_TTN_FIELDS.length
      && (flow.data[CREATE_TTN_FIELDS[flow.step].key] || shouldSkipCreateTtnField(flow, CREATE_TTN_FIELDS[flow.step]))) {
      flow.step += 1;
    }
  }

  if (flow.step < CREATE_TTN_FIELDS.length) {
    const nextField = CREATE_TTN_FIELDS[flow.step];
    await sendCreateTtnSectionNotice(msg, flow, nextField);
    setFlow(msg, flow);

    if (nextField.key === 'AreaSender' && await offerSenderWarehouseDefaults(msg, flow, nextField)) {
      return;
    }

    if (nextField.areaRef) {
      await offerAreaChoices(msg, flow, nextField, 1);
      return;
    }

    if (nextField.cityRef) {
      await offerSettlementTypeChoices(msg, flow, nextField);
      return;
    }

    if (nextField.warehouseRef || nextField.warehouseName) {
      await offerWarehouseStep(msg, flow, nextField);
      return;
    }

    if (nextField.senderCounterparty) {
      await offerSenderChoices(msg, flow, nextField);
      return;
    }

    if (nextField.senderContact) {
      await offerSenderContactChoices(msg, flow, nextField);
      return;
    }

    await sendText(msg.chat.id, nextField.prompt, createTtnFieldOptions(nextField));
    return;
  }

  await finishCreateTtnFlow(msg, flow);
}

async function sendCreateTtnSectionNotice(msg, flow, field) {
  if (field.key === 'Sender' && !flow.senderSectionShown) {
    flow.senderSectionShown = true;
    await sendText(
      msg.chat.id,
      'Тепер заповнюємо дані відправника 👤 Відправлення оформлюємо з відділення Нової пошти.'
    );
    return;
  }

  if (field.key === 'AreaRecipient' && !flow.recipientSectionShown) {
    flow.recipientSectionShown = true;

    if (flow.senderSummaryShown) {
      return;
    }

    await sendText(
      msg.chat.id,
      'Дані відправника готові ✅ Переходимо до отримувача: область, населений пункт і точка доставки.'
    );
  }
}

function normalizeFieldValue(field, value) {
  if (field.options && field.options.length && value !== BUTTONS.skip) {
    const option = field.options.find((item) => normalizeSearchText(getFieldOptionLabel(item)) === normalizeSearchText(value));

    if (!option) {
      const labels = field.options.map((item) => getFieldOptionLabel(item));
      return {
        ok: false,
        message: `Оберіть один із варіантів: ${labels.join(', ')}.`,
      };
    }

    return {
      ok: true,
      value: getFieldOptionValue(option),
    };
  }

  if (field.format === 'weight') {
    return normalizeWeight(value);
  }

  if (field.format === 'money') {
    return normalizeMoney(value);
  }

  if (field.format === 'integer') {
    return normalizePositiveInteger(value);
  }

  if (field.format === 'phone') {
    return normalizePhone(value);
  }

  if (field.format === 'fullName') {
    return normalizeFullName(value);
  }

  return {
    ok: true,
    value,
  };
}

function shouldSkipCreateTtnField(flow, field) {
  if (field.paymentAmount) {
    return flow.data.PaymentType !== 'cod' && flow.data.PaymentType !== 'paymentControl';
  }

  return false;
}

function getFieldOptionLabel(option) {
  if (typeof option === 'string') {
    return option;
  }

  return option.label;
}

function getFieldOptionValue(option) {
  if (typeof option === 'string') {
    return option;
  }

  return option.value;
}

function getCreateTtnFieldByKey(key) {
  const field = CREATE_TTN_FIELDS.find((item) => item.key === key);

  if (!field) {
    throw new Error('Не вдалося визначити крок створення ТТН. Почніть створення ще раз.');
  }

  return field;
}

function getDefaultSenderWarehouseFieldByKey(key) {
  const field = DEFAULT_SENDER_WAREHOUSE_FIELDS.find((item) => item.key === key);

  if (!field) {
    throw new Error('Не вдалося визначити крок стандартного відділення. Почніть ще раз.');
  }

  return field;
}

function getCreateTtnFieldIndex(key) {
  const index = CREATE_TTN_FIELDS.findIndex((item) => item.key === key);

  if (index < 0) {
    throw new Error('Не вдалося визначити крок створення ТТН. Почніть створення ще раз.');
  }

  return index;
}

function getDefaultSenderWarehouses(msg, alias) {
  const user = assertLoggedIn(msg);
  const store = readStore();
  const userWarehouses = store.defaultSenderWarehouses && store.defaultSenderWarehouses[user.login]
    ? store.defaultSenderWarehouses[user.login]
    : {};
  const warehouses = userWarehouses[normalizeAlias(alias)] || [];

  return warehouses.filter((warehouse) => {
    return warehouse.cityRef && warehouse.warehouseRef;
  });
}

function applyDefaultSenderWarehouse(flow, warehouse) {
  flow.data.AreaSender = warehouse.areaRef;
  flow.data.AreaSenderDescription = warehouse.areaDescription;
  flow.data.CitySender = warehouse.cityRef;
  flow.data.CitySenderDescription = warehouse.cityDescription;
  flow.data.CitySenderSettlementType = warehouse.settlementType;
  flow.data.CitySenderSettlementTypeLabel = warehouse.settlementTypeLabel;
  flow.data.SenderAddress = warehouse.warehouseRef;
  flow.data.SenderAddressRef = warehouse.warehouseRef;
  flow.data.SenderAddressNumber = warehouse.warehouseNumber;
  flow.data.SenderAddressDescription = warehouse.warehouseDescription;
  flow.data.SenderAddressDeliveryType = 'branch';
  flow.data.SenderAddressDeliveryTypeLabel = 'Відділення';
}

function formatDefaultSenderWarehouseButtonLabel(warehouse) {
  const number = warehouse.warehouseNumber ? `№${warehouse.warehouseNumber}` : '';
  const city = warehouse.cityDescription || '';
  const details = [city, number].filter(Boolean).join(', ');

  if (!details) {
    return warehouse.name;
  }

  return `${warehouse.name}: ${details}`;
}

function formatSenderReadyMessage(flow) {
  const lines = ['Відправник готовий ✅'];
  const sender = flow.data.SenderDescription || '';
  const contact = flow.data.ContactSenderDescription || '';
  const phone = flow.data.SendersPhone || '';
  const city = flow.data.CitySenderDescription || '';
  const deliveryType = flow.data.SenderAddressDeliveryTypeLabel || 'Відділення';
  const number = flow.data.SenderAddressNumber ? `№${flow.data.SenderAddressNumber}` : '';
  const address = flow.data.SenderAddressDescription || '';
  const point = [deliveryType, number, city, address].filter(Boolean).join(', ');

  if (sender) {
    lines.push(`👤 ${sender}`);
  }

  if (contact || phone) {
    lines.push(`☎️ ${[contact, phone].filter(Boolean).join(', ')}`);
  }

  if (point) {
    lines.push(`🏤 ${point}`);
  }

  return lines.join('\n');
}

function addSenderActionChoices(senders) {
  return senders.concat([
    {
      label: BUTTONS.createSender,
      value: BUTTONS.createSender,
      description: BUTTONS.createSender,
    },
    {
      label: BUTTONS.refreshList,
      value: BUTTONS.refreshList,
      description: BUTTONS.refreshList,
    },
  ]);
}

async function handleSenderActionChoice(msg, flow, text, refreshCallback) {
  if (text === BUTTONS.refreshList) {
    clearPagedChoiceState(flow);
    await refreshCallback();
    return true;
  }

  if (text === BUTTONS.createSender) {
    await sendText(
      msg.chat.id,
      [
        'Нового відправника потрібно створити в кабінеті Нової пошти для цього API-ключа.',
        'Після створення поверніться сюди й натисніть "Оновити список".',
      ].join('\n'),
      pagedChoiceOptions(flow)
    );
    return true;
  }

  return false;
}

async function fetchSenderChoices(apiKey) {
  const senders = [];

  for (let page = 1; page <= 20; page += 1) {
    const response = await callNovaPost(apiKey, 'Counterparty', 'getCounterparties', {
      CounterpartyProperty: 'Sender',
      Page: String(page),
    });
    const pageItems = (response.data || []).map((counterparty) => ({
      label: trimButtonLabel(formatCounterpartyButtonLabel(counterparty)),
      value: counterparty.Ref,
      description: counterparty.Description,
      search: counterparty.Description,
    }));

    senders.push(...pageItems);

    if (!pageItems.length) {
      break;
    }
  }

  return uniqueChoicesByValue(senders);
}

async function fetchSenderContactChoices(apiKey, senderRef) {
  const contacts = [];

  for (let page = 1; page <= 20; page += 1) {
    const response = await callNovaPost(apiKey, 'Counterparty', 'getCounterpartyContactPersons', {
      Ref: senderRef,
      Page: String(page),
    });
    const pageItems = (response.data || []).map((contact) => ({
      label: trimButtonLabel(formatContactButtonLabel(contact)),
      value: contact.Ref,
      description: contact.Description,
      phone: firstPhone(contact.Phones),
      search: `${contact.Description} ${contact.Phones || ''}`,
    }));

    contacts.push(...pageItems);

    if (!pageItems.length) {
      break;
    }
  }

  return uniqueChoicesByValue(contacts);
}

function pickPreferredSenderContact(contacts) {
  return contacts.find((contact) => contact.phone) || contacts[0];
}

function uniqueChoicesByValue(choices) {
  const seen = new Set();
  const result = [];

  for (const choice of choices) {
    if (!choice.value || seen.has(choice.value)) {
      continue;
    }

    seen.add(choice.value);
    result.push(choice);
  }

  return result;
}

function sortCitiesByAreaMainCity(cities, areaDescription) {
  const mainCity = MAIN_CITY_BY_AREA[normalizeAreaKey(areaDescription)];

  if (!mainCity) {
    return cities;
  }

  const normalizedMainCity = normalizeSearchText(mainCity);

  return cities.slice().sort((left, right) => {
    const leftIsMain = normalizeSearchText(left.description) === normalizedMainCity;
    const rightIsMain = normalizeSearchText(right.description) === normalizedMainCity;

    if (leftIsMain && !rightIsMain) {
      return -1;
    }

    if (!leftIsMain && rightIsMain) {
      return 1;
    }

    return 0;
  });
}

function normalizeAreaKey(value) {
  return normalizeSearchText(value)
    .replace(/\s+область$/, '')
    .replace(/\s+обл$/, '')
    .trim();
}

function normalizeWarehouseNumberInput(value) {
  const normalized = String(value || '').trim().replace(/^№\s*/, '');

  if (!/^\d+$/.test(normalized)) {
    return '';
  }

  return String(Number.parseInt(normalized, 10));
}

async function findWarehouseByNumber(apiKey, cityRef, deliveryType, warehouseNumber) {
  const methodProperties = {
    CityRef: cityRef,
    WarehouseId: warehouseNumber,
    Limit: String(WAREHOUSE_SEARCH_LIMIT),
  };
  const warehouseTypeRef = getWarehouseTypeRef(deliveryType);

  if (warehouseTypeRef) {
    methodProperties.TypeOfWarehouseRef = warehouseTypeRef;
  }

  const response = await callNovaPost(apiKey, 'Address', 'getWarehouses', methodProperties);
  const warehouse = pickWarehouseByNumber(response.data, deliveryType, warehouseNumber);

  if (warehouse) {
    return warehouse;
  }

  return findWarehouseByString(apiKey, cityRef, deliveryType, warehouseNumber);
}

async function findWarehouseByString(apiKey, cityRef, deliveryType, warehouseNumber) {
  const methodProperties = {
    CityRef: cityRef,
    FindByString: warehouseNumber,
    Limit: String(WAREHOUSE_SEARCH_LIMIT),
  };
  const warehouseTypeRef = getWarehouseTypeRef(deliveryType);

  if (warehouseTypeRef) {
    methodProperties.TypeOfWarehouseRef = warehouseTypeRef;
  }

  const response = await callNovaPost(apiKey, 'Address', 'getWarehouses', methodProperties);
  return pickWarehouseByNumber(response.data, deliveryType, warehouseNumber);
}

function pickWarehouseByNumber(warehouses, deliveryType, warehouseNumber) {
  return (warehouses || []).find((warehouse) => {
    if (!warehouseMatchesDeliveryType(warehouse, deliveryType)) {
      return false;
    }

    return normalizeWarehouseNumberInput(warehouse.Number) === warehouseNumber;
  }) || null;
}

function getDeliveryTypeText(deliveryType) {
  if (deliveryType === 'postomat') {
    return 'поштомату';
  }

  return 'відділення';
}

function formatWarehouseConfirmation(flow, field, warehouse) {
  const cityField = getCreateTtnFieldByKey(field.cityKey);
  const area = formatAreaDescription(flow.data[`${cityField.areaKey}Description`]);
  const settlementType = flow.data[`${field.cityKey}SettlementTypeLabel`] || '';
  const city = flow.data[`${field.cityKey}Description`] || '';
  const deliveryType = flow.data[`${field.key}DeliveryTypeLabel`] || getWarehouseTypeLabel(warehouse);
  const number = warehouse.Number ? `№${warehouse.Number}` : '';
  const address = warehouse.ShortAddress || warehouse.Description || '';
  const settlement = [settlementType, city].filter(Boolean).join(' ');
  const point = [deliveryType, number].filter(Boolean).join(' ');

  return `Готово, обрано: ${[area, settlement, point, address].filter(Boolean).join(', ')}`;
}

function formatAreaDescription(value) {
  const description = String(value || '').trim();
  const normalized = normalizeSearchText(description);

  if (!description || normalized.includes('область') || normalized.includes('обл')) {
    return description;
  }

  return `${description} область`;
}

function getWarehouseTypeLabel(warehouse) {
  const category = String(warehouse.CategoryOfWarehouse || '').toLowerCase();
  const typeRef = String(warehouse.TypeOfWarehouse || '').toLowerCase();
  const description = String(warehouse.Description || '').toLowerCase();

  if (category.includes('postomat') || POSTOMAT_TYPE_REFS.includes(typeRef) || description.includes('поштомат')) {
    return 'Поштомат';
  }

  if (description.includes('пункт')) {
    return 'Пункт';
  }

  return 'Відділення';
}

function getWarehouseTypeRef(deliveryType) {
  if (deliveryType === 'postomat') {
    return 'f9316480-5f2d-425d-bc2c-ac7cd29decf0';
  }

  return '';
}

function warehouseMatchesDeliveryType(warehouse, deliveryType) {
  const typeRef = String(warehouse.TypeOfWarehouse || '').toLowerCase();
  const isPostomat = POSTOMAT_TYPE_REFS.includes(typeRef)
    || String(warehouse.CategoryOfWarehouse || '').toLowerCase().includes('postomat')
    || String(warehouse.Description || '').toLowerCase().includes('поштомат');

  if (deliveryType === 'postomat') {
    return isPostomat;
  }

  return !isPostomat;
}

function formatCounterpartyButtonLabel(counterparty) {
  const name = counterparty.Description || counterparty.DescriptionRu || 'Відправник';
  const type = counterparty.OwnershipFormDescription || counterparty.CounterpartyTypeDescription || '';

  if (!type) {
    return name;
  }

  return `${type} ${name}`;
}

function formatContactButtonLabel(contact) {
  const name = contact.Description || 'Контактна особа';
  const phone = firstPhone(contact.Phones);

  if (!phone) {
    return name;
  }

  return `${name}: ${phone}`;
}

function firstPhone(value) {
  const phones = String(value || '').split(',');

  for (const phone of phones) {
    const normalized = normalizePhoneText(phone);

    if (normalized) {
      return normalized;
    }
  }

  return '';
}

function normalizePhoneText(value) {
  const digits = String(value || '').replace(/\D/g, '');

  if (digits.length === 12 && digits.startsWith('380')) {
    return digits;
  }

  if (digits.length === 10 && digits.startsWith('0')) {
    return `38${digits}`;
  }

  return '';
}

function setPagedChoiceState(flow, title, choices, columns, page, pageSize) {
  flow.pendingTitle = title;
  flow.pendingChoices = choices;
  flow.pendingColumns = columns;
  flow.pendingPageSize = pageSize || CHOICE_PAGE_SIZE;
  flow.pendingPage = normalizeChoicePage(page, choices, flow.pendingPageSize);
}

function clearPagedChoiceState(flow) {
  delete flow.pendingTitle;
  delete flow.pendingChoices;
  delete flow.pendingColumns;
  delete flow.pendingPageSize;
  delete flow.pendingPage;
}

async function sendPagedChoiceList(msg, flow) {
  await sendText(msg.chat.id, pagedChoiceTitle(flow), pagedChoiceOptions(flow));
}

function listChoiceOptions(choices, columns = 1) {
  const buttons = choices.map((choice) => choice.label);
  const rows = makeButtonRows(buttons, columns, false);
  rows.push([BUTTONS.back, BUTTONS.cancel]);
  return keyboardOptions(rows);
}

function pagedChoiceOptions(flow) {
  const choices = getCurrentPageChoices(flow);
  const buttons = choices.map((choice) => choice.label);
  const rows = makeButtonRows(buttons, flow.pendingColumns || 1, false);
  const navRow = [];
  const totalPages = getChoicePageCount(flow.pendingChoices || [], flow.pendingPageSize);

  if (flow.pendingPage > 1) {
    navRow.push(BUTTONS.previousPage);
  }

  if (flow.pendingPage < totalPages) {
    navRow.push(BUTTONS.nextPage);
  }

  if (navRow.length) {
    rows.push(navRow);
  }

  rows.push([BUTTONS.back, BUTTONS.cancel]);
  return keyboardOptions(rows);
}

function pagedChoiceTitle(flow) {
  return flow.pendingTitle;
}

function getCurrentPageChoices(flow) {
  const choices = flow.pendingChoices || [];

  const page = normalizeChoicePage(flow.pendingPage, choices, flow.pendingPageSize);
  const pageSize = flow.pendingPageSize || CHOICE_PAGE_SIZE;
  const start = (page - 1) * pageSize;
  return choices.slice(start, start + pageSize);
}

function handleLocalChoicePageChange(flow, text) {
  const totalPages = getChoicePageCount(flow.pendingChoices || [], flow.pendingPageSize);

  if (text === BUTTONS.previousPage && flow.pendingPage > 1) {
    flow.pendingPage -= 1;
    return true;
  }

  if (text === BUTTONS.nextPage && flow.pendingPage < totalPages) {
    flow.pendingPage += 1;
    return true;
  }

  return false;
}

function normalizeChoicePage(page, choices, pageSize) {
  const number = Number.parseInt(page, 10);
  const totalPages = getChoicePageCount(choices || [], pageSize);

  if (!Number.isInteger(number) || number < 1) {
    return 1;
  }

  if (number > totalPages) {
    return totalPages;
  }

  return number;
}

function getChoicePageCount(choices, pageSize) {
  return Math.max(1, Math.ceil(choices.length / (pageSize || CHOICE_PAGE_SIZE)));
}

function findChoiceByText(choices, text) {
  const number = Number.parseInt(text, 10);

  if (Number.isInteger(number) && number > 0 && number <= choices.length) {
    return choices[number - 1];
  }

  const normalizedText = normalizeSearchText(text);

  return choices.find((choice) => {
    const label = normalizeSearchText(choice.label);
    const description = normalizeSearchText(choice.description);
    const value = normalizeSearchText(choice.value);
    const ref = normalizeSearchText(choice.ref);
    return label === normalizedText
      || description === normalizedText
      || value === normalizedText
      || ref === normalizedText;
  }) || null;
}

function removeCreateFlowValue(flow, field) {
  delete flow.data[field.key];
  delete flow.data[`${field.key}Description`];
  delete flow.data[`${field.key}Label`];
  delete flow.data[`${field.key}Ref`];
  delete flow.data[`${field.key}Number`];
  delete flow.data[`${field.key}SettlementType`];
  delete flow.data[`${field.key}SettlementTypeLabel`];
  delete flow.data[`${field.key}DeliveryType`];
  delete flow.data[`${field.key}DeliveryTypeLabel`];
}

function removeCreateFlowValueAndDependents(flow, field) {
  removeCreateFlowValue(flow, field);

  if (field.key === 'AreaSender') {
    removeCreateFlowValue(flow, { key: 'CitySender' });
    removeCreateFlowValue(flow, { key: 'SenderAddress' });
  }

  if (field.key === 'CitySender') {
    removeCreateFlowValue(flow, { key: 'SenderAddress' });
  }

  if (field.key === 'PaymentType') {
    removeCreateFlowValue(flow, { key: 'PaymentAmount' });
  }

  if (field.key === 'AreaRecipient') {
    removeCreateFlowValue(flow, { key: 'CityRecipient' });
    removeCreateFlowValue(flow, { key: 'RecipientAddressName' });
  }

  if (field.key === 'CityRecipient') {
    removeCreateFlowValue(flow, { key: 'RecipientAddressName' });
  }
}

function clearCreateTtnCabinetData(flow) {
  const keys = [
    'apiKeyAlias',
    'Sender',
    'ContactSender',
    'AreaSender',
    'CitySender',
    'SenderAddress',
    'SendersPhone',
    'PaymentType',
    'PaymentAmount',
  ];

  for (const key of keys) {
    removeCreateFlowValue(flow, { key });
  }

  delete flow.senderSectionShown;
  delete flow.senderSummaryShown;
}

function removeDefaultSenderWarehouseValue(flow, field) {
  delete flow.data[field.key];
  delete flow.data[`${field.key}Description`];
  delete flow.data[`${field.key}Ref`];
  delete flow.data[`${field.key}Number`];
  delete flow.data[`${field.key}SettlementType`];
  delete flow.data[`${field.key}SettlementTypeLabel`];
  delete flow.data[`${field.key}DeliveryType`];
  delete flow.data[`${field.key}DeliveryTypeLabel`];
}

async function finishCreateTtnFlow(msg, flow) {
  const data = flow.data;
  const key = getApiKeyForCreateFlow({ data });

  await sendText(msg.chat.id, 'Дані зібрано ✅ Створюю ТТН.');

  try {
    const methodProperties = await buildTtnProperties(key.apiKey, data);
    const paymentControlAvailable = await checkPaymentControlAvailable(key.apiKey, data, methodProperties);

    if (!paymentControlAvailable) {
      flow.mode = 'paymentControlUnavailableChoice';
      flow.pendingChoices = getPaymentControlUnavailableChoices();
      setFlow(msg, flow);
      await sendPaymentControlUnavailableMessage(msg, flow);
      return;
    }

    await createTtnFromProperties(msg, methodProperties, key, data);
    clearFlow(msg);
  } catch (error) {
    if (await handleCreateTtnCreationError(msg, flow, error)) {
      return;
    }

    throw error;
  }
}

async function handleCreateTtnCreationError(msg, flow, error) {
  if (!error || !error.isNovaPostApiError) {
    return false;
  }

  const correction = getCreateTtnErrorCorrection(error, flow.data);
  flow.mode = 'createTtnCorrectionChoice';
  flow.pendingChoices = correction.choices;
  setFlow(msg, flow);

  await sendText(msg.chat.id, correction.message, listChoiceOptions(correction.choices, 1));
  return true;
}

function getCreateTtnErrorCorrection(error, data) {
  const details = getNovaPostErrorDetails(error);
  const normalized = details.toLowerCase();
  const maxWeight = getMaxAllowedWeight(details);

  if (normalized.includes('recipient warehouse') && normalized.includes('max allowed weight')) {
    return {
      message: [
        'Не вдалося створити ТТН.',
        'Ця точка доставки отримувача не приймає таку вагу.',
        data.Weight ? `Вага в ТТН: ${data.Weight} кг.` : '',
        maxWeight ? `Ліміт для цієї точки: до ${maxWeight} кг.` : '',
        'Можемо зменшити вагу або вибрати іншу точку доставки отримувача.',
      ].filter(Boolean).join('\n'),
      choices: [
        createCorrectionChoice(BUTTONS.changeWeight, 'Weight'),
        createCorrectionChoice(BUTTONS.changeRecipientDeliveryPoint, 'RecipientAddressName'),
      ],
    };
  }

  if (hasAnyText(normalized, ['sender', 'contactsender', 'counterparty', 'contact person'])
    && !hasAnyText(normalized, ['sender warehouse', 'senderaddress', 'sender address', 'sender city', 'citysender', 'phone'])) {
    return createSingleFieldCorrection(
      'Не вдалося створити ТТН.\nНова пошта не прийняла відправника або контакт у цьому кабінеті. Перевірте кабінет Нової пошти або оберіть інший кабінет.',
      BUTTONS.changeCabinet,
      'apiKeyAlias'
    );
  }

  if (hasAnyText(normalized, ['max declared cost', 'declared cost', 'cost is too high', 'cost max', 'оголошен', 'варт'])) {
    return createSingleFieldCorrection(
      'Не вдалося створити ТТН.\nОголошена вартість не підходить для цієї точки доставки або типу відправлення. Введіть іншу суму.',
      BUTTONS.changeCost,
      'Cost'
    );
  }

  if (isPaymentControlUnavailableError(error)) {
    return {
      message: [
        'На цьому акаунті Нової пошти недоступний контроль оплати.',
        'Щоб використовувати цю функцію, потрібно підписати договір з Новою Поштою в особистому кабінеті.',
      ].join('\n'),
      choices: getPaymentControlUnavailableChoices(),
    };
  }

  if (hasAnyText(normalized, ['sender warehouse', 'senderaddress', 'sender address', 'sender warehouse index'])
    || (hasAnyText(normalized, ['відправника']) && hasAnyText(normalized, ['відділен', 'адрес']))) {
    return createSingleFieldCorrection(
      'Не вдалося створити ТТН.\nНова пошта не прийняла точку відправника. Виберіть інше відділення відправника.',
      BUTTONS.changeSenderDeliveryPoint,
      'SenderAddress'
    );
  }

  if (hasAnyText(normalized, ['recipient warehouse', 'recipientaddress', 'recipient address', 'recipient warehouse index', 'відділен', 'поштомат', 'адрес'])) {
    return createSingleFieldCorrection(
      'Не вдалося створити ТТН.\nНова пошта не прийняла точку доставки отримувача. Виберіть інше відділення або поштомат.',
      BUTTONS.changeRecipientDeliveryPoint,
      'RecipientAddressName'
    );
  }

  if (hasAnyText(normalized, ['weight', 'volumeweight', 'volumegeneral', 'dimensions', 'volumetric', 'вага', 'габарит'])) {
    return createSingleFieldCorrection(
      'Не вдалося створити ТТН.\nНова пошта не прийняла вагу посилки. Введіть іншу вагу.',
      BUTTONS.changeWeight,
      'Weight'
    );
  }

  if (hasAnyText(normalized, ['afterpayment', 'backwarddelivery', 'redelivery'])) {
    return createSingleFieldCorrection(
      'Не вдалося створити ТТН.\nНова пошта не прийняла суму оплати. Введіть іншу суму.',
      BUTTONS.changePaymentAmount,
      'PaymentAmount'
    );
  }

  if (hasAnyText(normalized, ['cost', 'варт'])) {
    return createSingleFieldCorrection(
      'Не вдалося створити ТТН.\nНова пошта не прийняла оголошену вартість. Введіть іншу суму.',
      BUTTONS.changeCost,
      'Cost'
    );
  }

  if (hasAnyText(normalized, ['recipientsphone', 'recipient phone', 'phone recipient', 'contactrecipient phone', 'телефон отримувача', 'телефон одержувача'])) {
    return createSingleFieldCorrection(
      'Не вдалося створити ТТН.\nНова пошта не прийняла телефон отримувача. Введіть номер ще раз.',
      BUTTONS.changeRecipientPhone,
      'RecipientsPhone'
    );
  }

  if (hasAnyText(normalized, ['sendersphone', 'sender phone', 'phone sender', 'contactsender phone', 'телефон відправника'])) {
    return createSingleFieldCorrection(
      'Не вдалося створити ТТН.\nНова пошта не прийняла телефон відправника. Введіть номер ще раз.',
      BUTTONS.changeSenderPhone,
      'SendersPhone'
    );
  }

  if (hasAnyText(normalized, ['recipientname', 'recipient name', 'recipientcontactname', 'recipient contact name', 'піб отримувача', 'піб одержувача'])) {
    return createSingleFieldCorrection(
      'Не вдалося створити ТТН.\nНова пошта не прийняла ПІБ отримувача. Введіть імʼя та прізвище ще раз.',
      BUTTONS.changeRecipientName,
      'RecipientName'
    );
  }

  if (hasAnyText(normalized, ['cityrecipient', 'recipient city', 'recipientcity', 'settlementrecipient', 'місто отримувача', 'місто одержувача', 'населений пункт отримувача', 'населений пункт одержувача'])) {
    return createSingleFieldCorrection(
      'Не вдалося створити ТТН.\nНова пошта не прийняла населений пункт отримувача. Виберіть його ще раз.',
      BUTTONS.changeRecipientCity,
      'AreaRecipient'
    );
  }

  if (hasAnyText(normalized, ['citysender', 'sender city', 'sendercity', 'settlementsender', 'місто відправника', 'населений пункт відправника'])) {
    return createSingleFieldCorrection(
      'Не вдалося створити ТТН.\nНова пошта не прийняла населений пункт відправника. Виберіть його ще раз.',
      BUTTONS.changeSenderCity,
      'AreaSender'
    );
  }

  if (hasAnyText(normalized, ['description', 'cargo description', 'опис'])) {
    return createSingleFieldCorrection(
      'Не вдалося створити ТТН.\nНова пошта не прийняла опис посилки. Напишіть короткий простий опис.',
      BUTTONS.changeDescription,
      'Description'
    );
  }

  if (hasAnyText(normalized, ['api key', 'apikey', 'access denied', 'forbidden', 'authorization', 'ключ'])) {
    return createSingleFieldCorrection(
      'Не вдалося створити ТТН.\nНова пошта не прийняла API-ключ кабінету. Перевірте ключ у кабінеті Нової пошти або додайте актуальний кабінет у боті.',
      BUTTONS.changeCabinet,
      'apiKeyAlias'
    );
  }

  if (hasAnyText(normalized, ['service type', 'servicetype', 'cargo type', 'cargotype', 'payertype', 'paymentmethod', 'datetime', 'date time', 'seatsamount', 'тип доставки', 'тип вантажу', 'платник', 'форма оплати', 'дата'])) {
    return {
      message: [
        'Не вдалося створити ТТН.',
        'Нова пошта не прийняла службові параметри відправлення.',
        'Спробуйте змінити вагу або точку доставки. Якщо помилка повториться, напишіть адміну.',
      ].join('\n'),
      choices: [
        createCorrectionChoice(BUTTONS.changeWeight, 'Weight'),
        createCorrectionChoice(BUTTONS.changeRecipientDeliveryPoint, 'RecipientAddressName'),
      ],
    };
  }

  return {
    message: [
      'Не вдалося створити ТТН.',
      'Нова пошта не прийняла частину даних. Найчастіше це вага, вартість або точка доставки отримувача.',
      'Що перевіримо?',
    ].join('\n'),
    choices: [
      createCorrectionChoice(BUTTONS.changeWeight, 'Weight'),
      createCorrectionChoice(BUTTONS.changeRecipientDeliveryPoint, 'RecipientAddressName'),
      createCorrectionChoice(BUTTONS.changeCost, 'Cost'),
    ],
  };
}

function createSingleFieldCorrection(message, label, fieldKey) {
  return {
    message,
    choices: [
      createCorrectionChoice(label, fieldKey),
    ],
  };
}

function createCorrectionChoice(label, fieldKey) {
  return {
    label,
    value: fieldKey,
    description: label,
  };
}

function getFriendlyNovaPostApiMessage(error) {
  const details = getNovaPostErrorDetails(error);
  const normalized = details.toLowerCase();

  if (hasAnyText(normalized, ['api key', 'apikey', 'access denied', 'forbidden', 'authorization', 'ключ'])) {
    return 'Нова пошта не прийняла API-ключ. Перевірте кабінет Нової пошти або додайте актуальний ключ.';
  }

  if (hasAnyText(normalized, ['not found', 'empty response', 'no data', 'не знайден'])) {
    return 'Нова пошта не знайшла дані за цим запитом. Перевірте введене значення й спробуйте ще раз.';
  }

  if (hasAnyText(normalized, ['required', 'empty', 'missing', 'is not specified', 'обов', 'не заповн'])) {
    return 'У запиті бракує обовʼязкових даних. Перевірте заповнені поля й спробуйте ще раз.';
  }

  if (hasAnyText(normalized, ['phone', 'телефон'])) {
    return 'Нова пошта не прийняла номер телефону. Введіть номер у форматі 380XXXXXXXXX.';
  }

  if (hasAnyText(normalized, ['warehouse', 'address', 'відділен', 'поштомат', 'адрес'])) {
    return 'Нова пошта не прийняла точку доставки. Перевірте місто та номер відділення або поштомату.';
  }

  if (hasAnyText(normalized, ['city', 'settlement', 'місто', 'населен'])) {
    return 'Нова пошта не прийняла населений пункт. Виберіть місто або село ще раз.';
  }

  if (hasAnyText(normalized, ['weight', 'volume', 'dimension', 'вага', 'габарит'])) {
    return 'Нова пошта не прийняла вагу або габарити посилки. Перевірте вагу й спробуйте ще раз.';
  }

  if (hasAnyText(normalized, ['cost', 'варт'])) {
    return 'Нова пошта не прийняла вартість. Введіть іншу суму й спробуйте ще раз.';
  }

  return 'Нова пошта не прийняла запит. Перевірте дані й спробуйте ще раз.';
}

function getNovaPostErrorDetails(error) {
  const details = [];

  if (Array.isArray(error.novaPostErrors) && error.novaPostErrors.length) {
    details.push(...error.novaPostErrors);
  }

  if (Array.isArray(error.novaPostTranslatedErrors) && error.novaPostTranslatedErrors.length) {
    details.push(...error.novaPostTranslatedErrors);
  }

  if (Array.isArray(error.novaPostErrorCodes) && error.novaPostErrorCodes.length) {
    details.push(...error.novaPostErrorCodes);
  }

  if (Array.isArray(error.novaPostWarnings) && error.novaPostWarnings.length) {
    details.push(...error.novaPostWarnings);
  }

  if (!details.length && error.message) {
    details.push(error.message);
  }

  return details.join('; ');
}

function hasAnyText(text, fragments) {
  return fragments.some((fragment) => text.includes(fragment));
}

function getMaxAllowedWeight(text) {
  const match = String(text || '').match(/max allowed weight:\s*([0-9]+(?:[.,][0-9]+)?)/i);

  if (!match) {
    return '';
  }

  return match[1].replace(',', '.');
}

async function handleAdminSetup(msg, args) {
  assertMainAdminTelegram(msg);

  const parts = splitArgs(args);
  if (parts.length < 2) {
    await sendText(msg.chat.id, 'Формат команди: /admin_setup login password');
    return;
  }

  const login = normalizeLogin(parts[0]);
  const password = parts.slice(1).join(' ');
  const store = readStore();

  store.users[login] = createUserRecord(password, 'admin');
  store.sessions[String(msg.from.id)] = {
    login,
    loggedInAt: new Date().toISOString(),
  };

  writeStore(store);
  await sendText(msg.chat.id, `Готово, головного адміна створено: ${login}. Ви вже увійшли.`, menuOptions(msg));
}

async function handleLogin(msg, args) {
  const parts = splitArgs(args);
  if (parts.length < 2) {
    await sendText(msg.chat.id, 'Формат команди: /login login password');
    return;
  }

  const login = normalizeLogin(parts[0]);
  const password = parts.slice(1).join(' ');
  const store = readStore();
  const user = store.users[login];

  if (!user || !verifyPassword(password, user)) {
    await sendText(msg.chat.id, 'Логін або пароль не підійшли. Перевірте дані й спробуйте ще раз.');
    return;
  }

  store.sessions[String(msg.from.id)] = {
    login,
    loggedInAt: new Date().toISOString(),
  };
  writeStore(store);

  await sendText(msg.chat.id, `Вхід виконано. Раді бачити Вас, ${login}!`, menuOptions(msg));
}

async function handleLogout(msg) {
  const store = readStore();
  delete store.sessions[String(msg.from.id)];
  delete store.flows[String(msg.from.id)];
  writeStore(store);
  await sendText(msg.chat.id, 'Ви вийшли з акаунта. До зустрічі!', menuOptions(msg));
}

async function handleAddUser(msg, args) {
  assertMainAdminSession(msg);

  const parts = splitArgs(args);
  if (parts.length < 2) {
    await sendText(msg.chat.id, 'Формат команди: /adduser login password');
    return;
  }

  const login = normalizeLogin(parts[0]);
  const password = parts.slice(1).join(' ');
  const store = readStore();

  if (store.users[login]) {
    await sendText(msg.chat.id, 'Користувач із таким логіном уже існує.');
    return;
  }

  store.users[login] = createUserRecord(password, 'user');
  writeStore(store);

  await sendText(msg.chat.id, `Готово, користувача створено: ${login}`, menuOptions(msg));
}

async function handleDeleteUser(msg, args) {
  assertMainAdminSession(msg);

  const login = normalizeLogin(args);
  if (!login) {
    await sendText(msg.chat.id, 'Формат команди: /deluser login');
    return;
  }

  const currentUser = getSessionUser(msg);
  if (currentUser && currentUser.login === login) {
    await sendText(msg.chat.id, 'Не можна видалити користувача, під яким Ви зараз увійшли.');
    return;
  }

  const store = readStore();
  if (!store.users[login]) {
    await sendText(msg.chat.id, 'Користувача не знайдено.');
    return;
  }

  delete store.users[login];
  delete store.selectedApiKeyByUser[login];

  for (const telegramId of Object.keys(store.sessions)) {
    if (store.sessions[telegramId].login === login) {
      delete store.sessions[telegramId];
    }
  }

  writeStore(store);
  await sendText(msg.chat.id, `Готово, користувача видалено: ${login}`, menuOptions(msg));
}

async function handleUsers(msg) {
  assertMainAdminSession(msg);

  const store = readStore();
  const users = Object.keys(store.users).sort();

  if (!users.length) {
    await sendText(msg.chat.id, 'Користувачів ще немає.');
    return;
  }

  const lines = users.map((login) => {
    const user = store.users[login];
    return `${login} (${user.role})`;
  });

  await sendText(msg.chat.id, lines.join('\n'), menuOptions(msg));
}

async function handleAddKey(msg, args) {
  assertLoggedIn(msg);

  const parts = splitArgs(args);
  if (parts.length < 2) {
    await sendText(msg.chat.id, 'Формат команди: /addkey alias apiKey');
    return;
  }

  const alias = normalizeAlias(parts[0]);
  const apiKey = parts.slice(1).join('').trim();

  if (apiKey === 'MOCK' && !isMainAdmin(msg)) {
    await sendText(msg.chat.id, 'Тестовий MOCK-кабінет доступний тільки адміну.', menuOptions(msg));
    return;
  }

  const keyValidation = await validateNovaPostApiKey(apiKey);

  if (!keyValidation.ok) {
    await sendText(msg.chat.id, keyValidation.message, menuOptions(msg));
    return;
  }

  const store = readStore();
  const currentUser = getSessionUser(msg);

  store.apiKeys[alias] = {
    apiKey,
    createdBy: currentUser.login,
    createdAt: new Date().toISOString(),
  };
  store.selectedApiKeyByUser[currentUser.login] = alias;

  writeStore(store);
  await sendText(msg.chat.id, `Готово, кабінет Нової пошти збережено як "${alias}".`, menuOptions(msg));
}

async function handleDeleteKey(msg, args) {
  assertMainAdminSession(msg);

  const alias = normalizeAlias(args);
  if (!alias) {
    await sendText(msg.chat.id, 'Формат команди: /delkey alias');
    return;
  }

  const store = readStore();
  if (!store.apiKeys[alias]) {
    await sendText(msg.chat.id, 'Такий кабінет не знайдено.');
    return;
  }

  delete store.apiKeys[alias];

  for (const login of Object.keys(store.selectedApiKeyByUser)) {
    if (store.selectedApiKeyByUser[login] === alias) {
      delete store.selectedApiKeyByUser[login];
    }
  }

  writeStore(store);
  await sendText(msg.chat.id, `Готово, кабінет видалено: ${alias}`, menuOptions(msg));
}

async function handleKeys(msg) {
  assertLoggedIn(msg);
  const store = readStore();
  const aliases = getAvailableApiKeyAliases(msg, store);

  if (!aliases.length) {
    await sendText(msg.chat.id, `Кабінетів ще немає. Натисніть "${BUTTONS.addKey}", щоб додати перший.`, menuOptions(msg));
    return;
  }

  const lines = aliases.map((alias) => `${alias} - ${maskSecret(store.apiKeys[alias].apiKey)}`);

  await sendText(msg.chat.id, lines.join('\n'), menuOptions(msg));
}

async function handleUseKey(msg, args) {
  const user = assertLoggedIn(msg);
  const alias = normalizeAlias(args);

  if (!alias) {
    await sendText(msg.chat.id, 'Формат команди: /usekey alias');
    return;
  }

  const store = readStore();
  const aliases = getAvailableApiKeyAliases(msg, store);

  if (!store.apiKeys[alias] || !aliases.includes(alias)) {
    await sendText(msg.chat.id, 'Такий кабінет не знайдено.');
    return;
  }

  store.selectedApiKeyByUser[user.login] = alias;
  writeStore(store);

  await sendText(msg.chat.id, `Обрано кабінет: ${alias}`, menuOptions(msg));
}

async function createTtnFromProperties(msg, methodProperties, selectedKey, flowData) {
  const user = assertLoggedIn(msg);
  const key = selectedKey || getSelectedApiKey(msg);
  const response = await callNovaPost(key.apiKey, 'InternetDocument', 'save', methodProperties);
  const item = firstDataItem(response);
  const number = item.IntDocNumber || item.Number || item.DocumentNumber || 'без номера у відповіді';
  const store = readStore();

  store.shipments[number] = {
    apiKeyAlias: key.alias,
    createdBy: user.login,
    createdAt: new Date().toISOString(),
    ref: item.Ref || '',
    description: methodProperties.Description || '',
    weight: methodProperties.Weight || '',
    cost: methodProperties.Cost || '',
    senderName: flowData && flowData.SenderDescription || '',
    senderContactName: flowData && flowData.ContactSenderDescription || '',
    senderPhone: methodProperties.SendersPhone || '',
    senderCity: flowData && flowData.CitySenderDescription || '',
    senderDeliveryPoint: flowData && flowData.SenderAddressDescription || '',
    recipientName: methodProperties.RecipientName || '',
    recipientContactName: methodProperties.RecipientContactName || '',
    recipientPhone: methodProperties.RecipientsPhone || '',
    recipientCity: flowData && flowData.CityRecipientDescription || '',
    recipientDeliveryPoint: flowData && flowData.RecipientAddressNameDescription || '',
    payment: createShipmentPaymentRecord(flowData, methodProperties),
    status: {
      code: '',
      text: 'Створено, очікує передачі до Нової пошти',
      deliveryPoint: flowData && flowData.RecipientAddressNameDescription || '',
      updatedAt: new Date().toISOString(),
    },
    raw: item,
  };
  writeStore(store);

  await sendText(
    msg.chat.id,
    [
      'ТТН створено ✅',
      `Номер: ${number}`,
      `Кабінет: ${key.alias}`,
      store.shipments[number].payment ? `Оплата: ${formatPaymentLine(store.shipments[number].payment)}` : '',
    ].filter(Boolean).join('\n'),
    menuOptions(msg)
  );
}

function createShipmentPaymentRecord(flowData, methodProperties) {
  const data = flowData || {};

  if (data.PaymentType === 'cod' || data.PaymentType === 'paymentControl') {
    return {
      type: data.PaymentType,
      label: data.PaymentTypeLabel || getPaymentTypeLabel(data.PaymentType),
      amount: data.PaymentAmount || getPaymentAmountFromProperties(methodProperties),
      status: 'waiting',
      createdAt: new Date().toISOString(),
    };
  }

  const amount = getPaymentAmountFromProperties(methodProperties);

  if (methodProperties.AfterpaymentOnGoodsCost) {
    return {
      type: 'paymentControl',
      label: getPaymentTypeLabel('paymentControl'),
      amount,
      status: 'waiting',
      createdAt: new Date().toISOString(),
    };
  }

  if (amount) {
    return {
      type: 'cod',
      label: getPaymentTypeLabel('cod'),
      amount,
      status: 'waiting',
      createdAt: new Date().toISOString(),
    };
  }

  return null;
}

function getPaymentAmountFromProperties(methodProperties) {
  if (methodProperties.AfterpaymentOnGoodsCost) {
    return methodProperties.AfterpaymentOnGoodsCost;
  }

  const deliveryData = Array.isArray(methodProperties.BackwardDeliveryData)
    ? methodProperties.BackwardDeliveryData
    : [];
  const money = deliveryData.find((item) => item.CargoType === 'Money');

  if (!money) {
    return '';
  }

  return money.RedeliveryString || money.Amount || '';
}

async function handleDeleteCreatedTtn(msg, args) {
  const user = assertLoggedIn(msg);
  const number = normalizeTtnNumber(args);

  if (!number) {
    await sendText(msg.chat.id, 'Формат команди: /delttn номер');
    return;
  }

  const store = readStore();
  const shipment = store.shipments[number];

  if (!shipment || !canDeleteShipment(msg, user, shipment)) {
    await sendText(msg.chat.id, 'Не знайшов таку ТТН серед створених у цьому боті.', menuOptions(msg));
    return;
  }

  if (!shipment.ref) {
    await sendText(msg.chat.id, 'У цієї ТТН немає Ref для видалення в Новій пошті.', menuOptions(msg));
    return;
  }

  const key = store.apiKeys[shipment.apiKeyAlias];

  if (!key) {
    await sendText(msg.chat.id, 'Кабінет цієї ТТН уже не знайдено, тому не можу видалити її в Новій пошті.', menuOptions(msg));
    return;
  }

  await callNovaPost(key.apiKey, 'InternetDocument', 'delete', {
    DocumentRefs: [
      shipment.ref,
    ],
  });

  delete store.shipments[number];
  writeStore(store);

  await sendText(msg.chat.id, `ТТН ${number} видалено ✅`, menuOptions(msg));
}

function normalizeTtnNumber(value) {
  return String(value || '').replace(/\D/g, '');
}

function canDeleteShipment(msg, user, shipment) {
  return shipment.createdBy === user.login || isMainAdmin(msg);
}

async function handleCities(msg, args) {
  assertLoggedIn(msg);

  const query = args.trim();
  if (!query) {
    await sendText(msg.chat.id, 'Формат команди: /cities назва');
    return;
  }

  const key = getOptionalSelectedApiKey(msg);
  const response = await callNovaPost(key.apiKey, 'Address', 'getCities', {
    FindByString: query,
    Limit: '10',
  });

  const lines = response.data.map((city) => {
    const area = city.AreaDescription ? `, ${city.AreaDescription}` : '';
    return `${city.Description}${area}\nRef: ${city.Ref}`;
  });

  await sendText(msg.chat.id, lines.length ? lines.join('\n\n') : 'Місто не знайдено.', menuOptions(msg));
}

async function handleWarehouses(msg, args) {
  assertLoggedIn(msg);

  const parts = splitArgs(args);
  if (!parts.length) {
    await sendText(msg.chat.id, 'Формат команди: /warehouses cityRefOrName [пошук]');
    return;
  }

  const key = getOptionalSelectedApiKey(msg);
  const cityInput = parts[0];
  const search = parts.slice(1).join(' ');
  const cityRef = await resolveCityRef(key.apiKey, cityInput);
  const response = await callNovaPost(key.apiKey, 'Address', 'getWarehouses', {
    CityRef: cityRef,
    FindByString: search,
    Limit: '20',
  });

  const lines = response.data.map((warehouse) => {
    const number = warehouse.Number ? `#${warehouse.Number}` : '';
    return `${number} ${warehouse.Description}\nRef: ${warehouse.Ref}`;
  });

  await sendText(msg.chat.id, lines.length ? lines.join('\n\n') : 'Відділення не знайдено.', menuOptions(msg));
}

async function handleCounterparties(msg, args) {
  assertLoggedIn(msg);

  const key = getSelectedApiKey(msg);
  const type = args.trim() || 'Sender';
  const response = await callNovaPost(key.apiKey, 'Counterparty', 'getCounterparties', {
    CounterpartyProperty: type,
    Page: '1',
  });

  const lines = response.data.map((counterparty) => {
    return `${counterparty.Description}\nRef: ${counterparty.Ref}`;
  });

  await sendText(msg.chat.id, lines.length ? lines.join('\n\n') : 'Контрагентів не знайдено.', menuOptions(msg));
}

async function handleContacts(msg, args) {
  assertLoggedIn(msg);

  const ref = args.trim();
  if (!ref) {
    await sendText(msg.chat.id, 'Формат команди: /contacts counterpartyRef');
    return;
  }

  const key = getSelectedApiKey(msg);
  const response = await callNovaPost(key.apiKey, 'Counterparty', 'getCounterpartyContactPersons', {
    Ref: ref,
    Page: '1',
  });

  const lines = response.data.map((contact) => {
    const phone = contact.Phones ? `\nPhone: ${contact.Phones}` : '';
    return `${contact.Description}\nRef: ${contact.Ref}${phone}`;
  });

  await sendText(msg.chat.id, lines.length ? lines.join('\n\n') : 'Контактів не знайдено.', menuOptions(msg));
}

async function handleCost(msg, args) {
  assertLoggedIn(msg);

  const key = getSelectedApiKey(msg);
  const methodProperties = parseJsonArgument(args);

  if (!methodProperties) {
    await sendText(msg.chat.id, 'Формат команди: /cost {json}');
    return;
  }

  const response = await callNovaPost(key.apiKey, 'InternetDocument', 'getDocumentPrice', methodProperties);
  await sendText(msg.chat.id, JSON.stringify(response.data, null, 2), menuOptions(msg));
}

async function handleDeliveryDate(msg, args) {
  assertLoggedIn(msg);

  const key = getSelectedApiKey(msg);
  const methodProperties = parseJsonArgument(args);

  if (!methodProperties) {
    await sendText(msg.chat.id, 'Формат команди: /deliverydate {json}');
    return;
  }

  const response = await callNovaPost(key.apiKey, 'InternetDocument', 'getDocumentDeliveryDate', methodProperties);
  await sendText(msg.chat.id, JSON.stringify(response.data, null, 2), menuOptions(msg));
}

async function handleNovaPostGeneric(msg, args) {
  assertLoggedIn(msg);

  const parsed = parseNovaPostGenericArgs(args);
  if (!parsed) {
    await sendText(msg.chat.id, 'Формат команди: /npget Model calledMethod {json}');
    return;
  }

  const key = getOptionalSelectedApiKey(msg);
  const response = await callNovaPost(
    key.apiKey,
    parsed.modelName,
    parsed.calledMethod,
    parsed.methodProperties
  );

  await sendText(msg.chat.id, JSON.stringify(response.data, null, 2), menuOptions(msg));
}

function menuOptions(msg) {
  return {
    reply_markup: {
      keyboard: menuKeyboard(msg),
      resize_keyboard: true,
    },
  };
}

function cancelOptions() {
  return {
    reply_markup: {
      keyboard: [
        [BUTTONS.back, BUTTONS.cancel],
      ],
      resize_keyboard: true,
    },
  };
}

function flowOptions(field) {
  if (field.options && field.options.length) {
    const labels = field.options.map((item) => getFieldOptionLabel(item));
    const rows = makeButtonRows(labels, 2, false);

    if (field.defaultValue !== undefined) {
      rows.push([BUTTONS.skip, BUTTONS.back, BUTTONS.cancel]);
    } else {
      rows.push([BUTTONS.back, BUTTONS.cancel]);
    }

    return keyboardOptions(rows);
  }

  const row = field.defaultValue !== undefined
    ? [BUTTONS.skip, BUTTONS.back, BUTTONS.cancel]
    : [BUTTONS.back, BUTTONS.cancel];

  return keyboardOptions([row]);
}

function createTtnFieldOptions(field) {
  if (field.options && field.options.length) {
    return flowOptions(field);
  }

  return textInputOptions();
}

function textInputOptions() {
  return {
    reply_markup: {
      remove_keyboard: true,
    },
  };
}

function keyboardOptions(keyboard) {
  return {
    reply_markup: {
      keyboard,
      resize_keyboard: true,
    },
  };
}

function makeButtonRows(values, columns, withCancel) {
  const rows = [];
  let currentRow = [];

  for (const value of values) {
    currentRow.push(value);

    if (currentRow.length === columns) {
      rows.push(currentRow);
      currentRow = [];
    }
  }

  if (currentRow.length) {
    rows.push(currentRow);
  }

  if (withCancel) {
    rows.push([BUTTONS.cancel]);
  }

  return rows;
}

function menuKeyboard(msg) {
  const user = getSessionUser(msg);

  if (!user) {
    return [
      [BUTTONS.login],
    ];
  }

  const keyboard = [
    [BUTTONS.createTtn],
    [BUTTONS.myShipments, BUTTONS.payments],
    [BUTTONS.returns],
    [BUTTONS.accounts, BUTTONS.settings],
    [BUTTONS.logout],
  ];

  if (isMainAdmin(msg)) {
    keyboard.push([BUTTONS.addUser, BUTTONS.users]);
  }

  return keyboard;
}

async function sendText(chatId, text, options) {
  const chunks = chunkText(String(text), 3900);

  for (let index = 0; index < chunks.length; index += 1) {
    const messageOptions = index === chunks.length - 1 ? options : undefined;
    await bot.sendMessage(chatId, chunks[index], messageOptions);
  }
}
