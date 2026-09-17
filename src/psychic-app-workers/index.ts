import { PsychicApp } from '@rvoh/psychic'
import { Queue, QueueOptions, Worker, WorkerOptions } from 'bullmq'
import { Cluster, Redis } from 'ioredis'
import background from '../background/index.js'
import ASTWorkersSchemaBuilder from '../cli/ASTWorkersSchemaBuilder.js'
import PsychicTypesDeprecation from '../cli/PsychicTypesDeprecation.js'
import { PsychicBackgroundOptions } from '../types/background.js'
import { cachePsychicWorkersApp, getCachedPsychicWorkersAppOrFail } from './cache.js'

export default class PsychicAppWorkers {
  public static async init(psychicApp: PsychicApp, cb: (app: PsychicAppWorkers) => void | Promise<void>) {
    const psychicWorkersApp = new PsychicAppWorkers(psychicApp)

    await cb(psychicWorkersApp)

    psychicApp.on('cli:sync', async () => {
      await new ASTWorkersSchemaBuilder().build()
      await new PsychicTypesDeprecation().deprecate()
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

  /**
   * if set to true, it will bypass deprecation checks that run
   * during the sync hook. Defaults to false, we only recommend
   * overriding this if you are having issues with the deprecation
   * check.
   */
  public get bypassDeprecationChecks() {
    return this._bypassDeprecationChecks
  }
  private _bypassDeprecationChecks: boolean = false

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
        this._hooks.workerShutdown.push(cb)
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
        : Opt extends 'bypassDeprecationChecks'
          ? boolean
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

      case 'bypassDeprecationChecks':
        this._bypassDeprecationChecks = value as boolean
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

export type PsychicWorkersAppOption = 'background' | 'testInvocation' | 'bypassDeprecationChecks'

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
  /**
   * How many jobs each worker built from this configuration runs at once
   * (https://docs.bullmq.io/guide/workers/concurrency).
   *
   * Native BullMQ mode writes none, so BullMQ's default of **1** applies unless
   * this or `defaultBullMQWorkerOptions.concurrency` sets it. See
   * `PsychicBackgroundWorkstreamOptions.concurrency`.
   */
  concurrency?: number
  /**
   * the number of workers to create with this configuration, in this process.
   *
   * Read **only** for `nativeBullMQ.namedQueueWorkers`, where it defaults to 1
   * (a named queue with no entry in `namedQueueWorkers` gets no workers at
   * all). It is *not* read for `nativeBullMQ.defaultWorkerOptions`: the default
   * queue's worker count comes from `nativeBullMQ.defaultWorkerCount`. See
   * `PsychicBackgroundWorkstreamOptions.workerCount` for the
   * `workerCount × concurrency` product.
   */
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
     * Native BullMQ options for the default workers, spread over
     * `defaultBullMQWorkerOptions` — where `concurrency`, `limiter` and every
     * other BullMQ worker option for them comes from. A `workerCount` set here
     * is never read; the count comes from `defaultWorkerCount` below.
     */
    defaultWorkerOptions?: BullMQNativeWorkerOptions

    /**
     * The number of default workers to run in this process, and the only source
     * of that count in native mode. Defaults to 1, and takes effect only in a
     * process that activates workers. See
     * `PsychicBackgroundWorkstreamOptions.workerCount`.
     */
    defaultWorkerCount?: number

    /**
     * namedQueueWorkers are necessary to work off namedQueues.
     * A named queue's workers can be rate limited with BullMQ's `limiter`
     * option (https://docs.bullmq.io/guide/rate-limiting; useful for
     * interacting with external APIs) on open-source BullMQ and BullMQ Pro alike
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
  defaultBullMQWorkerOptions?: Omit<WorkerOptions, 'connection'>
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
   * The default workstream, whose queue carries every job not backgrounded to a
   * named workstream. Both fields mean exactly what they mean on a named
   * workstream — see `PsychicBackgroundWorkstreamOptions.workerCount` and
   * `.concurrency`.
   */
  defaultWorkstream?: {
    /** The number of workers working through the default queue, in this process. Defaults to 1. */
    workerCount?: number
    /**
     * How many jobs each default worker runs at once
     * (https://docs.bullmq.io/guide/workers/concurrency). Left unset, psychic
     * falls back to 10, as everywhere in simple mode. See
     * `PsychicBackgroundWorkstreamOptions.concurrency`.
     */
    concurrency?: number
  }

  /**
   * When running background jobs on BullMQ, each named workstream corresponds
   * to a specific queue, and jobs backgrounded to a named workstream are added
   * with a group id equal to the workstream name (a BullMQ Pro concept, ignored
   * by open-source BullMQ)
   *
   * named workstreams are useful for dispersing queues among nodes in a Redis cluster,
   * for running queues on different Redis instances, and for rate limiting, on
   * open-source BullMQ and BullMQ Pro alike (see
   * `PsychicBackgroundWorkstreamOptions.rateLimit`). A rate limit targets one external
   * limit, so give each rate-limited service its own named workstream — and where a
   * service meters its endpoints separately, one workstream per limit
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
   * The number of workers you want to run on this configuration, in **this
   * process**. Defaults to 1. These are BullMQ `Worker` objects sharing the
   * activating process's event loop, not forked processes, so raising this buys
   * concurrent waiting rather than concurrent CPU.
   *
   * `workerCount × concurrency` is the ceiling on this workstream's jobs in
   * flight in one process, and that product is what to size against a
   * downstream limit such as a connection pool or an external API's quota.
   */
  workerCount?: number
  /**
   * How many jobs each of this workstream's workers runs at once
   * (https://docs.bullmq.io/guide/workers/concurrency).
   *
   * **In simple mode this defaults to 10.** Psychic always writes a
   * `concurrency` onto a simple-mode worker, falling back to 10 when the
   * workstream does not set one — which also means it overrides any
   * `concurrency` placed in `defaultBullMQWorkerOptions`. Native BullMQ mode
   * writes none, so BullMQ's own default of 1 applies there. Moving a queue
   * between the two modes therefore changes how many jobs it runs at once by a
   * factor of ten, with nothing in either configuration saying so.
   *
   * See `workerCount` above for the `workerCount × concurrency` product.
   */
  concurrency?: number

  /**
   * Rate-limit this workstream: at most `max` jobs start in any `duration`
   * milliseconds. Works on open-source BullMQ and on BullMQ Pro.
   *
   * The limit is per queue, not per worker: every one of this workstream's
   * workers, in every process running it, shares one counter kept in Redis, so
   * `{ max: 1, duration: 1000 }` means one job per second for the workstream as
   * a whole. `concurrency` caps how many jobs each worker runs at once;
   * `rateLimit` caps how many may start per window across the whole workstream.
   * For this workstream's workers it takes precedence over a global
   * `defaultBullMQWorkerOptions.limiter`.
   *
   * A job on this workstream that is told to slow down (an HTTP 429, say) can
   * throw `RateLimitedPsychicJob` from `@rvoh/psychic-workers/errors` to pause
   * the whole workstream without burning a retry attempt; see that class for
   * the pause semantics and for the `maxStartedAttempts` bound.
   *
   * A debounced job on this workstream must carry a delay long enough that it
   * cannot enqueue faster than this limit starts jobs, or it is refused at
   * enqueue: see `DelayedJobOpts.jobId`.
   *
   * `max` and `duration` are both required positive integers (`duration` in
   * milliseconds): open-source BullMQ floors a fractional `duration` to 0ms
   * (rate limiting nothing) and fails every job fetch on one past Redis's
   * integer range. A `rateLimit` that reaches `connect()` without both fails
   * `connect()` naming the workstream and the field, before any queue or worker
   * is built.
   *
   * Implemented as BullMQ's worker `limiter` option, and on BullMQ Pro also as
   * the workstream group's rate limit (unverified against an installed Pro
   * build).
   */
  rateLimit?: {
    max: number
    duration: number
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
