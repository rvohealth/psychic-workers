import type {
  PsychicBackgroundNativeBullMQOptions,
  PsychicBackgroundSimpleOptions,
  PsychicBackgroundWorkstreamOptions,
  QueueOptionsWithConnectionInstance,
  RedisOrRedisClusterConnection,
  TransitionalPsychicBackgroundSimpleOptions,
} from '../../psychic-app-workers/index.js'

/**
 * @internal
 *
 * The single home of the rule "which connection does a queue use". Both
 * `Background#connect` (to build its `Queue`s) and `resolvedQueueConnections`
 * (to know which connections to wait on) call these, so the two can't drift.
 * Each returns `undefined` when no connection is configured; deciding whether
 * that is an error stays with the caller.
 *
 * Worker connections are not covered here.
 */

/**
 * simple mode: the default queue uses `defaultQueueConnection` (generic so that
 * a required `defaultQueueConnection` stays non-optional for the caller)
 */
export function simpleDefaultQueueConnection<
  Options extends Pick<
    PsychicBackgroundSimpleOptions | TransitionalPsychicBackgroundSimpleOptions,
    'defaultQueueConnection'
  >,
>(backgroundOptions: Options): Options['defaultQueueConnection'] {
  return backgroundOptions.defaultQueueConnection
}

/** simple mode: a named workstream uses its own `queueConnection`, else the default */
export function simpleNamedWorkstreamQueueConnection<
  DefaultConnection extends RedisOrRedisClusterConnection | undefined,
>(
  namedWorkstream: Pick<PsychicBackgroundWorkstreamOptions, 'queueConnection'>,
  defaultQueueConnection: DefaultConnection,
): RedisOrRedisClusterConnection | DefaultConnection {
  return namedWorkstream.queueConnection || defaultQueueConnection
}

/**
 * native mode: the default queue uses `nativeBullMQ.defaultQueueOptions.queueConnection`,
 * which wins over the top-level `defaultQueueConnection`
 */
export function nativeDefaultQueueConnection(
  backgroundOptions: Pick<PsychicBackgroundNativeBullMQOptions, 'defaultQueueConnection'> & {
    nativeBullMQ: Pick<PsychicBackgroundNativeBullMQOptions['nativeBullMQ'], 'defaultQueueOptions'>
  },
): RedisOrRedisClusterConnection | undefined {
  return (
    backgroundOptions.nativeBullMQ.defaultQueueOptions?.queueConnection ||
    backgroundOptions.defaultQueueConnection
  )
}

/** native mode: a named queue uses its own `queueConnection`, else the native default */
export function nativeNamedQueueConnection(
  namedQueueOptions: Pick<QueueOptionsWithConnectionInstance, 'queueConnection'>,
  defaultQueueConnection: RedisOrRedisClusterConnection | undefined,
): RedisOrRedisClusterConnection | undefined {
  return namedQueueOptions.queueConnection || defaultQueueConnection
}
