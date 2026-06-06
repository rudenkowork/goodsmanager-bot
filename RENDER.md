# Render Setup

Render Free web services sleep after idle time and wake only when they receive an HTTP request. Telegram polling does not create an inbound HTTP request to the service, so a sleeping polling bot cannot wake when a user writes to it.

Use webhook mode on Render. Telegram will send each update as an HTTPS request to the Render service, and that request wakes the service.

## Render Variables

Add these variables in the Render service:

```text
BOT_TOKEN=<token from BotFather>
MAIN_ADMIN_TELEGRAM_USERNAME=timarudy
BOT_MODE=webhook
WEBHOOK_SECRET=<long random value with letters, numbers, underscores, or dashes>
GOODSCRM_BASE_URL=<GoodsCRM app URL>
BOT_INGEST_SECRET=<same secret as the CRM server>
```

`WEBHOOK_BASE_URL` is optional on Render because Render provides `RENDER_EXTERNAL_URL` automatically for web services. Add it only if you use a custom domain:

```text
WEBHOOK_BASE_URL=https://your-domain.example
```

Keep `BOT_INGEST_SECRET` secret too. It must match the CRM server variable with the same name.
Do not set `DATABASE_URL` in this bot service. The CRM owns the Neon/Postgres database, and the bot writes CRM data only through `/api/bot/*`.

The bot keeps small Telegram UX/session cache data in local JSON. Render's free ephemeral filesystem can lose that cache after restarts; CRM data remains durable because it is written through the CRM API.

## Start Command

Use the same start command:

```bash
npm start
```

## Health Check

The app responds with `ok` on:

```text
/
/health
/healthz
```

You can use `/health` as the Render health check path.

## Important Notes

- Keep one Render instance only.
- Do not run polling and webhook mode at the same time for the same Telegram bot token.
- Do not point this bot at the CRM database.
- Use `STORE_PATH` only if your Render plan provides durable disk storage for local cache.
- The first message after Render sleeps may be delayed while Render starts the service.
- If you need instant replies all day, use a paid always-on instance or a host that supports long-running workers.
