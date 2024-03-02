import { getClickhouseClient, insertSentryEventToClickHouse, mapSentryEventToClickHouseEvent } from './clickhouse'
import {
  // BadRequestResponse,
  extractProjectIDFromPathname, InternalServerErrorResponse,
  safeJSONObjectParse,
  UnprocessableEntityResponse,
} from './utils'

async function logEventToClickHouse(bodyParts: string[], env: Env, ip?: string) {
  const definition = safeJSONObjectParse<{ type: 'event' }>(bodyParts[1])
  if (definition?.type !== 'event') return
  const mapped = mapSentryEventToClickHouseEvent(bodyParts[2], ip)
  await env.CLICKHOUSE_WRITE_QUEUE.send(mapped, {
    contentType: 'json',
  })
  await insertSentryEventToClickHouse(env, bodyParts[2], ip)
}

export default {
  async queue(batch: MessageBatch, env: Env) {
    const client = getClickhouseClient(env)
    if (!client) return

    await client.insert({
      table: 'texts_events',
      values: batch.messages,
      clickhouse_settings: { date_time_input_format: 'best_effort' },
      format: 'JSONEachRow',
    })
    batch.ackAll()
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const SENTRY_INGEST_DOMAIN = env.SENTRY_INGEST_DOMAIN ?? 'sentry.texts.com'
    const url = new URL(request.url)
    const ip = request.headers.get('CF-Connecting-IP')!
    function proxy(body?: string) {
      return fetch(`https://${SENTRY_INGEST_DOMAIN}${url.pathname}${url.search}`, {
        method: request.method,
        headers: {
          ...request.headers,
          'X-Forwarded-For': ip,
        },
        body,
      })
    }
    try {
      if (request.method !== 'POST') return await proxy()
      const body = await request.text()
      if (!body) return UnprocessableEntityResponse()
      if (!url.pathname.endsWith('/envelope/')) return await proxy(body)
      const projectId = extractProjectIDFromPathname(url.pathname)
      if (projectId === null) return UnprocessableEntityResponse()

      const bodyParts = body.split('\n')
      const head = safeJSONObjectParse<{
        event_id: string
        sent_at: string
        sdk: {
          name: string
          version: string
        }
      }>(bodyParts[0])

      // send to clickhouse
      ctx.waitUntil(logEventToClickHouse(bodyParts, env, ip))

      // proxy to sentry
      ctx.waitUntil(proxy(body))

      // don't wait, just respond back to the client
      return new Response(JSON.stringify({
        id: head?.event_id,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    } catch (error) {
      console.error(error)
      return InternalServerErrorResponse()
    }
  },
}
