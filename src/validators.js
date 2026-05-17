function normalizeWeight(value) {
  const cleaned = String(value).trim().toLowerCase().replace(',', '.');
  const match = cleaned.match(/^(\d+(?:\.\d+)?)(?:\s*кг)?$/);

  if (!match) {
    return {
      ok: false,
      message: 'Вага має бути числом у кг. Наприклад: 1 або 1.5.',
    };
  }

  const number = Number(match[1]);

  if (!Number.isFinite(number) || number <= 0) {
    return {
      ok: false,
      message: 'Вага має бути більшою за 0.',
    };
  }

  return {
    ok: true,
    value: formatNumberForApi(number),
  };
}

function normalizeMoney(value) {
  const cleaned = String(value).trim().toLowerCase().replace(',', '.');
  const match = cleaned.match(/^(\d+(?:\.\d{1,2})?)(?:\s*(грн|uah))?$/);

  if (!match) {
    return {
      ok: false,
      message: 'Вартість має бути числом у грн. Наприклад: 500 або 500.50.',
    };
  }

  const number = Number(match[1]);

  if (!Number.isFinite(number) || number < 0) {
    return {
      ok: false,
      message: 'Вартість не може бути відʼємною.',
    };
  }

  return {
    ok: true,
    value: formatNumberForApi(number),
  };
}

function normalizePositiveInteger(value) {
  const cleaned = String(value).trim();

  if (!/^\d+$/.test(cleaned)) {
    return {
      ok: false,
      message: 'Введіть ціле число.',
    };
  }

  const number = Number(cleaned);

  if (!Number.isInteger(number) || number <= 0) {
    return {
      ok: false,
      message: 'Кількість має бути цілим числом більше 0.',
    };
  }

  return {
    ok: true,
    value: String(number),
  };
}

function normalizePhone(value) {
  const digits = String(value).replace(/\D/g, '');
  let phone = digits;

  if (phone.length === 10 && phone.startsWith('0')) {
    phone = `38${phone}`;
  }

  if (phone.length === 12 && phone.startsWith('380')) {
    return {
      ok: true,
      value: phone,
    };
  }

  return {
    ok: false,
    message: 'Телефон виглядає некоректно. Введіть у форматі 380XXXXXXXXX або 0XXXXXXXXX.',
  };
}

function normalizeFullName(value) {
  const cleaned = String(value || '').trim().replace(/\s+/g, ' ');
  const parts = cleaned.split(' ').filter(Boolean);

  if (parts.length < 2) {
    return {
      ok: false,
      message: 'Введіть імʼя та прізвище отримувача. Наприклад: Іван Петренко.',
    };
  }

  if (parts.length > 4) {
    return {
      ok: false,
      message: 'ПІБ виглядає занадто довгим. Введіть імʼя, прізвище та за потреби по батькові.',
    };
  }

  const invalidPart = parts.find((part) => !/^[\p{L}'ʼ`-]{2,}$/u.test(part));

  if (invalidPart) {
    return {
      ok: false,
      message: 'ПІБ має містити тільки літери, дефіс або апостроф.',
    };
  }

  return {
    ok: true,
    value: cleaned,
  };
}

function formatNumberForApi(number) {
  if (Number.isInteger(number)) {
    return String(number);
  }

  return String(number).replace(/0+$/, '').replace(/\.$/, '');
}

module.exports = {
  normalizeFullName,
  normalizeMoney,
  normalizePhone,
  normalizePositiveInteger,
  normalizeWeight,
};
