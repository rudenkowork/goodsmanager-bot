# AGENTS.md

This file is the first thing every agent must read before analyzing, editing, or suggesting code in this project.

## Project Goal

This is a Telegram bot for managing Nova Poshta shipments.

The bot helps users:

- log in with a local bot account;
- add Nova Poshta API cabinets;
- create TTNs through a guided chat flow;
- track shipment status;
- manage users and cabinets as an admin.

Keep the project small, direct, and easy to continue in a new chat.

## Core Principles

- Use KISS: keep it short, simple, and readable.
- Prefer direct functions over abstractions.
- Avoid enterprise patterns, frameworks, and unnecessary layers.
- Keep methods compact.
- Avoid deep nesting.
- Do not use the `switch` operator. Use straightforward `if` / `else` logic.
- Comments in code must be in English.
- User-facing bot text is Ukrainian, warm, clear, and concise.
- A few emojis are allowed for important moments, but avoid visual noise.
- Do not expose Nova Poshta `Ref` values to normal users in guided flows.
- Do not show huge lists in chat messages. Use reply-keyboard buttons and pagination where needed.
- Do not start the bot unless the user asks for it.

## Commands

Run syntax checks after code changes:

```bash
npm run check
```

Start the bot only when explicitly requested:

```bash
npm start
```

Check running bot processes:

```bash
ps aux | rg "(node .*index\\.js|node-telegram-bot|goodsmanager-bot)"
```

Stop a running bot process:

```bash
kill PID
```

## Runtime Data

Local runtime data lives in:

- `data/store.json`

Example empty structure lives in:

- `data/store.example.json`

`data/store.json` contains:

- `config`: main admin username and Nova Poshta endpoint;
- `users`: local bot users with password salt/hash;
- `sessions`: Telegram user id to logged-in account;
- `apiKeys`: saved Nova Poshta cabinets;
- `selectedApiKeyByUser`: selected cabinet per local bot user;
- `shipments`: created TTNs and raw API responses;
- `flows`: active Telegram conversation flows;
- `botMessagesByChat`: bot message ids used for chat cleanup.

Be careful with `data/store.json`.

- Do not expose real API keys.
- Mask secrets in chat output.
- Do not reset or delete runtime data unless the user asks or a stale flow must be cleared after a flow-shape change.
- It is acceptable to remove a clearly invalid test key when fixing key validation.

## Main Files

`index.js`

- Telegram bot setup.
- Command routing.
- Reply-keyboard menus.
- Conversation flow handlers.
- Small flow-specific helpers.

Keep `index.js` as the owner of chat flow, but do not put low-level infrastructure there.

`src/createTtnConfig.js`

- Button labels.
- Create TTN field order.
- Settlement type choices.
- Delivery type choices.
- Main city priority by area.
- Pagination and lookup limits.

`src/novaPost.js`

- Nova Poshta API client.
- Mock Nova Poshta responses.
- API key validation.
- TTN `methodProperties` builder.
- Address directory helpers.

`src/auth.js`

- Login/session checks.
- Admin checks.
- Password hashing.
- Selected Nova Poshta cabinet lookup.

`src/store.js`

- `data/store.json` creation.
- Store read/write.
- Active flow get/set/clear.

`src/textUtils.js`

- Command parsing.
- JSON argument parsing.
- Alias/login normalization.
- Button label trimming.
- Long Telegram message chunking.

`src/validators.js`

- Weight validation.
- Money validation.
- Positive integer validation.
- Phone normalization.
- Full name validation.

`ARCHITECTURE.md`

- Human-readable architecture notes.
- Keep it in sync when changing major flow or module responsibilities.

## Telegram UX Rules

Use reply keyboards for normal user choices.

Use text input only when the user must type:

- API key;
- TTN number;
- weight;
- cost;
- phone;
- full name;
- warehouse/postomat number.

For manual text input, remove the reply keyboard so Telegram keeps the input comfortable:

```js
reply_markup: {
  remove_keyboard: true,
}
```

Do not print numbered lists of areas, cities, warehouses, or postomats in chat messages.

For lists:

- areas: show all as buttons, no pagination needed;
- settlements: use buttons and pagination if needed;
- sender counterparties and contacts: use buttons and pagination if needed;
- sender delivery point in create TTN flow: branch only, no postomat choice.
- recipient delivery point in create TTN flow: branch or postomat.
- warehouses/postomats in create TTN flow: do not show a list. Ask for the number, validate through Nova Poshta API, then confirm the full address.

