import { Queue, QueueOptions, Worker } from 'bullmq'
import { Cluster, Redis } from 'ioredis'
import background, { PsychicBackgroundOptions } from '../background'
import { cachePsychicWorkersApplication, getCachedPsychicWorkersApplicationOrFail } from './cache'
import { PsychicApplication } from '@rvohealth/psychic'

export default class PsychicApplicationWorkers {
  public static async init(
    psychicApp: PsychicApplication,
    cb: (app: PsychicApplicationWorkers) => void | Promise<void>,
  ) {
    const psychicWorkersApp = new PsychicApplicationWorkers(psychicApp)

    await cb(psychicWorkersApp)

    psychicApp.on('sync', () => {
      background.connect()

      const output = {
        workstreamNames: [...background['workstreamNames']],
        queueGroupMap: { ...background['groupNames'] },
      } as PsychicWorkersTypeSync

      return output
    })

    psychicApp.on('server:shutdown', async () => {
      await background.closeAllRedisConnections()
    })

    cachePsychicWorkersApplication(psychicWorkersApp)

    return psychicWorkersApp
  }

  /**
   * Returns the cached psychic application if it has been set.
   * If it has not been set, an exception is raised.
   *
   * The psychic application can be set by calling PsychicApplication#init
   */
  public static getOrFail() {
    return getCachedPsychicWorkersApplicationOrFail()
  }

  public psychicApp: PsychicApplication

  constructor(psychicApp: PsychicApplication) {
    this.psychicApp = psychicApp
  }

  /**
   * Returns the background options provided by the user
   */
  public get backgroundOptions() {
    return this._backgroundOptions
  }
  private _backgroundOptions: PsychicBackgroundOptions

  private _hooks: PsychicWorkersApplicationHooks = {
    workerShutdown: [],
  }
  public get hooks() {
    return this._hooks
  }

  public on<T extends PsychicWorkersHookEventType>(
    hookEventType: T,
    cb: T extends 'workers:shutdown' ? () => void | Promise<void> : never,
  ) {
    switch (hookEventType) {
      case 'workers:shutdown':
        this._hooks.workerShutdown.push(cb as () => void | Promise<void>)
        break

      default:
        throw new Error(`unrecognized event provided to PsychicWorkersApplication#on: ${hookEventType}`)
    }
  }

  public set<Opt extends PsychicWorkersApplicationOption>(option: Opt, value: unknown) {
    switch (option) {
      case 'background':
        this._backgroundOptions = {
          ...{
            providers: {
              Queue,
              Worker,
            },
          },

          ...(value as PsychicBackgroundOptions),
        }
        break

      default:
        throw new Error(`Unhandled option type passed to PsychicWorkersApplication#set: ${option}`)
    }
  }
}

export interface PsychicWorkersTypeSync {
  workstreamNames: string[]
  queueGroupMap: Record<string, string[]>
}

export type PsychicWorkersApplicationOption = 'background'

export type PsychicWorkersHookEventType = 'workers:shutdown'

export interface PsychicWorkersApplicationHooks {
  workerShutdown: (() => void | Promise<void>)[]
}

export interface BullMQNativeWorkerOptions extends WorkerOptions {
  group?: {
    id?: string
    maxSize?: number
    limit?: {
      max?: number
      duration?: number
    }
    concurrency?: number
    priority?: number
  }
  // https://docs.bullmq.io/guide/workers/concurrency
  concurrency?: number
  // the number of workers to create with this configuration
  workerCount?: number
}

export interface PsychicBackgroundNativeBullMQOptions extends PsychicBackgroundSharedOptions {
  /**
   * See https://docs.bullmq.io/guide/going-to-production for the different settings to use between
   * queue and worker connections.
   */
  defaultQueueConnection?: RedisOrRedisClusterConnection
  defaultWorkerConnection?: RedisOrRedisClusterConnection

  nativeBullMQ: {
    // QueueOptionsWithConnectionInstance instead of QueueOptions because we need to be able to
    // automatically wrap the queue name with {} on a cluster, and the best way to test if on
    // a redis cluster is when we have connection instances, not just connection configs
    defaultQueueOptions?: QueueOptionsWithConnectionInstance
    /**
     * named queues are useful for dispersing queues among nodes in a Redis cluster
     * and for running queues on different Redis instances
     */
    namedQueueOptions?: Record<string, QueueOptionsWithConnectionInstance>

    /**
     * Native BullMQ options to provide to configure the default workers
     * for psychic. By default, Psychic leverages a single-queue system, with
     * many workers running off the queue. Each worker receives the
     * same worker configuration, so this configuration is really
     * only used to supply the number of default workers that you want.
     */
    defaultWorkerOptions?: BullMQNativeWorkerOptions

    /**
     * The number of default workers to run against the default Psychic
     * background queues.
     *
     * By default, Psychic leverages a single-queue system, with
     * many workers running off a single queue. This number determines
     * the number of those default workers to provide.
     */
    defaultWorkerCount?: number

    /**
     * namedQueueWorkers are necessary to work off namedQueues
     * With BullMQ Pro, namedQueueWorkers can be rate limited (useful
     * for interacting with external APIs)
     */
    namedQueueWorkers?: Record<string, BullMQNativeWorkerOptions>
  }
}

