import { createClient } from '@clickhouse/client-web'
import { safeJSONObjectParse } from './utils'

type ClickHouseCredentials = {
  CLICKHOUSE_HOST: string
  CLICKHOUSE_USER: string
  CLICKHOUSE_PASSWORD: string
}

export const getClickhouseClient = ({ CLICKHOUSE_HOST, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD }: ClickHouseCredentials) => {
  if (!CLICKHOUSE_HOST || !CLICKHOUSE_USER || !CLICKHOUSE_PASSWORD) return
  return createClient({
    host: CLICKHOUSE_HOST,
    username: CLICKHOUSE_USER,
    password: CLICKHOUSE_PASSWORD,
  })
}

type ClickhouseGrafanaErrorLevel = 'critical' | 'error' | 'warning' | 'info' | 'debug' | 'trace' | 'unknown'

type ClickHouseEventForSentry = {
  created_at?: Date
  log_level: ClickhouseGrafanaErrorLevel
  log_message: string[] | string
  event_type: 'sentry-event'
  event_data: Record<string, unknown> | string
  metadata: {
    os?: {
      name?: string
      version?: string
    } | string
    appVersion?: string
    arch?: string
    isWKWV?: boolean
    ip?: string
    platformName?: string
    sentryEventID?: string
  }
  device_id?: string
}

type SentryExceptionFrame = {
  function?: string
  filename?: string
  module?: string
  lineno?: number
  colno?: number
  in_app?: boolean
  pre_context?: string[]
  context_line?: string
  post_context?: string[]
}

type SentryException = {
  values: {
    type?: string
    value?: string
    stacktrace?: {
      frames?: SentryExceptionFrame[]
    }
  }[]
}

function truncateString(str: string, length = 300) {
  const trimmed = str.trim()
  return trimmed.length > length ? `${trimmed.slice(0, length)}...` : trimmed
}

export function mapSentryEventToClickHouseEvent(event: any, ip?: string) {
  const parsed = safeJSONObjectParse<any>(event)
  const message = parsed?.message as string
  const created_at = parsed?.timestamp ? new Date(parsed.timestamp * 1000) : undefined
  const tags = (parsed?.tags || {}) as Record<string, string>
  const { device_id, ..._tags } = tags
  const release = parsed?.release as string
  const extra = (parsed?.extra || {}) as Record<string, string>
  const { platformName, ...restExtra } = extra
  let exceptions: {
    type?: string
    value?: string
    stacktrace?: Pick<SentryExceptionFrame, 'function' | 'pre_context' | 'post_context'>[]
  }[] = []
  if (parsed?.exception?.values?.length) {
    exceptions = (parsed.exception as SentryException).values.map(exception => ({
      type: exception.type,
      value: exception.value,
      stacktrace: exception.stacktrace?.frames?.map((frame: SentryExceptionFrame) => {
        const pre_context = frame?.pre_context && frame.pre_context.length > 0 ? frame.pre_context : undefined
        const post_context = frame?.post_context && frame.post_context.length > 0 ? frame.post_context : undefined
        return {
          function: frame.function,
          context_line: frame.context_line,
          pre_context,
          post_context,
        }
      }),
    }))
  }
  const event_data: ClickHouseEventForSentry['event_data'] = {
    _exceptions: exceptions.length > 0 ? exceptions : undefined,
    _contexts: parsed?.contexts,
    _request: parsed?.request ?? undefined,
    _tags,
    _env: parsed?.environment,
    _platform: parsed?.platform,
    ...restExtra,
  }

  const metadata: ClickHouseEventForSentry['metadata'] = {
    appVersion: release,
    sentryEventID: parsed?.event_id,
    platformName,
    ip,
  }

  const exceptionMessages = exceptions.map(
    exception => `${exception.type}: ${exception.value}`,
  )

  const event_type = `sentry-${exceptions.length > 0
    ? (exceptions.length > 1 ? 'exception-multi' : 'exception') : 'event'}`

  const log_message = [
    event_type,
    release,
    platformName,
    truncateString([message, ...exceptionMessages].filter(Boolean).join(' | ')),
  ].filter(Boolean).join(' | ')

  return {
    created_at: created_at || new Date(),
    log_level: exceptionMessages.length > 0 ? 'error' : (parsed?.level || 'info'),
    log_message,
    event_type,
    event_data: JSON.stringify(event_data),
    metadata: JSON.stringify(metadata),
    device_id,
  } as const
}

export type ClickHouseMappedEvent = ReturnType<typeof mapSentryEventToClickHouseEvent>

export async function queueEventToClickHouse(bodyParts: string[], env: Env, ip?: string) {
  const definition = safeJSONObjectParse<{ type: 'event' }>(bodyParts[1])
  if (definition?.type !== 'event') return
  const mapped = mapSentryEventToClickHouseEvent(bodyParts[2], ip)
  await env.TEXTS_SENTRY_QUEUE.send(mapped, {
    contentType: 'json',
  })
}

export async function batchInsertToClickHouse(values: ClickHouseMappedEvent[], env: Env) {
  const client = getClickhouseClient(env)
  if (!client) {
    console.warn('ClickHouse client is not available, skipping batch insert:', values)
    return
  }
  await client.insert({
    table: 'texts_events',
    values,
    clickhouse_settings: { date_time_input_format: 'best_effort' },
    format: 'JSONEachRow',
  })
}
