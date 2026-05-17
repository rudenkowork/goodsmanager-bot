require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const {
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
} = require('./src/auth');
const {
  NOVA_POST_ENDPOINT,
  buildTtnProperties,
  callNovaPost,
  firstDataItem,
  resolveCityRef,
  todayForNovaPost,
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

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is missing. Add it to .env before starting the bot.');
  process.exit(1);
}

ensureStoreFile({
  mainAdminTelegramUsername: MAIN_ADMIN_TELEGRAM_USERNAME,
  novaPostEndpoint: NOVA_POST_ENDPOINT,
});

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const startedAt = new Date();

bot.setMyCommands([
  { command: 'start', description: 'Відкрити головне меню' },
  { command: 'menu', description: 'Показати панель дій' },
  { command: 'help', description: 'Підказки по боту' },
  { command: 'status', description: 'Статус бота' },
  { command: 'track', description: 'Відстежити ТТН' },
  { command: 'create_ttn', description: 'Створити ТТН через JSON' },
  { command: 'clear_chat', description: 'Очистити повідомлення бота' },
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
    await sendText(msg.chat.id, `Не вийшло виконати дію: ${error.message}`);
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

console.log('Goods Manager bot started.');

async function shutdown(signal) {
  console.log(`Received ${signal}. Stopping Telegram polling.`);

  try {
    await bot.stopPolling();
  } catch (error) {
    console.error('Failed to stop polling:', error.message);
  }

  process.exit(0);
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === BUTTONS.cancel) {
    clearFlow(msg);
    await sendText(chatId, 'Скасовано. Повертаю Вас у головне меню.', menuOptions(msg));
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

  if (command === '/help') {
    await sendHelp(msg);
    return;
  }

  if (command === '/menu') {
    await sendText(msg.chat.id, 'Ось що можна зробити зараз:', menuOptions(msg));
    return;
  }

  if (command === '/clear_chat') {
    await handleClearChat(msg);
    return;
  }

  if (command === '/status') {
    await sendBotStatus(msg);
    return;
  }

  if (command === '/admin_setup') {
    await handleAdminSetup(msg, args);
    return;
  }

  if (command === '/mock_setup') {
    await handleMockSetup(msg);
    return;
  }

  if (command === '/mockup') {
    await handleMockup(msg);
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

  if (command === '/track' || command === '/statuses') {
    await handleTrack(msg, args);
    return;
  }

  if (command === '/create_ttn') {
    await handleCreateTtn(msg, args);
    return;
  }

  if (command === '/ttn_template') {
    await handleTtnTemplate(msg);
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

  await sendText(chatId, 'Не впізнав цю команду. Напишіть /help, і я підкажу доступні дії.');
}

async function sendStart(msg) {
  const store = readStore();
  const name = msg.from && msg.from.first_name ? msg.from.first_name : 'друже';
  const mainAdmin = store.config.mainAdminTelegramUsername;
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
      '',
      `Головний адмін: @${mainAdmin}`,
    ].join('\n'),
    menuOptions(msg)
  );
}

async function sendHelp(msg) {
  const user = getSessionUser(msg);
  const lines = [
    'Працюйте через кнопки на панелі нижче: так швидше й без зайвих команд.',
    '',
    'Основні дії:',
    `${BUTTONS.createTtn} - проведу крок за кроком і створю накладну.`,
    `${BUTTONS.track} - перевірю статус посилки за номером ТТН.`,
    `${BUTTONS.addKey} - збережемо API-ключ із кабінету Нової пошти.`,
    `${BUTTONS.keys} - покажу збережені кабінети.`,
    `${BUTTONS.clearChat} - приберу останні повідомлення бота з чату.`,
    '',
    'Швидкі команди теж працюють:',
    '/track TTN [phone]',
    '/create_ttn {json}',
    '/npget Model calledMethod {json}',
  ];

  if (user && isMainAdmin(msg)) {
    lines.push('');
    lines.push('Команди головного адміна:');
    lines.push('/adduser login password - створити користувача');
    lines.push('/deluser login - видалити користувача');
    lines.push('/users - список користувачів');
    lines.push('/delkey alias - видалити кабінет');
    lines.push('/mock_setup - створити тестового адміна, користувача і mock-кабінет');
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

async function handleMenuButton(msg, text) {
  if (text === BUTTONS.login) {
    await startLoginFlow(msg);
    return;
  }

  if (text === BUTTONS.createTtn) {
    await startCreateTtnFlow(msg);
    return;
  }

  if (text === BUTTONS.track) {
    await startTrackFlow(msg);
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

  if (text === BUTTONS.mockup) {
    await handleMockup(msg);
    return;
  }

  if (text === BUTTONS.clearChat) {
    await handleClearChat(msg);
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

async function handleClearChat(msg) {
  const chatId = msg.chat.id;
  const store = readStore();
  const chatKey = String(chatId);
  const messageIds = store.botMessagesByChat[chatKey] || [];
  let deletedCount = 0;

  for (const messageId of messageIds) {
    try {
      await bot.deleteMessage(chatId, messageId);
      deletedCount += 1;
    } catch (error) {
      if (!String(error.message).includes('message to delete not found')) {
        console.error('Failed to delete message:', error.message);
      }
    }
  }

  store.botMessagesByChat[chatKey] = [];
  writeStore(store);

  await sendText(
    chatId,
    [
      `Готово, прибрав повідомлення бота: ${deletedCount}.`,
      'Ваші власні повідомлення Telegram не дозволяє видаляти боту, їх можна очистити вручну.',
    ].join('\n'),
    menuOptions(msg)
  );
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

async function startTrackFlow(msg) {
  assertLoggedIn(msg);

  setFlow(msg, {
    type: 'track',
    step: 0,
    data: {},
  });

  await sendText(msg.chat.id, 'Введіть номер ТТН для перевірки.', cancelOptions());
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
  const aliases = Object.keys(store.apiKeys).sort();

  if (!aliases.length) {
    await sendText(
      msg.chat.id,
      'Щоб створити ТТН, спочатку додайте API-ключ Нової пошти.',
      menuOptions(msg)
    );
    return;
  }

  setFlow(msg, {
    type: 'createTtn',
    step: -1,
    data: {},
  });

  await sendText(
    msg.chat.id,
    [
      'Починаємо створення ТТН 📦',
      'Спочатку оберіть кабінет Нової пошти, з якого будемо створювати накладну.',
      'Далі коротко заповнимо дані посилки, потім окремо дані відправника й отримувача.',
      '',
      'Натисніть потрібний кабінет зі списку нижче.',
    ].join('\n'),
    keyboardOptions(makeButtonRows(aliases, 2, true))
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

  if (flow.type === 'track') {
    await handleTrackFlowInput(msg, flow, text);
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

  clearFlow(msg);
  await sendText(msg.chat.id, 'Не вдалося продовжити цю дію. Почніть ще раз із меню.', menuOptions(msg));
}

async function handleFlowBack(msg, flow) {
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
  delete store.flows[String(msg.from.id)];
  writeStore(store);

  await sendText(
    msg.chat.id,
    `Готово, кабінет "${alias}" збережено. При створенні ТТН я запропоную обрати його зі списку.`,
    menuOptions(msg)
  );
}

async function handleTrackFlowInput(msg, flow, text) {
  if (flow.step === 0) {
    flow.data.documentNumber = text.trim();
    flow.step = 1;
    setFlow(msg, flow);
    await sendText(
      msg.chat.id,
      'Якщо маєте телефон отримувача, введіть його. Якщо ні - натисніть "Пропустити".',
      flowOptions({ defaultValue: '' })
    );
    return;
  }

  const phone = text === BUTTONS.skip ? '' : text.trim();
  clearFlow(msg);
  await trackShipment(msg, flow.data.documentNumber, phone);
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

  if (flow.mode === 'senderChoice') {
    await handleCreateTtnSenderChoice(msg, flow, text);
    return;
  }

  if (flow.mode === 'senderContactChoice') {
    await handleCreateTtnSenderContactChoice(msg, flow, text);
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
    await offerSenderChoices(msg, flow, field, 1);
    return;
  }

  if (field.senderContact) {
    await offerSenderContactChoices(msg, flow, field, 1);
    return;
  }

  flow.data[field.key] = value;
  flow.step += 1;

  if (flow.step < CREATE_TTN_FIELDS.length) {
    await askNextCreateTtnField(msg, flow);
    return;
  }

  clearFlow(msg);
  await finishCreateTtnFlow(msg, flow.data);
}

async function handleCreateTtnKeySelection(msg, flow, text) {
  const alias = normalizeAlias(text);
  const store = readStore();

  if (!store.apiKeys[alias]) {
    await sendText(msg.chat.id, 'Не бачу такого кабінету. Натисніть один із варіантів нижче.', keyboardOptions(makeButtonRows(Object.keys(store.apiKeys).sort(), 2, true)));
    return;
  }

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

  flow.data[flow.pendingField] = field.warehouseRef ? warehouse.Ref : (warehouse.Number || warehouse.Description);
  flow.data[`${flow.pendingField}Description`] = warehouse.Description;
  flow.data[`${flow.pendingField}Ref`] = warehouse.Ref;
  flow.step += 1;
  delete flow.mode;
  delete flow.pendingField;
  delete flow.pendingWarehouseMode;
  clearPagedChoiceState(flow);

  await sendText(msg.chat.id, formatWarehouseConfirmation(flow, field, warehouse), textInputOptions());
  await askNextCreateTtnField(msg, flow);
}

async function offerSenderChoices(msg, flow, field, page) {
  const key = getApiKeyForCreateFlow(flow);
  const response = await callNovaPost(key.apiKey, 'Counterparty', 'getCounterparties', {
    CounterpartyProperty: 'Sender',
    Page: '1',
  });
  const senders = response.data.map((counterparty) => {
    return {
      label: trimButtonLabel(formatCounterpartyButtonLabel(counterparty)),
      value: counterparty.Ref,
      description: counterparty.Description,
      search: counterparty.Description,
    };
  });

  if (!senders.length) {
    await sendText(msg.chat.id, 'У цьому кабінеті не знайдено ФОП або компанію відправника.', listChoiceOptions([]));
    return;
  }

  flow.mode = 'senderChoice';
  flow.pendingField = field.key;
  setPagedChoiceState(flow, field.prompt, senders, 1, page);
  setFlow(msg, flow);

  await sendPagedChoiceList(msg, flow);
}

async function handleCreateTtnSenderChoice(msg, flow, text) {
  if (handleLocalChoicePageChange(flow, text)) {
    setFlow(msg, flow);
    await sendPagedChoiceList(msg, flow);
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

async function offerSenderContactChoices(msg, flow, field, page) {
  const key = getApiKeyForCreateFlow(flow);
  const senderRef = flow.data[field.senderKey];

  if (!senderRef) {
    await sendText(msg.chat.id, 'Спочатку оберіть ФОП або компанію відправника.', listChoiceOptions([]));
    return;
  }

  const response = await callNovaPost(key.apiKey, 'Counterparty', 'getCounterpartyContactPersons', {
    Ref: senderRef,
    Page: '1',
  });
  const contacts = response.data.map((contact) => {
    return {
      label: trimButtonLabel(formatContactButtonLabel(contact)),
      value: contact.Ref,
      description: contact.Description,
      phone: firstPhone(contact.Phones),
      search: `${contact.Description} ${contact.Phones || ''}`,
    };
  });

  if (!contacts.length) {
    await sendText(msg.chat.id, 'Для цього відправника не знайдено контактних осіб.', listChoiceOptions([]));
    return;
  }

  flow.mode = 'senderContactChoice';
  flow.pendingField = field.key;
  setPagedChoiceState(flow, field.prompt, contacts, 1, page);
  setFlow(msg, flow);

  await sendPagedChoiceList(msg, flow);
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
    while (flow.step < CREATE_TTN_FIELDS.length && flow.data[CREATE_TTN_FIELDS[flow.step].key]) {
      flow.step += 1;
    }
  }

  if (flow.step < CREATE_TTN_FIELDS.length) {
    const nextField = CREATE_TTN_FIELDS[flow.step];
    await sendCreateTtnSectionNotice(msg, flow, nextField);
    setFlow(msg, flow);

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
      await offerSenderChoices(msg, flow, nextField, 1);
      return;
    }

    if (nextField.senderContact) {
      await offerSenderContactChoices(msg, flow, nextField, 1);
      return;
    }

    await sendText(msg.chat.id, nextField.prompt, createTtnFieldOptions(nextField));
    return;
  }

  clearFlow(msg);
  await finishCreateTtnFlow(msg, flow.data);
}

async function sendCreateTtnSectionNotice(msg, flow, field) {
  if (field.key === 'Sender' && !flow.senderSectionShown) {
    flow.senderSectionShown = true;
    await sendText(
      msg.chat.id,
      'Тепер заповнюємо дані відправника. Відправлення оформлюємо з відділення Нової пошти.'
    );
    return;
  }

  if (field.key === 'AreaRecipient' && !flow.recipientSectionShown) {
    flow.recipientSectionShown = true;
    await sendText(
      msg.chat.id,
      'Дані відправника готові. Переходимо до отримувача: область, населений пункт і точка доставки.'
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
  delete flow.data[`${field.key}Ref`];
  delete flow.data[`${field.key}SettlementType`];
  delete flow.data[`${field.key}SettlementTypeLabel`];
  delete flow.data[`${field.key}DeliveryType`];
  delete flow.data[`${field.key}DeliveryTypeLabel`];
}

async function finishCreateTtnFlow(msg, data) {
  const key = getApiKeyForCreateFlow({ data });
  const methodProperties = await buildTtnProperties(key.apiKey, data);

  await sendText(
    msg.chat.id,
    [
      'Дані зібрано ✅',
      'Створюю ТТН з таким JSON:',
      JSON.stringify(methodProperties, null, 2),
    ].join('\n')
  );

  await createTtnFromProperties(msg, methodProperties, key);
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

async function handleMockSetup(msg) {
  assertMainAdminTelegram(msg);

  const store = readStore();
  const adminLogin = 'admin';
  const userLogin = 'demo';

  store.users[adminLogin] = createUserRecord('admin123', 'admin');
  store.users[userLogin] = createUserRecord('demo123', 'user');
  store.apiKeys.mock = {
    apiKey: 'MOCK',
    createdBy: adminLogin,
    createdAt: new Date().toISOString(),
  };
  store.sessions[String(msg.from.id)] = {
    login: adminLogin,
    loggedInAt: new Date().toISOString(),
  };

  writeStore(store);

  await sendText(
    msg.chat.id,
    [
      'Mock-режим готовий ✅',
      'Ви увійшли як admin.',
      '',
      'Тестові акаунти:',
      'admin / admin123',
      'demo / demo123',
      '',
      'Тестовий кабінет: mock',
      'Далі напишіть /mockup: там є готовий сценарій для тесту.',
    ].join('\n'),
    menuOptions(msg)
  );
}

async function handleMockup(msg) {
  await sendText(
    msg.chat.id,
    [
      'Тестовий сценарій:',
      '',
      '1. Якщо Ви @timarudy, підготуйте mock:',
      '/mock_setup',
      '',
      '2. Якщо потрібно увійти вручну:',
      '/login admin admin123',
      'У сценарії створення ТТН оберіть кабінет mock кнопкою.',
      '',
      '3. Перевірте кабінети:',
      '/keys',
      '',
      '4. Перевірка довідників Нової пошти:',
      '/cities Київ',
      '/warehouses Київ 1',
      '',
      '5. Створити тестову ТТН:',
      '/create_ttn {"Description":"Тестова посилка","Weight":"1","Cost":"500","RecipientName":"Іван Петренко","RecipientsPhone":"380501112233"}',
      '',
      '6. Трекінг mock-ТТН:',
      '/track 20450000000001',
      '/track 20450000000002',
      '/track 20450000000003',
      '/track 20450000000004',
      '/track 20450000000005',
      '',
      'Підказка: остання цифра mock-ТТН змінює статус. 1 - ще не відправлена, 2 - в дорозі, 3 - у відділенні, 4 - отримана, 5 - повернута.',
    ].join('\n'),
    menuOptions(msg)
  );
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
  const aliases = Object.keys(store.apiKeys).sort();

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
  if (!store.apiKeys[alias]) {
    await sendText(msg.chat.id, 'Такий кабінет не знайдено.');
    return;
  }

  store.selectedApiKeyByUser[user.login] = alias;
  writeStore(store);

  await sendText(msg.chat.id, `Обрано кабінет: ${alias}`, menuOptions(msg));
}

async function handleTrack(msg, args) {
  assertLoggedIn(msg);

  const parts = splitArgs(args);
  if (!parts.length) {
    await sendText(msg.chat.id, 'Формат команди: /track TTN [phone]');
    return;
  }

  await trackShipment(msg, parts[0], parts[1] || '');
}

async function handleCreateTtn(msg, args) {
  assertLoggedIn(msg);
  const methodProperties = parseJsonArgument(args);

  if (!methodProperties) {
    await sendText(msg.chat.id, 'Формат команди: /create_ttn {json}\nПриклад: /ttn_template');
    return;
  }

  await createTtnFromProperties(msg, methodProperties);
}

async function trackShipment(msg, documentNumber, phone) {
  const key = getSelectedApiKey(msg);
  const document = {
    DocumentNumber: documentNumber,
  };

  if (phone) {
    document.Phone = phone;
  }

  const response = await callNovaPost(key.apiKey, 'TrackingDocument', 'getStatusDocuments', {
    Documents: [document],
  });

  const item = firstDataItem(response);
  await sendText(msg.chat.id, formatTrackingStatus(item, key.alias), menuOptions(msg));
}

async function createTtnFromProperties(msg, methodProperties, selectedKey) {
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
    raw: item,
  };
  writeStore(store);

  await sendText(
    msg.chat.id,
    [
      'ТТН створено ✅',
      `Номер: ${number}`,
      item.Ref ? `Ref: ${item.Ref}` : '',
      `Кабінет: ${key.alias}`,
    ].filter(Boolean).join('\n'),
    menuOptions(msg)
  );
}

async function handleTtnTemplate(msg) {
  assertLoggedIn(msg);

  const template = {
    NewAddress: '1',
    PayerType: 'Sender',
    PaymentMethod: 'Cash',
    CargoType: 'Parcel',
    VolumeGeneral: '0.001',
    Weight: '1',
    ServiceType: 'WarehouseWarehouse',
    SeatsAmount: '1',
    Description: 'Товар',
    Cost: '500',
    CitySender: 'sender city Ref',
    Sender: 'sender counterparty Ref',
    SenderAddress: 'sender warehouse Ref',
    ContactSender: 'sender contact Ref',
    SendersPhone: '380XXXXXXXXX',
    CityRecipient: 'recipient city Ref',
    RecipientName: 'Прізвище Імʼя По батькові',
    RecipientType: 'PrivatePerson',
    RecipientAddressName: 'recipient warehouse number or name',
    RecipientsPhone: '380XXXXXXXXX',
    DateTime: todayForNovaPost(),
  };

  await sendText(
    msg.chat.id,
    [
      'Надішліть команду так:',
      '/create_ttn {json}',
      '',
      'Шаблон methodProperties:',
      JSON.stringify(template, null, 2),
      '',
      'Ref-значення можна перевірити через /cities, /warehouses, /counterparties, /contacts.',
    ].join('\n'),
    menuOptions(msg)
  );
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

function formatTrackingStatus(item, keyAlias) {
  const status = item.Status || item.DocumentStatus || 'Статус не вказано';
  const statusCode = item.StatusCode || item.DocumentStatusCode || '';
  const category = classifyStatus(status);
  const lines = [
    `Статус посилки: ${category}`,
    `Опис API: ${status}`,
  ];

  if (statusCode) {
    lines.push(`Код: ${statusCode}`);
  }

  if (item.Number) {
    lines.push(`ТТН: ${item.Number}`);
  }

  if (item.WarehouseRecipient) {
    lines.push(`Відділення отримувача: ${item.WarehouseRecipient}`);
  }

  if (item.ScheduledDeliveryDate) {
    lines.push(`Планова дата доставки: ${item.ScheduledDeliveryDate}`);
  }

  lines.push(`Кабінет: ${keyAlias}`);

  return lines.join('\n');
}

function classifyStatus(status) {
  const value = String(status || '').toLowerCase();

  if (value.includes('отримано')) {
    return 'отримана';
  }

  if (value.includes('повер') || value.includes('відмова')) {
    return 'повернута або повертається';
  }

  if (value.includes('не знайден')) {
    return 'не знайдена';
  }

  if (value.includes('створено') || value.includes('очіку') || value.includes('не передано')) {
    return 'ще не відправлена';
  }

  if (value.includes('дороз') || value.includes('прямує') || value.includes('відправ')) {
    return 'в дорозі';
  }

  if (value.includes('прибул') || value.includes('відділен')) {
    return 'прибула у відділення';
  }

  return 'інший статус';
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
      [BUTTONS.mockup],
    ];
  }

  const keyboard = [
    [BUTTONS.createTtn, BUTTONS.track],
    [BUTTONS.keys, BUTTONS.addKey],
    [BUTTONS.clearChat, BUTTONS.logout],
  ];

  if (isMainAdmin(msg)) {
    keyboard.push([BUTTONS.addUser, BUTTONS.users]);
    keyboard.push([BUTTONS.mockup]);
  }

  return keyboard;
}

async function sendText(chatId, text, options) {
  const chunks = chunkText(String(text), 3900);

  for (let index = 0; index < chunks.length; index += 1) {
    const messageOptions = index === chunks.length - 1 ? options : undefined;
    const sentMessage = await bot.sendMessage(chatId, chunks[index], messageOptions);
    rememberBotMessage(chatId, sentMessage.message_id);
  }
}

function rememberBotMessage(chatId, messageId) {
  const store = readStore();
  const chatKey = String(chatId);

  if (!store.botMessagesByChat[chatKey]) {
    store.botMessagesByChat[chatKey] = [];
  }

  store.botMessagesByChat[chatKey].push(messageId);

  if (store.botMessagesByChat[chatKey].length > 80) {
    store.botMessagesByChat[chatKey] = store.botMessagesByChat[chatKey].slice(-80);
  }

  writeStore(store);
}
