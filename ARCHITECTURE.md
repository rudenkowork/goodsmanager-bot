# Bot architecture

This project is intentionally small and simple. Keep code direct, avoid deep abstractions, and prefer moving stable technical code out of `index.js` instead of building a framework.

## Entry point

`index.js` wires Telegram handlers and owns the conversation flow.

Keep in `index.js`:

- Telegram command routing.
- Conversation steps.
- Message text that belongs to a specific flow.
- Small flow-specific helpers.

Do not put low-level API clients, JSON-store plumbing, password hashing, or generic validators in `index.js`.

## Modules

`src/auth.js`

- User sessions.
- Login/admin checks.
- Password hashing.
- Selected Nova Poshta API key lookup.

`src/createTtnConfig.js`

- Create TTN field order.
- Reply button labels.
- Settlement and delivery type choices.
- Main city priority per area.
- Pagination and lookup limits.

`src/novaPost.js`

- Nova Poshta API calls.
- Mock Nova Poshta responses.
- TTN methodProperties builder.
- Address directory helpers.

`src/store.js`

- `data/store.json` creation, reading, and writing.
- Active flow get/set/clear.
- Saved default sender/contact pairs per local user and Nova Poshta cabinet.
- Saved default sender branches per local user and Nova Poshta cabinet.
- Railway Volume support through `STORE_PATH` or `RAILWAY_VOLUME_MOUNT_PATH`.

`src/textUtils.js`

- Command parsing.
- JSON argument parsing.
- Alias/login normalization.
- Button label trimming.
- Long Telegram message chunking.

`src/validators.js`

- User input validation for weight, money, positive integers, and phone numbers.

## Create TTN flow

The human-facing flow should avoid exposing Nova Poshta `Ref` values.

Current sender flow:

1. Choose API cabinet by alias.
2. If the user saved default sender/contact pairs, choose one by name or select another sender.
3. If no default sender is used, choose sender counterparty from all senders returned by the Nova Poshta API key.
4. Choose sender contact person.
5. Use contact phone automatically when Nova Poshta returns it.
6. If the user saved default sender branches, choose one by name or select another branch.
7. If no default branch is used, choose sender area, settlement type, settlement, and enter branch number. Sender postomat is not offered.

The bot skips the cabinet, sender, or contact choice when there is only one valid option. New senders are created in the Nova Poshta cabinet, then the bot can refresh the API list. Seats amount and delivery payer are not asked in chat; TTN creation uses defaults in `buildTtnProperties`.

Current recipient address flow:

1. Area.
2. Settlement type: city, urban-type settlement, settlement, village.
3. Settlement.
4. Delivery type: branch or postomat.
5. Exact point: user enters a number, bot validates it through Nova Poshta API and confirms the full address.

## UX rules

- Do not ask users to enter Nova Poshta `Ref` manually in normal flows.
- Use reply-keyboard buttons for choices.
- Do not print huge choice lists in chat text.
- Use pagination only when needed and keep it in buttons.
- Do not show warehouse/postomat lists in the create TTN flow; ask for the point number and validate it.
- For sender address, use branch only. For recipient address, allow branch or postomat.
- Keep manual text inputs free of reply keyboards so the phone keyboard stays usable.
- Keep bot copy warm, clear, and short. A few emojis are fine for key moments, but avoid visual noise.

## Validation

- Validate Nova Poshta API keys before saving them. Do not keep a key if Nova Poshta rejects it.
- Validate recipient full name before creating a TTN: at least first and last name, letters only, with hyphen/apostrophe allowed.
- Normalize phones to `380XXXXXXXXX`; accept local `0XXXXXXXXX` input and convert it.

Run:

```bash
npm run check
```

This checks `index.js` and every file in `src/`.

## Railway

- The bot runs as a polling worker with `npm start`.
- Required variable: `BOT_TOKEN`.
- Optional variable: `MAIN_ADMIN_TELEGRAM_USERNAME`.
- Use a Railway Volume for `store.json` until Neon/Postgres is added.
- Recommended volume mount path: `/app/data`.
- Keep one replica only and keep Serverless off.
