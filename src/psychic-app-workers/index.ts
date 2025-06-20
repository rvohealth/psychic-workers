import { PsychicApp } from '@rvoh/psychic'
import { Queue, QueueOptions, Worker, WorkerOptions } from 'bullmq'
import { Cluster, Redis } from 'ioredis'
import { cachePsychicWorkersApp, getCachedPsychicWorkersAppOrFail } from './cache.js'
import background from '../background/index.js'
import { PsychicBackgroundOptions } from '../types/background.js'

export default class PsychicAppWorkers {
  public static async init(psychicApp: PsychicApp, cb: (app: PsychicAppWorkers) => void | Promise<void>) {
    const psychicWorkersApp = new PsychicAppWorkers(psychicApp)

    await cb(psychicWorkersApp)

    psychicApp.on('cli:sync', () => {
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

    psychicApp.on('server:init:after-routes', () => {
      background.connect()
    })

    cachePsychicWorkersApp(psychicWorkersApp)

    return psychicWorkersApp
  }

  /**
   * Returns the cached psychic application if it has been set.
   * If it has not been set, an exception is raised.
   *
   * The psychic application can be set by calling PsychicApp#init
   */
  public static getOrFail() {
    return getCachedPsychicWorkersAppOrFail()
  }

  public psychicApp: PsychicApp

  constructor(psychicApp: PsychicApp) {
    this.psychicApp = psychicApp
  }

  /**
   * Returns the background options provided by the user
   */
  public get backgroundOptions() {
    return this._backgroundOptions
  }
  private _backgroundOptions: PsychicBackgroundOptions

  /**
   * Returns the testInvocation option provided by the user
   *
   * when "automatic", any backgrounded job will be immediately
   * invoked during tests. This is the default behavior
   *
   * when "manual", this will enable the dev to manually interact with
   * queues, enabling them to target jobs and run them at specific
   * code points.
   */
  public get testInvocation() {
    return this._testInvocation
  }
  private _testInvocation: PsychicWorkersAppTestInvocationType = 'automatic'

  private _hooks: PsychicWorkersAppHooks = {
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
        throw new Error(`unrecognized event provided to PsychicWorkersApp#on: ${hookEventType}`)
    }
  }

  public set<Opt extends PsychicWorkersAppOption>(
    option: Opt,
    value: Opt extends 'background'
      ? PsychicBackgroundOptions
      : Opt extends 'testInvocation'
        ? PsychicWorkersAppTestInvocationType
        : unknown,
  ) {
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

      case 'testInvocation':
        this._testInvocation = value as PsychicWorkersAppTestInvocationType
        break

      default:
        throw new Error(`Unhandled option type passed to PsychicWorkersApp#set: ${option}`)
    }
  }
}

export interface PsychicWorkersTypeSync {
  workstreamNames: string[]
  queueGroupMap: Record<string, string[]>
}

export type PsychicWorkersAppOption = 'background' | 'testInvocation'

export type PsychicWorkersAppTestInvocationType = 'automatic' | 'manual'

export type PsychicWorkersHookEventType = 'workers:shutdown'

export interface PsychicWorkersAppHooks {
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
  workerConnection?: RedisOrRedisClusterConnection | undefined
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
  defaultWorkerConnection: RedisOrRedisClusterConnection | undefined

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
