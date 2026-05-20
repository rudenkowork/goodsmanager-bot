const NOVA_POST_ENDPOINT = 'https://api.novaposhta.ua/v2.0/json/';

async function buildTtnProperties(apiKey, data) {
  const citySender = await normalizeCityValue(apiKey, data.CitySender);
  const cityRecipient = await normalizeCityValue(apiKey, data.CityRecipient);
  const recipientAddressName = data.RecipientAddressNameRef || data.RecipientAddressName;

  return {
    NewAddress: '1',
    PayerType: data.PayerType || 'Sender',
    PaymentMethod: data.PaymentMethod || 'Cash',
    CargoType: 'Parcel',
    VolumeGeneral: '0.001',
    Weight: data.Weight,
    ServiceType: 'WarehouseWarehouse',
    SeatsAmount: data.SeatsAmount || '1',
    Description: data.Description,
    Cost: data.Cost,
    CitySender: citySender,
    Sender: data.Sender,
    SenderAddress: data.SenderAddress,
    ContactSender: data.ContactSender,
    SendersPhone: data.SendersPhone,
    CityRecipient: cityRecipient,
    RecipientName: data.RecipientName,
    RecipientType: 'PrivatePerson',
    RecipientAddressName: recipientAddressName,
    RecipientContactName: data.RecipientContactName || data.RecipientName,
    RecipientsPhone: data.RecipientsPhone,
    DateTime: todayForNovaPost(),
  };
}

async function callNovaPost(apiKey, modelName, calledMethod, methodProperties) {
  if (apiKey === 'MOCK' && !isNovaPostAddressDirectoryMethod(modelName, calledMethod)) {
    return mockNovaPost(modelName, calledMethod, methodProperties);
  }

  const requestApiKey = apiKey === 'MOCK' ? '' : apiKey;

  const response = await fetch(NOVA_POST_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      apiKey: requestApiKey,
      modelName,
      calledMethod,
      methodProperties,
    }),
  });

  if (!response.ok) {
    throw new Error(`Nova Post HTTP ${response.status}`);
  }

  const result = await response.json();
  if (!result.success) {
    const errors = Array.isArray(result.errors) ? result.errors.join('; ') : 'невідома помилка';
    const warnings = Array.isArray(result.warnings) && result.warnings.length
      ? ` Попередження: ${result.warnings.join('; ')}`
      : '';
    throw new Error(`Nova Post API: ${errors}.${warnings}`);
  }

  return result;
}

async function validateNovaPostApiKey(apiKey) {
  const key = String(apiKey || '').trim();

  if (key === 'MOCK') {
    return {
      ok: true,
    };
  }

  if (key.length < 20) {
    return {
      ok: false,
      message: 'API-ключ виглядає занадто коротким. Скопіюйте повний ключ із кабінету Нової пошти.',
    };
  }

  try {
    await callNovaPost(key, 'Counterparty', 'getCounterparties', {
      CounterpartyProperty: 'Sender',
      Page: '1',
    });
  } catch (error) {
    return {
      ok: false,
      message: 'API-ключ не пройшов перевірку. Скопіюйте актуальний ключ із кабінету Нової пошти й спробуйте ще раз.',
    };
  }

  return {
    ok: true,
  };
}

function firstDataItem(response) {
  if (!Array.isArray(response.data) || !response.data.length) {
    throw new Error('Nova Post API повернув порожню відповідь.');
  }

  return response.data[0];
}

async function resolveCityRef(apiKey, cityInput) {
  if (looksLikeRef(cityInput)) {
    return cityInput;
  }

  const response = await callNovaPost(apiKey, 'Address', 'getCities', {
    FindByString: cityInput,
    Limit: '1',
  });

  const city = firstDataItem(response);
  if (!city.Ref) {
    throw new Error('Не вдалося знайти Ref міста.');
  }

  return city.Ref;
}

function todayForNovaPost() {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  return `${day}.${month}.${year}`;
}

