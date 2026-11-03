import type {
  PsychicBackgroundNativeBullMQOptions,
  PsychicBackgroundSimpleOptions,
  RedisOrRedisClusterConnection,
  TransitionalPsychicBackgroundSimpleOptions,
} from '../../psychic-app-workers/index.js'
import type { PsychicBackgroundOptions } from '../../types/background.js'
import {
  nativeDefaultQueueConnection,
  nativeNamedQueueConnection,
  simpleDefaultQueueConnection,
  simpleNamedWorkstreamQueueConnection,
} from './queueConnectionRules.js'

/**
 * @internal
 *
 * The distinct queue connections `Background#connect` would build a `Queue` on
 * for these options, deduped by object identity. It resolves each connection with
 * the same `queueConnectionRules` functions `Background#simpleConnect` and
 * `Background#nativeBullMQConnect` use, and reads the options directly because
 * `Background#redisConnections` is only filled by `connect()`. Simple mode's
 * `transitionalWorkstreams` bring their own connections.
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
  const defaultQueueConnection = simpleDefaultQueueConnection(backgroundOptions)
  if (defaultQueueConnection) connections.add(defaultQueueConnection)

  for (const namedWorkstream of backgroundOptions.namedWorkstreams || []) {
    const queueConnection = simpleNamedWorkstreamQueueConnection(namedWorkstream, defaultQueueConnection)
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
  const defaultQueueConnection = nativeDefaultQueueConnection(backgroundOptions)
  if (defaultQueueConnection) connections.add(defaultQueueConnection)

  for (const namedQueueOptions of Object.values(nativeBullMQ.namedQueueOptions || {})) {
    const queueConnection = nativeNamedQueueConnection(namedQueueOptions, defaultQueueConnection)
    if (queueConnection) connections.add(queueConnection)
  }
}