interface PsychicBackgroundSharedOptions {
  /**
   * If using BullMQ, these can be omitted. However, if you are using
   * BullMQ Pro, you will need to provide the Queue and Worker
   * classes custom from them.
   */
  providers?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Queue: any

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Worker: any
  }

  defaultBullMQQueueOptions?: Omit<QueueOptions, 'connection'>
}

// QueueOptionsWithConnectionInstance instead of QueueOptions because we need to be able to
// automatically wrap the queue name with {} on a cluster, and the best way to test if on
// a redis cluster is when we have connection instances, not just connection configs
export type QueueOptionsWithConnectionInstance = Omit<QueueOptions, 'connection'> & {
  /**
   * See https://docs.bullmq.io/guide/going-to-production for the different settings to use between
   * queue and worker connections.
   */
  queueConnection?: RedisOrRedisClusterConnection
  workerConnection?: RedisOrRedisClusterConnection
}

export interface PsychicBackgroundSimpleOptions extends PsychicBackgroundSharedOptions {
  /**
   * See https://docs.bullmq.io/guide/going-to-production for the different settings to use between
   * queue and worker connections.
   */
  defaultQueueConnection: RedisOrRedisClusterConnection
  /**
   * defaultWorkerConnection is only optional when workers will not be activated (e.g. on the webserver)
   */
  defaultWorkerConnection?: RedisOrRedisClusterConnection

  /**
   * Every Psychic application that leverages simple background jobs will have a default
   * workstream. Set workerCount to set the number of workers that will work through the
   * default queue
   */
  defaultWorkstream?: {
    workerCount?: number
    // https://docs.bullmq.io/guide/workers/concurrency
    concurrency?: number
  }

  /**
   * When running background jobs on BullMQ, each named workstream corresponds
   * to a specific queue and workers created for a named workstream are given
   * a groupId corresponding to the workstream name
   *
   * named workstreams are useful for dispersing queues among nodes in a Redis cluster
   * and for running queues on different Redis instances
   *
   * With BullMQ Pro, named workstreams can be rate limited (useful
   * for interacting with external APIs)
   */
  namedWorkstreams?: PsychicBackgroundWorkstreamOptions[]

  /**
   * When transitioning from one instance of Redis to another, we can set up transitionalWorkstreams
   * so that jobs already added to the legacy Redis instance continue to be worked. Once all jobs
   * from the legacy Redis have been run, this configuration may be removed.
   */
  transitionalWorkstreams?: TransitionalPsychicBackgroundSimpleOptions
}

export interface PsychicBackgroundWorkstreamOptions {
  /**
   * This will be the name of the queue (and the group if using BullMQ Pro)
   */
  name: string

  /**
   * The number of workers you want to run on this configuration
   */
  workerCount?: number
  // https://docs.bullmq.io/guide/workers/concurrency
  concurrency?: number

  /**
   * See https://docs.bullmq.io/bullmq-pro/groups/rate-limiting for documentation
   * on rate limiting in BullMQ Pro (requires paid BullMQ Pro license)
   */
  rateLimit?: {
    max?: number
    duration?: number
  }

  /**
   * Optional redis connection. If not provided, the default background redis connection will be used.
   * See https://docs.bullmq.io/guide/going-to-production for the different settings to use between
   * queue and worker connections.
   */
  queueConnection?: RedisOrRedisClusterConnection
  workerConnection?: RedisOrRedisClusterConnection
}

export interface PsychicBackgroundWorkstreamOptions {
  /**
   * This will be the name of the queue (and the group if using BullMQ Pro)
   */
  name: string

  /**
   * The number of workers you want to run on this configuration
   */
  workerCount?: number
  // https://docs.bullmq.io/guide/workers/concurrency
  concurrency?: number

  /**
   * See https://docs.bullmq.io/bullmq-pro/groups/rate-limiting for documentation
   * on rate limiting in BullMQ Pro (requires paid BullMQ Pro license)
   */
  rateLimit?: {
    max?: number
    duration?: number
  }

  /**
   * Optional redis connection. If not provided, the default background redis connection will be used.
   * See https://docs.bullmq.io/guide/going-to-production for the different settings to use between
   * queue and worker connections.
   */
  queueConnection?: RedisOrRedisClusterConnection
  workerConnection?: RedisOrRedisClusterConnection
}

export type TransitionalPsychicBackgroundSimpleOptions = Omit<
  PsychicBackgroundSimpleOptions,
  'providers' | 'defaultBullMQQueueOptions' | 'transitionalWorkstreams'
>

export type RedisOrRedisClusterConnection = Redis | Cluster
