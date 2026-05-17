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
```

`MAIN_ADMIN_TELEGRAM_USERNAME` is optional. If omitted, the bot uses `timarudy`.

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

## Persistent JSON Storage For Now

For now the bot stores data in `data/store.json`.

To persist that file on Railway, attach a Railway Volume to this service.

Recommended simple setup:

1. In Railway, create or attach a Volume to the `goodsmanager-bot` service.
2. Set the volume mount path to:

```text
/app/data
```

The app writes to `./data/store.json`, and Railway places the app at `/app`, so `/app/data` makes the JSON store persistent.

Alternative setup:

1. Mount the volume at:

```text
/data
```

2. Add this Railway variable:

```text
STORE_PATH=/data/store.json
```

The app also supports Railway's automatic `RAILWAY_VOLUME_MOUNT_PATH` variable, but the explicit `STORE_PATH` is clearer.

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

## Later Neon Migration

When moving to Neon/Postgres later:

- keep Railway only for the bot worker;
- add Neon connection string as `DATABASE_URL`;
- move store reads/writes out of `src/store.js` into a database-backed store module;
- migrate `users`, `sessions`, `apiKeys`, `selectedApiKeyByUser`, `shipments`, and `flows`.

Until then, use the Railway Volume approach above.

