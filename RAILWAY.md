# Railway Setup

This bot runs as a long-lived Telegram polling worker. It does not need public networking, a domain, or a healthcheck path.

## Why the current deploy crashed

The Railway logs show:

```text
BOT_TOKEN is missing. Add it to .env before starting the bot.
```

Railway does not use your local `.env` file. Add the token in Railway service variables.

## Required Railway Variables

Open the service in Railway, then go to `Variables` and add:

```text
BOT_TOKEN=<token from BotFather>
MAIN_ADMIN_TELEGRAM_USERNAME=timarudy
GOODSCRM_BASE_URL=<GoodsCRM app URL>
BOT_INGEST_SECRET=<same secret as the CRM server>
```

`MAIN_ADMIN_TELEGRAM_USERNAME` is optional. If omitted, the bot uses `timarudy`.
Keep `BOT_INGEST_SECRET` secret too. It must match the CRM server variable with the same name.

Do not set `DATABASE_URL` in this bot service. The CRM owns the Neon/Postgres database, and the bot writes CRM data only through `/api/bot/*`.

## Start Command

This repo includes `railway.json`, so Railway will use:

```bash
npm start
```

You can also set the same value manually in `Settings -> Deploy -> Custom Start Command`:

```bash
npm start
```

Do not use a cron schedule for this bot.

## Local Cache Storage

The bot keeps small Telegram UX/session cache data in JSON. This cache is not the canonical business database. Shops, TTNs, FOP records, permissions, and audit history belong to the CRM database.

Use a Railway Volume only if you need this local cache to survive redeploys.

Optional cache setup:

1. Attach a Volume to the `goodsmanager-bot` service.
2. Set the volume mount path to:

```text
/app/data
```

The app will write `/app/data/store.json`.

Alternative setup:

1. Mount the volume at:

```text
/data
```

2. Add this Railway variable:

```text
STORE_PATH=/data/store.json
```

The app also supports Railway's automatic `RAILWAY_VOLUME_MOUNT_PATH` variable, but the explicit `STORE_PATH` is clearer for cache placement.

## Railway Settings

In `Settings -> Deploy`:

- Custom Start Command: `npm start`
- Cron Schedule: leave empty
- Healthcheck Path: leave empty
- Serverless: off
- Restart Policy: `On Failure`

In `Settings -> Scale`:

- Keep one replica only.

Telegram polling must run in a single process. Multiple replicas can process the same updates twice.

In `Settings -> Networking`:

- Public networking is not required for polling mode.

## Local JSON Cache

The bot always writes its local cache to `data/store.json` or `STORE_PATH`. Do not use a bot-side Postgres database for this cache.
