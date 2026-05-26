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
- Payment type choices for no payment, cash on delivery, and payment control.
- Main city priority per area.
- Pagination and lookup limits.

`src/novaPost.js`

- Nova Poshta API calls.
- Mock Nova Poshta responses.
- TTN methodProperties builder.
- Cash on delivery and payment-control payload fields.
- Payment-control availability checks.
- Tracking status requests.
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
2. Automatically use the first sender returned by the selected Nova Poshta API key.
3. Automatically use the first sender contact with a phone from that sender, or the first contact if none have a phone.
4. Use contact phone automatically when Nova Poshta returns it; otherwise ask for sender phone manually.
5. If the user saved default sender branches, choose one by name or select another branch.
6. If no default branch is used, choose sender area, settlement type, settlement, and enter branch number. Sender postomat is not offered.

The bot skips the cabinet choice when there is only one valid option. New senders are created in the Nova Poshta cabinet, then the bot can refresh the API list. Seats amount and delivery payer are not asked in chat; TTN creation uses defaults in `buildTtnProperties`.

Payment flow:

1. Ask whether the TTN has no payment, cash on delivery, or payment control.
2. For cash on delivery, add `BackwardDeliveryData` with `CargoType: Money`.
3. For payment control, check whether the selected sender supports `CanAfterpaymentOnGoodsCost`.
4. If payment control is unavailable, explain that the Nova Poshta account needs the agreement and offer cash on delivery or no payment.
5. Ask the payment amount only when cash on delivery or payment control is selected.

If Nova Poshta rejects TTN creation, keep the draft flow alive and offer a focused correction step. Known API errors should be translated into plain Ukrainian and route the user back to the likely bad field, such as weight, declared cost, or recipient delivery point.

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
- For shipment/payment/return reports, print compact message lists rather than one button per TTN.
- Use pagination only when needed and keep it in buttons.
- Do not show warehouse/postomat lists in the create TTN flow; ask for the point number and validate it.
- For sender address, use branch only. For recipient address, allow branch or postomat.
- Keep manual text inputs free of reply keyboards so the phone keyboard stays usable.
- Keep bot copy warm, clear, and short. A few emojis are fine for key moments, but avoid visual noise.

## Shipment CRM sections

`index.js` owns the Telegram UX for:

- `Мої відправки`: today, selected date, one or several FOPs, all FOPs, and single-TTN tracking.
- `Оплати`: all payments, waiting payments, received payments, and FOP filters.
- `Повернення`: all returns, FOP filters, and today's returns.

Created TTNs are stored in `store.shipments[number]` with the original cabinet alias, creator, creation date, recipient summary, delivery point, optional payment metadata, latest normalized tracking status, and optional return linkage. Old records may only have `{ apiKeyAlias, createdBy, createdAt, ref, raw }`, so report code must keep tolerating missing fields.

Tracking uses `TrackingDocument/getStatusDocuments` grouped by Nova Poshta cabinet. Payment and return sections reuse the latest tracking fields instead of storing full raw tracking responses.

## Validation

- Validate Nova Poshta API keys before saving them. Do not keep a key if Nova Poshta rejects it.
- Validate recipient full name before creating a TTN: at least first and last name, letters only, with hyphen/apostrophe allowed.
- Normalize phones to `380XXXXXXXXX`; accept local `0XXXXXXXXX` input and convert it.

Run:

```bash
npm run check
```

This checks `index.js` and every file in `src/`.

## Deployment

- The bot runs with `npm start`.
- Default mode is polling, which is best for always-on workers such as Railway.
- Render Free web services should use webhook mode so Telegram update requests can wake the sleeping service.
- Required variable: `BOT_TOKEN`.
- Optional variable: `MAIN_ADMIN_TELEGRAM_USERNAME`.

Polling mode:

```text
BOT_MODE=polling
```

Webhook mode:

```text
BOT_MODE=webhook
WEBHOOK_SECRET=<long random value>
```

Render provides `RENDER_EXTERNAL_URL` for web services. For custom domains or other hosts, set:

```text
WEBHOOK_BASE_URL=https://your-public-domain.example
```

## Railway

- Use a Railway Volume for `store.json` until Neon/Postgres is added.
- Recommended volume mount path: `/app/data`.
- Keep one replica only and keep Serverless off.
