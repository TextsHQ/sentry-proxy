# How-to setup on CloudFlare

First, setup $5 monthly plan for workers (required for queues)
https://dash.cloudflare.com/46893543e9884e365e21af746cb2d9d7/workers/plans


```bash
git clone git@github.com:textshq/sentry-proxy.git
cd sentry-proxy
bun install
bun wrangler login
bun wrangler queues create texts-sentry-queue # if fails create here https://dash.cloudflare.com/46893543e9884e365e21af746cb2d9d7/workers/queues
bun wrangler deploy
# secret put is interactive, it'll ask for the value
bun wrangler secret put CLICKHOUSE_HOST
bun wrangler secret put CLICKHOUSE_PASSWORD
# to be safe :D
bun wrangler deploy
```

After setup, go [here](https://dash.cloudflare.com/46893543e9884e365e21af746cb2d9d7/workers/services/view/texts-sentry-proxy/production/triggers) to setup the route:

Route: sentry.texts.com/api/2/envelope/
Zone: texts.com
