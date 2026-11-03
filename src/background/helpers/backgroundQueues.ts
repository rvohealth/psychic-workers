import { compact } from '@rvoh/dream/utils'
import type {
  PsychicBackgroundNativeBullMQOptions,
  PsychicBackgroundSimpleOptions,
  PsychicBackgroundWorkstreamOptions,
  QueueOptionsWithConnectionInstance,
  RedisOrRedisClusterConnection,
  TransitionalPsychicBackgroundSimpleOptions,
} from '../../psychic-app-workers/index.js'
import type { PsychicBackgroundOptions } from '../../types/background.js'

type Connection = RedisOrRedisClusterConnection | undefined
type SimpleLevel = PsychicBackgroundSimpleOptions | TransitionalPsychicBackgroundSimpleOptions

/**
 * @internal
 *
 * One queue `Background#connect` builds, with the connections it resolved to.
 * `level` is the options object the queue is configured in (the transitional
 * options for a transitional queue) and `own` the options of that one queue (the
 * named workstream, or `nativeBullMQ.defaultQueueOptions` / the named queue's
 * options in native mode; `undefined` for simple mode's default queue).
 */
export interface BackgroundQueue<Level, Own, QueueConnection extends Connection = Connection> {
  /** the configured name; `undefined` for the default queue */
  name: string | undefined
  transitional: boolean
  level: Level
  own: Own | undefined
  queueConnection: QueueConnection
  workerConnection: Connection
  /** the connections to close on shutdown: the resolved ones for the default queue, only the queue's own otherwise */
  ownConnections: RedisOrRedisClusterConnection[]
}

/**
 * @internal
 *
 * The one walk over the background options, in the order `Background#connect`
 * builds queues: the default queue, the named ones, then simple mode's
 * transitional default and named. It holds every rule for which connections a
 * queue uses (a named queue falls back to the default's; native
 * `defaultQueueOptions` beat the top-level defaults), so `connect()` and
 * `distinctQueueConnections` cannot disagree. A missing connection stays
 * `undefined`; deciding whether that is an error is the caller's.
 */
export default function backgroundQueues(
  backgroundOptions: PsychicBackgroundNativeBullMQOptions,
): BackgroundQueue<PsychicBackgroundNativeBullMQOptions, QueueOptionsWithConnectionInstance>[]
export default function backgroundQueues(
  backgroundOptions: PsychicBackgroundSimpleOptions,
): BackgroundQueue<SimpleLevel, PsychicBackgroundWorkstreamOptions, RedisOrRedisClusterConnection>[]
export default function backgroundQueues(
  backgroundOptions: PsychicBackgroundOptions | undefined,
): BackgroundQueue<unknown, unknown>[]
export default function backgroundQueues(backgroundOptions: PsychicBackgroundOptions | undefined) {
  if (!backgroundOptions) return []
  return (backgroundOptions as PsychicBackgroundNativeBullMQOptions).nativeBullMQ
    ? nativeQueues(backgroundOptions as PsychicBackgroundNativeBullMQOptions)
    : simpleQueues(backgroundOptions as PsychicBackgroundSimpleOptions)
}

/**
 * @internal
 *
 * The distinct queue connections (by object identity) the queues use: what the
 * Cluster wait waits on. Worker connections are deliberately left out. Tolerates
 * `undefined` options (a callback that never called `set('background')`).
 */
export function distinctQueueConnections(
  backgroundOptions: PsychicBackgroundOptions | undefined,
): RedisOrRedisClusterConnection[] {
  const connections = backgroundQueues(backgroundOptions).map(queue => queue.queueConnection)
  return [...new Set(connections)].filter(connection => connection !== undefined)
}

function simpleQueues(
  level: SimpleLevel,
  transitional = false,
): BackgroundQueue<SimpleLevel, PsychicBackgroundWorkstreamOptions, RedisOrRedisClusterConnection>[] {
  const { defaultQueueConnection, defaultWorkerConnection } = level
  const { transitionalWorkstreams } = level as PsychicBackgroundSimpleOptions

  return [
    {
      name: undefined,
      transitional,
      level,
      own: undefined,
      queueConnection: defaultQueueConnection,
      workerConnection: defaultWorkerConnection,
      ownConnections: compact([defaultQueueConnection, defaultWorkerConnection]),
    },
    ...(level.namedWorkstreams || []).map(namedWorkstream => ({
      name: namedWorkstream.name,
      transitional,
      level,
      own: namedWorkstream,
      queueConnection: namedWorkstream.queueConnection || defaultQueueConnection,
      workerConnection: namedWorkstream.workerConnection || defaultWorkerConnection,
      ownConnections: compact([namedWorkstream.queueConnection, namedWorkstream.workerConnection]),
    })),
    ...(transitionalWorkstreams ? simpleQueues(transitionalWorkstreams, true) : []),
  ]
}

function nativeQueues(
  level: PsychicBackgroundNativeBullMQOptions,
): BackgroundQueue<PsychicBackgroundNativeBullMQOptions, QueueOptionsWithConnectionInstance>[] {
  const { defaultQueueOptions, namedQueueOptions } = level.nativeBullMQ
  const defaultQueueConnection = defaultQueueOptions?.queueConnection || level.defaultQueueConnection
  const defaultWorkerConnection = defaultQueueOptions?.workerConnection || level.defaultWorkerConnection

  return [
    {
      name: undefined,
      transitional: false,
      level,
      own: defaultQueueOptions,
      queueConnection: defaultQueueConnection,
      workerConnection: defaultWorkerConnection,
      ownConnections: compact([defaultQueueConnection, defaultWorkerConnection]),
    },
    ...Object.entries(namedQueueOptions || {}).map(([name, own]) => ({
      name,
      transitional: false,
      level,
      own,
      queueConnection: own.queueConnection || defaultQueueConnection,
      workerConnection: own.workerConnection || defaultWorkerConnection,
      ownConnections: compact([own.queueConnection, own.workerConnection]),
    })),
  ]
}