## Create TTN Flow

The guided create flow is configured in `src/createTtnConfig.js`.

Current flow:

1. Choose Nova Poshta cabinet.
2. Enter shipment description.
3. Enter weight.
4. Enter declared cost.
5. Enter seats amount.
6. Show a sender-section notice.
7. Choose sender FOP/company from Nova Poshta API.
8. Choose sender contact person from Nova Poshta API.
9. If contact phone exists, use it automatically and skip sender phone input.
10. Choose sender area.
11. Choose sender settlement type: city, urban-type settlement, settlement, or village.
12. Choose sender settlement.
13. Enter sender branch number. Sender postomat is not offered.
14. Validate sender branch through Nova Poshta API and confirm full address.
15. Show a recipient-section notice.
16. Choose recipient area.
17. Choose recipient settlement type.
18. Choose recipient settlement.
19. Choose recipient delivery point type: branch or postomat.
20. Enter recipient branch/postomat number.
21. Validate recipient point through Nova Poshta API and confirm full address.
22. Enter recipient full name.
23. Enter recipient phone.
24. Choose payer: sender or recipient.
25. Build Nova Poshta `methodProperties` and create TTN.

Important:

- Normal users should not type Nova Poshta `Ref` values.
- Sender counterparty and contact refs are selected by button, then saved internally.
- City and warehouse refs are selected or resolved internally.
- `PaymentMethod` is not asked in UX. It defaults to `Cash` in `buildTtnProperties`.

## Nova Poshta API Rules

Use `callNovaPost()` from `src/novaPost.js` for Nova Poshta requests.

API key validation:

- Validate every new key before saving it.
- `MOCK` is allowed for local testing.
- A short key like `277262` must not be saved.
- Real keys are validated with a Nova Poshta API request.

Address directory behavior:

- `getAreas`, `getCities`, and `getWarehouses` should use live Nova Poshta directory data even when the selected cabinet is `MOCK`.
- This prevents mock data from limiting real area/city/warehouse choices.

Warehouse/postomat validation:

- Ask the user for a point number.
- Query `Address/getWarehouses` with `CityRef` and `WarehouseId`.
- If not found, try a small `FindByString` fallback.
- Match delivery type: branch or postomat.
- If valid, save the value expected by Nova Poshta and confirm full address to the user.

## Validation Rules

Validate before saving or sending data to Nova Poshta.

API key:

- Validate before saving.
- Keep invalid keys out of `data/store.json`.

Phone:

- Accept `380XXXXXXXXX`.
- Accept local `0XXXXXXXXX` and normalize to `380XXXXXXXXX`.
- Reject anything else.

Recipient full name:

- At least first name and last name.
- Up to four words.
- Letters only, with hyphen and apostrophe allowed.
- Reject digits and strange symbols.

Money:

- Accept numbers in UAH.
- Accept decimals with up to two digits.
- Reject negative values.

Weight:

- Accept positive number in kg.

Seats amount:

- Accept positive integer.

## Copy Style

Bot copy should feel like a helpful manager, not a raw API console.

Good:

- "Готово, кабінет збережено."
- "Введіть номер відділення. Я перевірю його й покажу повну адресу."
- "Не знайшов таку точку доставки. Перевірте номер і введіть його ще раз."

Avoid:

- raw API wording in normal flows;
- "Ref відправника";
- long technical explanations;
- huge chat lists;
- too many emojis.

## Architecture Rule of Thumb

When adding code:

- Put Telegram conversation behavior in `index.js`.
- Put stable field order and labels in `src/createTtnConfig.js`.
- Put Nova Poshta request logic in `src/novaPost.js`.
- Put generic input checks in `src/validators.js`.
- Put store access in `src/store.js`.
- Put auth/session logic in `src/auth.js`.
- Put parsing/string helpers in `src/textUtils.js`.

If a helper is only used by one flow and is easy to read, keeping it in `index.js` is fine.

If a helper is reusable, technical, or easy to test separately, move it into `src/`.

## Safety Notes

- Never revert user changes unless explicitly asked.
- Do not use destructive git commands.
- This project may not be a git repository.
- Prefer `rg` for searching.
- Use `apply_patch` for manual edits.
- Do not create files with shell heredocs or `cat`.
- After flow-structure changes, clear stale `createTtn` flows from `data/store.json` if needed.
