import { batchInsertToClickHouse, queueEventToClickHouse, type ClickHouseMappedEvent } from './clickhouse'
import {
  extractProjectIDFromPathname,
  safeJSONObjectParse,
  type InternalServerErrorResponse,
  type UnprocessableEntityResponse,
  // type BadRequestResponse,
} from './utils'

export default {
  async queue(batch: MessageBatch<ClickHouseMappedEvent>, env: Env) {
    await batchInsertToClickHouse(batch.messages, env)
    batch.ackAll()
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const SENTRY_INGEST_DOMAIN = env.SENTRY_INGEST_DOMAIN ?? 'sentry.texts.com'
    const url = new URL(request.url)
    const ip = request.headers.get('CF-Connecting-IP')! || request.headers.get('X-Forwarded-For')?.split(',')[0]
    const headers = new Headers(request.headers)
    if (ip) headers.set('X-Forwarded-For', ip)
    headers.set('X-Texts-Proxy', 'CFW') // CloudFlareWorker
    function proxy(body?: string) {
      return fetch(`https://${SENTRY_INGEST_DOMAIN}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body,
      })
    }
    try {
      if (request.method !== 'POST') return await proxy()
      const contentType = request.headers.get('Content-Type')
      const isFormPost = contentType?.includes('application/x-www-form-urlencoded')
      if (isFormPost) return await proxy() // probably a "session" ping
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
      ctx.waitUntil(queueEventToClickHouse(bodyParts, env, ip))

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
