const CITY_CHOICES_LIMIT = 1000;
const CHOICE_PAGE_SIZE = 8;
const WAREHOUSE_SEARCH_LIMIT = 50;
const POSTOMAT_TYPE_REFS = [
  '95dc212d-479c-4ffb-a8ab-8c1b9073d0bc',
  'f9316480-5f2d-425d-bc2c-ac7cd29decf0',
];

const MAIN_CITY_BY_AREA = {
  'автономна республіка крим': 'Сімферополь',
  'вінницька': 'Вінниця',
  'волинська': 'Луцьк',
  'дніпропетровська': 'Дніпро',
  'донецька': 'Донецьк',
  'житомирська': 'Житомир',
  'закарпатська': 'Ужгород',
  'запорізька': 'Запоріжжя',
  'івано-франківська': 'Івано-Франківськ',
  'київська': 'Київ',
  'кіровоградська': 'Кропивницький',
  'луганська': 'Луганськ',
  'львівська': 'Львів',
  'миколаївська': 'Миколаїв',
  'одеська': 'Одеса',
  'полтавська': 'Полтава',
  'рівненська': 'Рівне',
  'сумська': 'Суми',
  'тернопільська': 'Тернопіль',
  'харківська': 'Харків',
  'херсонська': 'Херсон',
  'хмельницька': 'Хмельницький',
  'черкаська': 'Черкаси',
  'чернівецька': 'Чернівці',
  'чернігівська': 'Чернігів',
};

const BUTTONS = {
  login: 'Увійти',
  createTtn: 'Створити ТТН',
  myShipments: 'Мої відправки',
  payments: 'Оплати',
  returns: 'Повернення',
  accounts: 'ФОПи / акаунти',
  settings: 'Налаштування',
  keys: 'Кабінети НП',
  addKey: 'Додати кабінет',
  addDefaultWarehouse: 'Додати стандартне відділення',
  cities: 'Знайти місто',
  warehouses: 'Знайти відділення',
  addUser: 'Додати користувача',
  users: 'Користувачі',
  logout: 'Вийти',
  cancel: 'Скасувати',
  back: 'Назад',
  today: 'Сьогодні',
  chooseDate: 'Обрати дату',
  byCabinet: 'По ФОПу',
  allCabinets: 'Усі ФОПи',
  allDates: 'Усі дати',
  showSelected: 'Показати',
  trackTtn: 'Відстежити ТТН',
  allPayments: 'Усі оплати',
  waitingPayments: 'Очікуються',
  receivedPayments: 'Отримані',
  allReturns: 'Усі повернення',
  nextPage: 'Наступна сторінка',
  previousPage: 'Попередня сторінка',
  skip: 'Пропустити',
  customSender: 'Інший відправник',
  customSenderWarehouse: 'Інше відділення',
  createSender: 'Створити нового відправника',
  refreshList: 'Оновити список',
  changeWeight: 'Змінити вагу',
  changeRecipientDeliveryPoint: 'Змінити точку отримувача',
  changeSenderDeliveryPoint: 'Змінити точку відправника',
  changeCost: 'Змінити вартість',
  changeRecipientPhone: 'Змінити телефон отримувача',
  changeSenderPhone: 'Змінити телефон відправника',
  changeDescription: 'Змінити опис',
  changeRecipientName: 'Змінити ПІБ отримувача',
  changeRecipientCity: 'Змінити місто отримувача',
  changeSenderCity: 'Змінити місто відправника',
  changeCabinet: 'Змінити кабінет НП',
  withoutPaymentControl: 'Створити без контролю оплати',
  useCashOnDelivery: 'Використати накладений платіж',
  changePaymentAmount: 'Змінити суму оплати',
};

const SETTLEMENT_TYPE_CHOICES = [
  {
    label: 'Місто',
    value: 'місто',
  },
  {
    label: 'СМТ',
    value: 'селище міського типу',
  },
  {
    label: 'Селище',
    value: 'селище',
  },
  {
    label: 'Село',
    value: 'село',
  },
];

const DELIVERY_TYPE_CHOICES = [
  {
    label: 'Відділення',
    value: 'branch',
  },
  {
    label: 'Поштомат',
    value: 'postomat',
  },
];

const PAYMENT_TYPE_CHOICES = [
  {
    label: 'Без оплати',
    value: 'none',
  },
  {
    label: 'Накладений платіж',
    value: 'cod',
  },
  {
    label: 'Контроль оплати',
    value: 'paymentControl',
  },
];

const CREATE_TTN_FIELDS = [
  {
    key: 'Description',
    prompt: 'Що відправляємо? Напишіть короткий опис посилки для накладної.',
  },
  {
    key: 'Weight',
    prompt: 'Вкажіть вагу посилки у кг.',
    format: 'weight',
  },
  {
    key: 'Cost',
    prompt: 'Вкажіть оголошену вартість у грн.',
    format: 'money',
  },
  {
    key: 'Sender',
    prompt: 'Оберіть ФОП або компанію, з якої відправляємо.',
    senderCounterparty: true,
  },
  {
    key: 'ContactSender',
    prompt: 'Оберіть ПІБ і телефон відправника з кабінету.',
    senderContact: true,
    senderKey: 'Sender',
  },
  {
    key: 'PaymentType',
    prompt: 'Чи додаємо оплату при отриманні?',
    options: PAYMENT_TYPE_CHOICES,
  },
  {
    key: 'PaymentAmount',
    prompt: 'Вкажіть суму оплати у грн.',
    format: 'money',
    paymentAmount: true,
  },
  {
    key: 'AreaSender',
    prompt: 'Оберіть область відправника.',
    areaRef: true,
  },
  {
    key: 'CitySender',
    prompt: 'Оберіть населений пункт відправника.',
    cityRef: true,
    areaKey: 'AreaSender',
  },
  {
    key: 'SenderAddress',
    prompt: 'Введіть номер відділення відправника.',
    warehouseRef: true,
    cityKey: 'CitySender',
    fixedDeliveryType: 'branch',
    fixedDeliveryTypeLabel: 'Відділення',
  },
  {
    key: 'SendersPhone',
    prompt: 'Введіть телефон відправника у форматі 380XXXXXXXXX.',
    format: 'phone',
  },
  {
    key: 'AreaRecipient',
    prompt: 'Оберіть область отримувача.',
    areaRef: true,
  },
  {
    key: 'CityRecipient',
    prompt: 'Оберіть населений пункт отримувача.',
    cityRef: true,
    areaKey: 'AreaRecipient',
  },
  {
    key: 'RecipientAddressName',
    prompt: 'Введіть номер відділення або поштомату отримувача.',
    warehouseName: true,
    cityKey: 'CityRecipient',
  },
  {
    key: 'RecipientName',
    prompt: 'Введіть ПІБ отримувача.',
    format: 'fullName',
  },
  {
    key: 'RecipientsPhone',
    prompt: 'Введіть телефон отримувача у форматі 380XXXXXXXXX.',
    format: 'phone',
  },
];

module.exports = {
  BUTTONS,
  CHOICE_PAGE_SIZE,
  CITY_CHOICES_LIMIT,
  CREATE_TTN_FIELDS,
  DELIVERY_TYPE_CHOICES,
  MAIN_CITY_BY_AREA,
  PAYMENT_TYPE_CHOICES,
  POSTOMAT_TYPE_REFS,
  SETTLEMENT_TYPE_CHOICES,
  WAREHOUSE_SEARCH_LIMIT,
};
