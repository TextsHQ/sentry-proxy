import { batchInsertToClickHouse, queueEventToClickHouse, type ClickHouseMappedEvent } from './clickhouse'
import {
  extractProjectIDFromPathname,
  safeJSONObjectParse,
  InternalServerErrorResponse,
  UnprocessableEntityResponse,
  // BadRequestResponse,
} from './utils'

export default {
  async queue(batch: MessageBatch<ClickHouseMappedEvent>, env: Env) {
    await batchInsertToClickHouse(batch.messages.map(evt => evt.body), env)
    batch.ackAll()
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const SENTRY_INGEST_DOMAIN = env.SENTRY_INGEST_DOMAIN ?? 'sentry.texts.com'
    const url = new URL(request.url)
    const ip = request.headers.get('CF-Connecting-IP')! || request.headers.get('X-Forwarded-For')?.split(',')[0]
    const headers = new Headers(request.headers)
    if (ip) headers.set('X-Forwarded-For', ip)
    headers.set('X-Texts-Proxy', 'CFW') // CloudFlareWorker
    async function proxy(body: string | Response['body'] = request.body) {
      const originURL = `https://${SENTRY_INGEST_DOMAIN}${url.pathname}${url.search}`
      console.info('upstream request', request.method, url.pathname, url.search)
      return fetch(originURL, {
        method: request.method,
        headers: request.headers,
        body: request.method === 'POST' ? body : undefined,
      })
    }
    try {
      if (request.method !== 'POST') return await proxy()
      const contentType = request.headers.get('Content-Type')
      if (contentType?.toLocaleLowerCase().includes('x-www-form-urlencoded')) return await proxy() // probably a "session" ping
      const body = await request.text()
      if (!body || !url.pathname.endsWith('/envelope/')) return await proxy(body)
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
      ctx.waitUntil(queueEventToClickHouse(bodyParts, env, ip))

      // proxy to sentry
      ctx.waitUntil(proxy(body))

      // don't wait, just respond back to the client
      return new Response(
        JSON.stringify({ id: head?.event_id }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    } catch (error) {
      console.error(error)
      return InternalServerErrorResponse()
    }
  },
}
