import { createClient } from '@clickhouse/client-web'
import { safeJSONObjectParse } from './utils'

type ClickHouseCredentials = {
  CLICKHOUSE_HOST: string
  CLICKHOUSE_USER: string
  CLICKHOUSE_PASSWORD: string
}

export const getClickhouseClient = ({ CLICKHOUSE_HOST, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD }: ClickHouseCredentials) => createClient({
  host: CLICKHOUSE_HOST,
  username: CLICKHOUSE_USER,
  password: CLICKHOUSE_PASSWORD,
  request_timeout: 60_000, // ms, defaults to 30_000
  max_open_connections: 10, // defaults to Infinity
})

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

export function mapSentryEventToClickHouseEvent(event: any, ip?: string) {
  const parsed = safeJSONObjectParse<any>(event)
  const message = parsed?.message as string
  const created_at = parsed?.timestamp ? new Date(parsed.timestamp * 1000) : undefined
  const tags = (parsed?.tags || {}) as Record<string, string>
  const { device_id, ..._tags } = tags
  const release = parsed?.release as string
  const extra = (parsed?.extra || {}) as Record<string, string>
  const { platformName, ...restExtra } = extra

  const event_data: ClickHouseEventForSentry['event_data'] = {
    _request: { ...(parsed?.request || {}) },
    _tags,
    ...restExtra,
  }

  const metadata: ClickHouseEventForSentry['metadata'] = {
    appVersion: release,
    sentryEventID: parsed?.event_id,
    platformName,
    ip,
  }

  return {
    created_at: created_at || new Date(),
    log_level: parsed?.level, // @TODO: check if this is a valid grafana log level
    log_message: ['sentry', release, platformName, message, `Device ID: ${device_id}`].filter(Boolean).join(' | '),
    event_type: 'sentry-event',
    event_data: JSON.stringify(event_data),
    metadata: JSON.stringify(metadata),
    device_id,
  } as const
}
