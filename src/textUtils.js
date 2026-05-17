function parseCommand(text) {
  if (!text.startsWith('/')) {
    return null;
  }

  const spaceIndex = text.indexOf(' ');
  if (spaceIndex === -1) {
    return {
      command: text.toLowerCase(),
      args: '',
    };
  }

  return {
    command: text.slice(0, spaceIndex).toLowerCase(),
    args: text.slice(spaceIndex + 1).trim(),
  };
}

function parseJsonArgument(text) {
  if (!text || !text.trim()) {
    return null;
  }

  return JSON.parse(text.trim());
}

function parseNovaPostGenericArgs(args) {
  const firstSpace = args.indexOf(' ');
  if (firstSpace === -1) {
    return null;
  }

  const modelName = args.slice(0, firstSpace).trim();
  const rest = args.slice(firstSpace + 1).trim();
  const secondSpace = rest.indexOf(' ');

  if (!modelName || secondSpace === -1) {
    return null;
  }

  const calledMethod = rest.slice(0, secondSpace).trim();
  const jsonText = rest.slice(secondSpace + 1).trim();

  if (!calledMethod || !jsonText) {
    return null;
  }

  return {
    modelName,
    calledMethod,
    methodProperties: JSON.parse(jsonText),
  };
}

function splitArgs(args) {
  return args.trim().split(/\s+/).filter(Boolean);
}

function normalizeLogin(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeAlias(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeSearchText(value) {
  return String(value || '').trim().toLowerCase();
}

function maskSecret(secret) {
  if (!secret || secret.length < 8) {
    return '***';
  }

  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function trimButtonLabel(value) {
  const text = String(value);

  if (text.length <= 80) {
    return text;
  }

  return `${text.slice(0, 77)}...`;
}

function chunkText(text, maxLength) {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let cutAt = remaining.lastIndexOf('\n', maxLength);
    if (cutAt < 1) {
      cutAt = maxLength;
    }

    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

module.exports = {
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
};
