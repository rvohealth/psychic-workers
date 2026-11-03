import type {
  PsychicBackgroundNativeBullMQOptions,
  PsychicBackgroundSimpleOptions,
  RedisOrRedisClusterConnection,
  TransitionalPsychicBackgroundSimpleOptions,
} from '../../psychic-app-workers/index.js'
import type { PsychicBackgroundOptions } from '../../types/background.js'

/**
 * @internal
 *
 * The distinct queue connections `Background#connect` would build a `Queue` on
 * for these options, deduped by object identity. It mirrors the resolution in
 * `Background#simpleConnect` and `Background#nativeBullMQConnect` (a workstream
 * or named queue falls back to the default connection; native mode's
 * `defaultQueueOptions.queueConnection` wins over the top-level default; simple
 * mode's `transitionalWorkstreams` bring their own), but reads the options
 * directly because `Background#redisConnections` is only filled by `connect()`.
 * A spec ties this list to the connections `connect()` really builds queues on.
 *
 * Worker connections are deliberately not listed. Tolerates `undefined` options
 * (a callback that never called `set('background')`).
 */
export default function resolvedQueueConnections(
  backgroundOptions: PsychicBackgroundOptions | undefined,
): RedisOrRedisClusterConnection[] {
  const connections = new Set<RedisOrRedisClusterConnection>()
  if (!backgroundOptions) return []

  if ((backgroundOptions as PsychicBackgroundNativeBullMQOptions).nativeBullMQ) {
    addNativeConnections(backgroundOptions as PsychicBackgroundNativeBullMQOptions, connections)
  } else {
    addSimpleConnections(backgroundOptions as PsychicBackgroundSimpleOptions, connections)
  }

  return [...connections]
}

function addSimpleConnections(
  backgroundOptions: PsychicBackgroundSimpleOptions | TransitionalPsychicBackgroundSimpleOptions,
  connections: Set<RedisOrRedisClusterConnection>,
) {
  const defaultQueueConnection = backgroundOptions.defaultQueueConnection
  if (defaultQueueConnection) connections.add(defaultQueueConnection)

  for (const namedWorkstream of backgroundOptions.namedWorkstreams || []) {
    const queueConnection = namedWorkstream.queueConnection || defaultQueueConnection
    if (queueConnection) connections.add(queueConnection)
  }

  const transitionalWorkstreams = (backgroundOptions as PsychicBackgroundSimpleOptions)
    .transitionalWorkstreams
  if (transitionalWorkstreams) addSimpleConnections(transitionalWorkstreams, connections)
}

function addNativeConnections(
  backgroundOptions: PsychicBackgroundNativeBullMQOptions,
  connections: Set<RedisOrRedisClusterConnection>,
) {
  const nativeBullMQ = backgroundOptions.nativeBullMQ
  const defaultQueueConnection =
    nativeBullMQ.defaultQueueOptions?.queueConnection || backgroundOptions.defaultQueueConnection
  if (defaultQueueConnection) connections.add(defaultQueueConnection)

  for (const namedQueueOptions of Object.values(nativeBullMQ.namedQueueOptions || {})) {
    const queueConnection = namedQueueOptions.queueConnection || defaultQueueConnection
    if (queueConnection) connections.add(queueConnection)
  }
}
