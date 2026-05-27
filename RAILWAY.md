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
DATABASE_URL=<Neon connection string with sslmode=require>
```

`MAIN_ADMIN_TELEGRAM_USERNAME` is optional. If omitted, the bot uses `timarudy`.
Keep `DATABASE_URL` secret. Do not paste the real value into commits, logs, or screenshots.

The app refuses to start on Railway without `DATABASE_URL`; this prevents accidental writes to temporary local JSON storage.

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

## Persistent Neon Storage

When `DATABASE_URL` is set, the bot stores the same data shape in Neon/Postgres in a `bot_store` table.

On first startup with an empty `bot_store` table, the app seeds Postgres from the existing JSON store if `data/store.json` or `STORE_PATH` exists. This keeps old users, sessions, API cabinets, default senders, shipments, flows, and cleanup message ids.

Use a Railway Volume only if you still need the JSON file as a temporary fallback or first-run migration source.

Optional migration setup:

1. Attach the old Volume to the `goodsmanager-bot` service.
2. Set the volume mount path to:

```text
/app/data
```

The app will read `/app/data/store.json` once when the Neon table has no row yet.

Alternative setup:

1. Mount the volume at:

```text
/data
```

2. Add this Railway variable:

```text
STORE_PATH=/data/store.json
```

The app also supports Railway's automatic `RAILWAY_VOLUME_MOUNT_PATH` variable, but the explicit `STORE_PATH` is clearer for migration.

After the first successful Neon startup, the Volume is no longer required for persistence.

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

## Local JSON Fallback

If `DATABASE_URL` is omitted, the bot writes to `data/store.json` locally. This is useful for development only; production should use Neon. For an emergency production fallback only, set `ALLOW_JSON_STORE_IN_PRODUCTION=true`.