function looksLikeRef(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function normalizeCityValue(apiKey, value) {
  if (looksLikeRef(value)) {
    return value;
  }

  return resolveCityRef(apiKey, value);
}

function isNovaPostAddressDirectoryMethod(modelName, calledMethod) {
  if (modelName !== 'Address') {
    return false;
  }

  return calledMethod === 'getAreas'
    || calledMethod === 'getCities'
    || calledMethod === 'getWarehouses';
}

function mockNovaPost(modelName, calledMethod, methodProperties) {
  if (modelName === 'Address' && calledMethod === 'getAreas') {
    return {
      success: true,
      data: [
        {
          Description: 'Київська',
          Ref: '00000000-0000-0000-0000-000000000901',
        },
        {
          Description: 'Львівська',
          Ref: '00000000-0000-0000-0000-000000000902',
        },
        {
          Description: 'Одеська',
          Ref: '00000000-0000-0000-0000-000000000903',
        },
      ],
      errors: [],
      warnings: [],
    };
  }

  if (modelName === 'Address' && calledMethod === 'getCities') {
    const cities = [
      {
        Description: 'Київ',
        AreaDescription: 'Київська',
        AreaRef: '00000000-0000-0000-0000-000000000901',
        Ref: '00000000-0000-0000-0000-000000000001',
      },
      {
        Description: 'Біла Церква',
        AreaDescription: 'Київська',
        AreaRef: '00000000-0000-0000-0000-000000000901',
        Ref: '00000000-0000-0000-0000-000000000002',
      },
      {
        Description: 'Львів',
        AreaDescription: 'Львівська',
        AreaRef: '00000000-0000-0000-0000-000000000902',
        Ref: '00000000-0000-0000-0000-000000000003',
      },
      {
        Description: 'Одеса',
        AreaDescription: 'Одеська',
        AreaRef: '00000000-0000-0000-0000-000000000903',
        Ref: '00000000-0000-0000-0000-000000000004',
      },
    ];
    const filteredCities = methodProperties.AreaRef
      ? cities.filter((city) => city.AreaRef === methodProperties.AreaRef)
      : cities;

    return {
      success: true,
      data: filteredCities,
      errors: [],
      warnings: [],
    };
  }

  if (modelName === 'Address' && calledMethod === 'getWarehouses') {
    return {
      success: true,
      data: [
        {
          Number: '1',
          Description: 'Відділення №1: вул. Хрещатик, 1',
          Ref: '00000000-0000-0000-0000-000000000101',
        },
        {
          Number: '2',
          Description: 'Відділення №2: вул. Велика Васильківська, 20',
          Ref: '00000000-0000-0000-0000-000000000102',
        },
      ],
      errors: [],
      warnings: [],
    };
  }

  if (modelName === 'Counterparty' && calledMethod === 'getCounterparties') {
    return {
      success: true,
      data: [
        {
          Description: 'ТОВ Тестовий Відправник',
          Ref: '00000000-0000-0000-0000-000000000201',
        },
      ],
      errors: [],
      warnings: [],
    };
  }

  if (modelName === 'Counterparty' && calledMethod === 'getCounterpartyContactPersons') {
    return {
      success: true,
      data: [
        {
          Description: 'Тестовий Менеджер',
          Ref: '00000000-0000-0000-0000-000000000301',
          Phones: '380501112233',
        },
      ],
      errors: [],
      warnings: [],
    };
  }

  if (modelName === 'InternetDocument' && calledMethod === 'save') {
    const number = `2045${String(Date.now()).slice(-10)}`;
    return {
      success: true,
      data: [
        {
          Ref: `mock-ref-${number}`,
          IntDocNumber: number,
          CostOnSite: methodProperties.Cost || '500',
          EstimatedDeliveryDate: todayForNovaPost(),
        },
      ],
      errors: [],
      warnings: [],
    };
  }

  if (modelName === 'TrackingDocument' && calledMethod === 'getStatusDocuments') {
    const document = methodProperties.Documents && methodProperties.Documents[0]
      ? methodProperties.Documents[0]
      : {};
    const number = document.DocumentNumber || '20450000000002';

    return {
      success: true,
      data: [
        mockTrackingItem(number),
      ],
      errors: [],
      warnings: [],
    };
  }

  if (modelName === 'InternetDocument' && calledMethod === 'getDocumentPrice') {
    return {
      success: true,
      data: [
        {
          Cost: '95',
          AssessedCost: methodProperties.Cost || '500',
        },
      ],
      errors: [],
      warnings: [],
    };
  }

  if (modelName === 'InternetDocument' && calledMethod === 'getDocumentDeliveryDate') {
    return {
      success: true,
      data: [
        {
          DeliveryDate: todayForNovaPost(),
        },
      ],
      errors: [],
      warnings: [],
    };
  }

  return {
    success: true,
    data: [
      {
        modelName,
        calledMethod,
        methodProperties,
        mock: true,
      },
    ],
    errors: [],
    warnings: [],
  };
}

function mockTrackingItem(number) {
  const lastDigit = String(number).slice(-1);

  if (lastDigit === '1') {
    return createMockTrackingItem(number, 'Створено електронну накладну, очікується передача відправлення', '1');
  }

  if (lastDigit === '3') {
    return createMockTrackingItem(number, 'Прибуло у відділення', '3');
  }

  if (lastDigit === '4') {
    return createMockTrackingItem(number, 'Отримано', '4');
  }

  if (lastDigit === '5') {
    return createMockTrackingItem(number, 'Повернення відправлення', '5');
  }

  return createMockTrackingItem(number, 'Відправлення прямує до міста отримувача', '2');
}

function createMockTrackingItem(number, status, statusCode) {
  return {
    Number: number,
    Status: status,
    StatusCode: statusCode,
    WarehouseRecipient: 'Відділення №1: вул. Хрещатик, 1',
    ScheduledDeliveryDate: todayForNovaPost(),
  };
}

module.exports = {
  NOVA_POST_ENDPOINT,
  buildTtnProperties,
  callNovaPost,
  firstDataItem,
  resolveCityRef,
  todayForNovaPost,
  validateNovaPostApiKey,
};
