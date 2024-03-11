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
    const url = new URL(request.url)
    const ip = request.headers.get('CF-Connecting-IP')! || request.headers.get('X-Forwarded-For')?.split(',')[0]
    const headers = new Headers(request.headers)
    if (ip) headers.set('X-Forwarded-For', ip)
    headers.set('X-Texts-Proxy', 'CFW') // CloudFlareWorker
    async function proxy(body: string | Response['body'] = request.body) {
      const originURL = `https://${env.SENTRY_INGEST_DOMAIN}${url.pathname}${url.search}`
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
      if (contentType?.toLocaleLowerCase().includes('x-www-form-urlencoded')) {
        // https://sentry.texts.com/api/embed/error-page/
        // ?dsn=https://149910420e63a427ae83d590334fa5c0@sentry.texts.com/2
        // &eventId=18aa67ea805449be814d0644fbdcc0ab
        // &name=Batuhan%20Icoz
        // &email=batuhan.icoz%40a8c.com
        // &title=Looks%20like%20an%20error%20occurred
        // &subtitle=If%20you%20have%20more%20details%2C%20let%20us%20know%20so%20we%20can%20fix%20it%20faster.
        // &subtitle2=
        // check path for /api/embed/error-page/
        if (url.pathname.endsWith('/embed/error-page/')) {
          const dsn = url.searchParams.get('dsn')
          const eventId = url.searchParams.get('eventId')
          if (!dsn || !eventId) return UnprocessableEntityResponse()
          const name = url.searchParams.get('name')
          const email = url.searchParams.get('email')
          const title = url.searchParams.get('title')
          const subtitle = url.searchParams.get('subtitle')
          const subtitle2 = url.searchParams.get('subtitle2')

          const body = await request.formData()
          const parts = body.split('&')
          const eventId = parts.find(p => p.startsWith('eventId='))
          if (eventId) {
            const projectId = extractProjectIDFromPathname(url.pathname)
            if (projectId === null) return UnprocessableEntityResponse()
            const mapped: ClickHouseMappedEvent = {
              created_at: new Date(),
              log_level: 'info',
              log_message: `sentry-error-page | ${projectId} | ${eventId}`,
              event_type: 'sentry-error-page',
              event_data: JSON.stringify(parts.reduce((acc, part) => {
                const [key, value] = part.split('=')
                acc[key] = value
                return acc
              }, {} as Record<string, string>)),
              metadata: JSON.stringify({ ip }),
              device_id: projectId,
            }
            ctx.waitUntil(queueEventToClickHouse([JSON.stringify(mapped)], env, ip))
          }
        }
        return await proxy() // probably a "session" ping
      }
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
