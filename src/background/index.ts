import { Dream } from '@rvoh/dream'
import { closeAllDbConnections } from '@rvoh/dream/db'
import { compact, pascalize } from '@rvoh/dream/utils'
import { PsychicApp } from '@rvoh/psychic'
import {
  Job,
  JobSchedulerTemplateOptions,
  JobsOptions,
  Queue,
  QueueOptions,
  RateLimitError,
  Worker,
  WorkerOptions,
} from 'bullmq'
import ActivatingBackgroundWorkersWithoutDefaultWorkerConnection from '../error/background/ActivatingBackgroundWorkersWithoutDefaultWorkerConnection.js'
import ActivatingNamedQueueBackgroundWorkersWithoutWorkerConnection from '../error/background/ActivatingNamedQueueBackgroundWorkersWithoutWorkerConnection.js'
import DeduplicatedJobRequiresMinimumDelay from '../error/background/DeduplicatedJobRequiresMinimumDelay.js'
import DefaultBullMQNativeOptionsMissingQueueConnectionAndDefaultQueueConnection from '../error/background/DefaultBullMQNativeOptionsMissingQueueConnectionAndDefaultQueueConnection.js'
import NamedBullMQNativeOptionsMissingQueueConnectionAndDefaultQueueConnection from '../error/background/NamedBullMQNativeOptionsMissingQueueConnectionAndDefaultQueueConnection.js'
import NamedWorkstreamRateLimitMissingMaxOrDuration from '../error/background/NamedWorkstreamRateLimitMissingMaxOrDuration.js'
import NoClassForSpecifiedGlobalName from '../error/background/NoClassForSpecifiedGlobalName.js'
import NoQueueForSpecifiedQueueName from '../error/background/NoQueueForSpecifiedQueueName.js'
import NoQueueForSpecifiedWorkstream from '../error/background/NoQueueForSpecifiedWorkstream.js'
import RateLimitedPsychicJob from '../error/background/RateLimitedPsychicJob.js'
import RateLimitedPsychicJobThrownFromWorkerWithoutLimiter, {
  WorkerQueueDescription,
} from '../error/background/RateLimitedPsychicJobThrownFromWorkerWithoutLimiter.js'
import EnvInternal from '../helpers/EnvInternal.js'
import PsychicAppWorkers, {
  BullMQNativeWorkerOptions,
  PsychicBackgroundNativeBullMQOptions,
  PsychicBackgroundSimpleOptions,
  PsychicBackgroundWorkstreamOptions,
  QueueOptionsWithConnectionInstance,
  RedisOrRedisClusterConnection,
  TransitionalPsychicBackgroundSimpleOptions,
} from '../psychic-app-workers/index.js'

import AttemtedToBackgroundEntireDreamModel from '../error/background/AttemtedToBackgroundEntireDreamModel.js'
import DeduplicatedJobOutpacesRateLimit from '../error/background/DeduplicatedJobOutpacesRateLimit.js'
import {
  BackgroundJobConfig,
  BackgroundJobData,
  BackgroundQueuePriority,
  JobTypes,
  QueueBackgroundJobConfig,
  WorkstreamBackgroundJobConfig,
} from '../types/background.js'
import nameToRedisQueueName from './helpers/nameToRedisQueueName.js'

const DEFAULT_CONCURRENCY = 10

/**
 * the shortest delay a `jobId` (deduplication key) may be paired with.
 *
 * The floor is set by arithmetic against {@link DEDUPLICATION_KEY_MARGIN_MS},
 * not by how long a worker takes to pick a job up. BullMQ rearms the key for
 * its full `ttl` on every call that replaces the pending job (`SET ... PX` in
 * `deduplicateJob.lua`, on the `replace`/`extend` path this package uses), so
 * the key's life runs from the **last** call rather than the first. A burst is
 * therefore collapsed however long it lasts, and the only thing that can split
 * it is a single gap between consecutive calls longer than the key's life —
 * which is `delay - DEDUPLICATION_KEY_MARGIN_MS`. The floor is what that
 * subtraction is allowed to leave: at three seconds a burst tolerates a
 * two-second lull, twice the margin, so an ordinary round trip or pause inside
 * a burst cannot split it.
 *
 * Below about two seconds the subtraction stops leaving anything usable: at a
 * two-second delay the tolerated gap is 1000ms — the same scale as the margin
 * itself, which exists precisely to absorb noise at that scale — and at a delay
 * of one second it reaches the `Math.max(1, …)` clamp in `_addToQueue` and
 * silently degenerates to a 1ms key. Refusing below the floor is deliberate, in
 * preference to silently raising the delay or deduplicating nothing.
 *
 * Three consequences of the margin, all verified against BullMQ's Lua and
 * stated nowhere else:
 *
 * - The last `DEDUPLICATION_KEY_MARGIN_MS` of every window deduplicates
 *   nothing, because the key dies before the job fires. At the floor that dead
 *   band is a third of the window; at an hour it is 0.03%. A caller whose
 *   cadence lands inside the band degrades to no debounce at all, not to an
 *   occasional extra run. The margin is flat, so longer delays are strictly
 *   cheaper.
 * - Promoting or re-delaying a debounced job by hand (`job.promote()`,
 *   `job.changeDelay()`) moves the job out from under its key without touching
 *   the key, so later calls collapse into a job that is no longer pending and
 *   the run after the last call never happens. Follow either with
 *   `queue.removeDeduplicationKey(jobId)`.
 * - Collapsing only happens while the job is still in the delayed set. If
 *   promotion stalls — rate limited, paused, saturated, or no worker running —
 *   the key expires while the job sits there and every further call adds its
 *   own delayed job for the rest of the stall. Extra runs, not missing ones.
 *
 * The floor is a refusal, so it is cheap to lower and breaking to raise.
 */
const MINIMUM_DEDUPLICATION_DELAY_MS = 3000

/**
 * how far short of the delay the deduplication key's lifetime is set. The key's
 * expiry is armed from the Redis clock when the script lands, while the job's
 * fire time comes from the producer's clock, so a key with a lifetime equal to
 * the delay outlives its own job by one add round trip plus clock skew — and a
 * call landing in that gap is swallowed after the job has already run, which
 * breaks the debounce guarantee. That window is one round trip wide however
 * long the delay is, so the margin is flat rather than proportional.
 */
const DEDUPLICATION_KEY_MARGIN_MS = 1000

/**
 * @internal
 *
 * everything `connect` knows about one queue's workers at the moment it builds
 * that queue. `description` is nested rather than flattened because it is what
 * {@link RateLimitedPsychicJobThrownFromWorkerWithoutLimiter} is handed, and
 * the worker connection must not be able to ride into an error object.
 */
interface QueueWorkerRecord {
  /** how the queue was configured, as the misconfiguration message needs it */
  description: WorkerQueueDescription
  /** whether the workers built from `workerOptions` carry a BullMQ `limiter` */
  hasLimiter: boolean
  /** the very options object the workers are built from, minus the connection */
  workerOptions: Omit<WorkerOptions, 'connection'>
  /** the worker connection this queue's workers connect on, when one is configured */
  workerConnection: RedisOrRedisClusterConnection | undefined
  /**
   * how many workers this queue was configured for. Recorded as its own field
   * rather than read back off `workerOptions`, which does not always carry one.
   */
  workerCount: number
}

/**
 * the underlying class driving the `background` singleton,
 * available as an import from `psychic-workers`.
 */
export class Background {
  /**
   * returns the **logical** name of your app's default queue, built from your
   * app name (`MyAppBackgroundJobQueue`).
   *
   * This is never the name the queue has in Redis: `connect` rewrites it per
   * connection (brace-stripped, cluster hash-tagged, test-suffixed), and every
   * key BullMQ writes is namespaced by the rewritten name. Do not compose Redis
   * keys from this — read `queue.name` off `background.queues` instead.
   */
  public static get defaultQueueName() {
    const psychicWorkersApp = PsychicAppWorkers.getOrFail()
    return `${pascalize(psychicWorkersApp.psychicApp.appName)}BackgroundJobQueue`
  }

  /**
   * @internal
   *
   * returns the provided Worker class, or the Worker class from BullMQ
   * if no override was provided. This is providable because BullMQ also
   * offers a pro version, which requires you to provide custom classes.
   */
  public static get Worker(): typeof Worker {
    const psychicWorkersApp = PsychicAppWorkers.getOrFail()
    return (psychicWorkersApp.backgroundOptions.providers?.Worker || Worker) as typeof Worker
  }

  /**
   * @internal
   *
   * returns the provided Queue class, or the Queue class from BullMQ
   * if no override was provided. This is providable because BullMQ also
   * offers a pro version, which requires you to provide custom classes.
   */
  public static get Queue(): typeof Queue {
    const psychicWorkersApp = PsychicAppWorkers.getOrFail()
    return (psychicWorkersApp.backgroundOptions.providers?.Queue || Queue) as typeof Queue
  }

  /**
   * @internal
   *
   * Used when adding jobs to the default queue
   */
  private defaultQueue: Queue | null = null

  /**
   * @internal
   *
   * Used when adding jobs to the default transitional queue
   */
  private defaultTransitionalQueue: Queue | null = null

  /**
   * @internal
   *
   * Used when adding jobs to a named queue
   */
  private namedQueues: Record<string, Queue> = {}

  /**
   * @internal
   *
   * Used when adding grouped jobs
   */
  private groupNames: Record<string, string[]> = {}

  /**
   * @internal
   *
   * Used when adding workstreams
   */
  private workstreamNames: string[] = []

  /**
   * @internal
   *
   * Used when adding jobs to a named transitioanl queue
   */
  private namedTransitionalQueues: Record<string, Queue> = {}

  /**
   * @internal
   *
   * All of the workers that are currently registered
   */
  private _workers: Worker[] = []

  /**
   * @internal
   *
   * All of the redis connections that are currently registered
   */
  private redisConnections: RedisOrRedisClusterConnection[] = []

  /**
   * @internal
   *
   * For every queue built by `connect`: how it was configured, whether its
   * workers carry a BullMQ `limiter`, and what the workers are built from.
   * Written whether or not workers are activated here, so activation can happen
   * later without re-walking the configuration. Keyed by Queue identity rather
   * than name: a transitional workstream's queue has the same formatted name as
   * its current twin but its own configuration.
   */
  private queueWorkerRecords = new Map<Queue, QueueWorkerRecord>()

  /**
   * @internal
   *
   * set immediately before {@link buildRecordedWorkers} runs its build loop, so
   * that a second activation builds nothing
   */
  private workersActivated = false

  /**
   * Establishes connection to BullMQ via redis: builds the `Queue` objects for
   * the default and named workstreams and, only when `activateWorkers` is true,
   * the `Worker` objects that run jobs off them. Synchronous: it returns
   * nothing, so it is called without `await` even from async code.
   *
   * Connecting and activating are separate. `activateWorkers` defaults to
   * `false`, so connecting gets the producer side only. Queues are built once
   * per instance, but a later activation still builds workers, so a process that
   * connects first and calls `work()` afterwards gets its workers.
   *
   * You rarely call this yourself — Psychic connects on the
   * `server:init:after-routes` hook, on every enqueue path, in CLI codegen and
   * in the `WorkerTestUtils` helpers.
   */
  public connect({
    activateWorkers = false,
  }: {
    activateWorkers?: boolean
  } = {}) {
    if (!this.defaultQueue) {
      const psychicWorkersApp = PsychicAppWorkers.getOrFail()
      const defaultBullMQQueueOptions = psychicWorkersApp.backgroundOptions.defaultBullMQQueueOptions || {}

      if ((psychicWorkersApp.backgroundOptions as PsychicBackgroundNativeBullMQOptions).nativeBullMQ) {
        this.nativeBullMQConnect(
          defaultBullMQQueueOptions,
          psychicWorkersApp.backgroundOptions as PsychicBackgroundNativeBullMQOptions,
        )
      } else {
        this.simpleConnect(
          defaultBullMQQueueOptions,
          psychicWorkersApp.backgroundOptions as PsychicBackgroundSimpleOptions,
        )
      }
    }

    if (activateWorkers) this.buildRecordedWorkers()
  }

  /**
   * Returns all the queues in your application: the default queue, every named
   * queue, and their transitional twins when transitional workstreams are
   * configured.
   *
   * `connect` is what populates this, and before it has run the getter returns
   * an **empty array**, with no error and no warning — indistinguishable from
   * an application with nothing queued. Each `Queue` here carries the rewritten
   * Redis name rather than the name you configured.
   */
  public get queues(): Queue[] {
    return compact([
      this.defaultQueue,
      ...Object.values(this.namedQueues).map(queue => queue),
      this.defaultTransitionalQueue,
      ...Object.values(this.namedTransitionalQueues).map(queue => queue),
    ])
  }

  /**
   * Returns all the workers in your application: every BullMQ `Worker` this
   * process has built.
   *
   * Only a process that activated workers has any — `work()`, or a direct
   * `connect({ activateWorkers: true })`. Anywhere else the getter returns an
   * **empty array**, with no error and no warning, so a worker entrypoint that
   * attaches failure listeners by looping over it before `work()` runs attaches
   * nothing and logs nothing to say so.
   */
  public get workers() {
    return [...this._workers]
  }

  /**
   * @internal
   *
   * the maximum number of milliseconds graceful shutdown is allowed
   * to run before the process exits anyway, so that a hung hook,
   * db close, or worker close can never keep a dying process alive
   */
  public static readonly SHUTDOWN_TIMEOUT_MS = 15000

  /**
   * @internal
   *
   * set once a fatal error has begun graceful cleanup, so that a
   * second fatal error during cleanup exits immediately instead of
   * attempting cleanup again
   */
  private fatalErrorShutdownBegun = false

  private async shutdownAndExit() {
    let exitCode = 0

    try {
      await this.shutdownWithTimeout()
    } catch (error) {
      PsychicApp.logWithLevel('error', '[psychic-workers] error during graceful shutdown:', error)
      exitCode = 1
    }

    // https://docs.bullmq.io/guide/going-to-production#gracefully-shut-down-workers
    process.exit(exitCode)
  }

  /**
   * @internal
   *
   * after an uncaught exception or unhandled rejection, attempt
   * best-effort graceful cleanup (bounded by SHUTDOWN_TIMEOUT_MS),
   * then exit nonzero so orchestrators know to restart the process
   */
  private async shutdownAndExitAfterFatalError() {
    if (!this.fatalErrorShutdownBegun) {
      this.fatalErrorShutdownBegun = true

      try {
        await this.shutdownWithTimeout()
      } catch (error) {
        PsychicApp.logWithLevel(
          'error',
          '[psychic-workers] error during graceful shutdown after fatal error:',
          error,
        )
      }
    }

    process.exit(1)
  }

  /**
   * @internal
   *
   * runs {@link Background.shutdown}, rejecting if it has not settled
   * within SHUTDOWN_TIMEOUT_MS
   */
  private async shutdownWithTimeout() {
    await Promise.race([
      this.shutdown(),
      new Promise<never>((_, reject) => {
        setTimeout(
          () =>
            reject(
              new Error(
                `[psychic-workers] graceful shutdown timed out after ${Background.SHUTDOWN_TIMEOUT_MS}ms`,
              ),
            ),
          Background.SHUTDOWN_TIMEOUT_MS,
        ).unref()
      }),
    ])
  }

  /**
   * Shuts down workers, closes all redis connections
   */
  public async shutdown() {
    if (!EnvInternal.isTest) PsychicApp.log(`[psychic-workers] shutdown`)
    const psychicWorkersApp = PsychicAppWorkers.getOrFail()
    for (const hook of psychicWorkersApp.hooks.workerShutdown) {
      await hook()
    }

    await closeAllDbConnections()
    await this.closeAllRedisConnections()
  }

  /**
   * closes all redis connections for workers and queues
   */
  public async closeAllRedisConnections() {
    if (!EnvInternal.isTest) PsychicApp.log(`[psychic-workers] closeAllRedisConnections`)

    for (const worker of this.workers) {
      try {
        await worker.close()
      } catch (error) {
        if (!EnvInternal.isTest)
          PsychicApp.logWithLevel('error', `[psychic-workers] error closing worker:`, error)
      }
    }

    for (const connection of this.redisConnections) {
      try {
        await connection.quit()
      } catch (error) {
        if (!EnvInternal.isTest)
          PsychicApp.logWithLevel('error', `[psychic-workers] error quitting Redis:`, error)
      }
    }
  }

  /**
   * @internal
   *
   * connects to BullMQ using workstream-based arguments
   */
  private simpleConnect(
    defaultBullMQQueueOptions: Omit<QueueOptions, 'connection'>,
    backgroundOptions: PsychicBackgroundSimpleOptions | TransitionalPsychicBackgroundSimpleOptions,

    {
      activatingTransitionalWorkstreams = false,
    }: {
      activatingTransitionalWorkstreams?: boolean
    } = {},
  ) {
    // refused before any queue or worker of this connect exists, for the current and the
    // transitional workstreams alike (the transitional re-entry below has already been checked)
    if (!activatingTransitionalWorkstreams) {
      this.assertNamedWorkstreamRateLimits(backgroundOptions.namedWorkstreams, false)
      this.assertNamedWorkstreamRateLimits(
        (backgroundOptions as PsychicBackgroundSimpleOptions).transitionalWorkstreams?.namedWorkstreams,
        true,
      )
    }

    const defaultQueueConnection = backgroundOptions.defaultQueueConnection
    const defaultWorkerConnection = backgroundOptions.defaultWorkerConnection

    if (defaultQueueConnection) this.redisConnections.push(defaultQueueConnection)
    if (defaultWorkerConnection) this.redisConnections.push(defaultWorkerConnection)

    // transitional queues must have the same names they had prior to making them
    // transitional since the name is what identifies the queues and enables the
    // queues to be worked off
    const formattedQueueName = nameToRedisQueueName(Background.defaultQueueName, defaultQueueConnection)

    ///////////////////////////////
    // create default workstream //
    ///////////////////////////////

    const defaultQueue = new Background.Queue(formattedQueueName, {
      ...defaultBullMQQueueOptions,
      connection: defaultQueueConnection,
    })

    if (activatingTransitionalWorkstreams) {
      this.defaultTransitionalQueue = defaultQueue
    } else {
      this.defaultQueue = defaultQueue
    }
    ////////////////////////////////////
    // end: create default workstream //
    ////////////////////////////////////

    /////////////////////////////
    // create default workers //
    /////////////////////////////
    const defaultWorkerOptions = {
      autorun: !EnvInternal.isTest,
      ...backgroundOptions.defaultBullMQWorkerOptions,
      concurrency: backgroundOptions.defaultWorkstream?.concurrency || DEFAULT_CONCURRENCY,
    }

    this.recordQueueWorkers(
      defaultQueue,
      defaultWorkerOptions,
      defaultWorkerConnection,
      backgroundOptions.defaultWorkstream?.workerCount ?? 1,
      {
        mode: 'simple',
        isDefaultQueue: true,
        configuredName: Background.defaultQueueName,
        transitional: activatingTransitionalWorkstreams,
      },
    )
    /////////////////////////////////
    // end: create default workers //
    /////////////////////////////////

    //////////////////////////////
    // create named workstreams //
    //////////////////////////////
    const namedWorkstreams: PsychicBackgroundWorkstreamOptions[] = backgroundOptions.namedWorkstreams || []

    namedWorkstreams.forEach(namedWorkstream => {
      if (namedWorkstream.queueConnection) this.redisConnections.push(namedWorkstream.queueConnection)
      if (namedWorkstream.workerConnection) this.redisConnections.push(namedWorkstream.workerConnection)

      const namedWorkstreamQueueConnection = namedWorkstream.queueConnection || defaultQueueConnection
      const namedWorkstreamWorkerConnection = namedWorkstream.workerConnection || defaultWorkerConnection
      // transitional queues must have the same names they had prior to making them
      // transitional since the name is what identifies the queues and enables the
      // queues to be worked off
      const namedWorkstreamFormattedQueueName = nameToRedisQueueName(
        namedWorkstream.name,
        namedWorkstreamQueueConnection,
      )

      const namedQueue = new Background.Queue(namedWorkstreamFormattedQueueName, {
        ...defaultBullMQQueueOptions,
        connection: namedWorkstreamQueueConnection,
      })

      if (activatingTransitionalWorkstreams) {
        this.namedTransitionalQueues[namedWorkstream.name] = namedQueue
      } else {
        this.namedQueues[namedWorkstream.name] = namedQueue
        this.workstreamNames.push(namedWorkstream.name)
      }

      //////////////////////////
      // create named workers //
      //////////////////////////
      const namedWorkerOptions = {
        autorun: !EnvInternal.isTest,
        ...backgroundOptions.defaultBullMQWorkerOptions,
        // open-source BullMQ rate limiting (queue-wide, shared by every worker on this queue);
        // conditional spread so the key is absent when no rateLimit is configured
        ...(namedWorkstream.rateLimit ? { limiter: namedWorkstream.rateLimit } : {}),
        // BullMQ Pro option (ignored by open-source BullMQ); Psychic can't be aware of BullMQ Pro options
        group: {
          // Pro's worker `group` option is `{ limit, concurrency }` with no `id` (grouping
          // happens at job add, see `_addToQueue`); not verified against an installed Pro build
          id: namedWorkstream.name,
          limit: namedWorkstream.rateLimit,
        },
        concurrency: namedWorkstream.concurrency || DEFAULT_CONCURRENCY,
      }

      this.recordQueueWorkers(
        namedQueue,
        namedWorkerOptions,
        namedWorkstreamWorkerConnection,
        namedWorkstream.workerCount ?? 1,
        {
          mode: 'simple',
          isDefaultQueue: false,
          configuredName: namedWorkstream.name,
          transitional: activatingTransitionalWorkstreams,
        },
      )
      ///////////////////////////////
      // end: create named workers //
      ///////////////////////////////
    })
    ///////////////////////////////////
    // end: create named workstreams //
    ///////////////////////////////////

    const transitionalWorkstreams = (backgroundOptions as PsychicBackgroundSimpleOptions)
      .transitionalWorkstreams

    if (transitionalWorkstreams) {
      this.simpleConnect(defaultBullMQQueueOptions, transitionalWorkstreams, {
        activatingTransitionalWorkstreams: true,
      })
    }
  }

  /**
   * @internal
   *
   * connects to BullMQ using native BullMQ arguments
   */
  private nativeBullMQConnect(
    defaultBullMQQueueOptions: Omit<QueueOptions, 'connection'>,
    backgroundOptions: PsychicBackgroundNativeBullMQOptions,
  ) {
    const nativeBullMQ = backgroundOptions.nativeBullMQ
    const defaultQueueConnection =
      nativeBullMQ.defaultQueueOptions?.queueConnection || backgroundOptions.defaultQueueConnection
    const defaultWorkerConnection =
      nativeBullMQ.defaultQueueOptions?.workerConnection || backgroundOptions.defaultWorkerConnection

    if (defaultQueueConnection) this.redisConnections.push(defaultQueueConnection)
    if (defaultWorkerConnection) this.redisConnections.push(defaultWorkerConnection)

    if (!defaultQueueConnection)
      throw new DefaultBullMQNativeOptionsMissingQueueConnectionAndDefaultQueueConnection()

    const formattedQueueName = nameToRedisQueueName(Background.defaultQueueName, defaultQueueConnection)

    //////////////////////////
    // create default queue //
    //////////////////////////
    const defaultQueue = new Background.Queue(formattedQueueName, {
      ...defaultBullMQQueueOptions,
      ...nativeBullMQ.defaultQueueOptions,
      connection: defaultQueueConnection,
    })
    this.defaultQueue = defaultQueue
    ///////////////////////////////
    // end: create default queue //
    ///////////////////////////////

    /////////////////////////////
    // create default workers //
    /////////////////////////////
    const defaultWorkerOptions = {
      autorun: !EnvInternal.isTest,
      ...backgroundOptions.defaultBullMQWorkerOptions,
      ...backgroundOptions.nativeBullMQ.defaultWorkerOptions,
    }

    this.recordQueueWorkers(
      defaultQueue,
      defaultWorkerOptions,
      defaultWorkerConnection,
      nativeBullMQ.defaultWorkerCount ?? 1,
      {
        mode: 'native',
        isDefaultQueue: true,
        configuredName: Background.defaultQueueName,
        transitional: false,
      },
    )
    /////////////////////////////////
    // end: create default workers //
    /////////////////////////////////

    /////////////////////////
    // create named queues //
    /////////////////////////
    const namedQueueOptionsMap: Record<string, QueueOptionsWithConnectionInstance> =
      nativeBullMQ.namedQueueOptions || {}

    Object.keys(namedQueueOptionsMap).forEach(queueName => {
      const namedQueueOptions: QueueOptionsWithConnectionInstance = namedQueueOptionsMap[queueName]!

      if (namedQueueOptions.queueConnection) this.redisConnections.push(namedQueueOptions.queueConnection)
      if (namedQueueOptions.workerConnection) this.redisConnections.push(namedQueueOptions.workerConnection)

      const namedQueueConnection = namedQueueOptions.queueConnection || defaultQueueConnection
      const namedWorkerConnection = namedQueueOptions.workerConnection || defaultWorkerConnection

      if (!namedQueueConnection)
        throw new NamedBullMQNativeOptionsMissingQueueConnectionAndDefaultQueueConnection(queueName)

      const formattedQueuename = nameToRedisQueueName(queueName, namedQueueConnection)

      const namedQueue = new Background.Queue(formattedQueuename, {
        ...defaultBullMQQueueOptions,
        ...namedQueueOptions,
        connection: namedQueueConnection,
      })
      this.namedQueues[queueName] = namedQueue

      //////////////////////////
      // create extra workers //
      //////////////////////////
      const extraWorkerOptionsMap: Record<string, BullMQNativeWorkerOptions> =
        nativeBullMQ.namedQueueWorkers || {}
      const extraWorkerOptions: BullMQNativeWorkerOptions | undefined = extraWorkerOptionsMap[queueName]
      const extraWorkerCount = extraWorkerOptions ? (extraWorkerOptions.workerCount ?? 1) : 0

      this.groupNames[queueName] ||= []
      if (extraWorkerOptions?.group?.id) this.groupNames[queueName].push(extraWorkerOptions.group.id)

      const namedWorkerOptions = {
        autorun: !EnvInternal.isTest,
        ...backgroundOptions.defaultBullMQWorkerOptions,
        ...extraWorkerOptions,
      }

      this.recordQueueWorkers(namedQueue, namedWorkerOptions, namedWorkerConnection, extraWorkerCount, {
        mode: 'native',
        isDefaultQueue: false,
        configuredName: queueName,
        transitional: false,
      })
      ///////////////////////////////
      // end: create extra workers //
      ///////////////////////////////
    })
    //////////////////////////////
    // end: create named queues //
    //////////////////////////////
  }

  /**
   * @internal
   *
   * the sole writer of {@link queueWorkerRecords}. `workerOptions` is the very
   * object the workers are built from (minus the connection), so the record and
   * the workers cannot disagree.
   */
  private recordQueueWorkers(
    queue: Queue,
    workerOptions: Omit<WorkerOptions, 'connection'>,
    workerConnection: RedisOrRedisClusterConnection | undefined,
    workerCount: number,
    description: WorkerQueueDescription,
  ) {
    this.queueWorkerRecords.set(queue, {
      description,
      hasLimiter: Boolean(workerOptions.limiter),
      workerOptions,
      workerConnection,
      workerCount,
    })
  }

  /**
   * @internal
   *
   * builds every worker `connect` recorded a queue for, in the order the queues
   * were built, so the default missing-connection throw still pre-empts the
   * named one. The activation flag is set before the loop, not after it, because
   * `_workers` is append-only and a build that throws partway must not be
   * retryable into a second copy of the workers it already constructed.
   */
  private buildRecordedWorkers() {
    if (this.workersActivated) return
    this.workersActivated = true

    for (const [queue, record] of this.queueWorkerRecords) {
      if (!record.workerConnection) {
        if (record.description.isDefaultQueue)
          throw new ActivatingBackgroundWorkersWithoutDefaultWorkerConnection()
        throw new ActivatingNamedQueueBackgroundWorkersWithoutWorkerConnection(
          record.description.configuredName,
        )
      }

      for (let i = 0; i < record.workerCount; i++) {
        this._workers.push(
          new Background.Worker(queue.name, this.processorFor(queue), {
            ...record.workerOptions,
            connection: record.workerConnection,
          }),
        )
      }
    }
  }

  /**
   * @internal
   *
   * throws {@link NamedWorkstreamRateLimitMissingMaxOrDuration} for the first
   * workstream whose `rateLimit` lacks a positive integer `max` or `duration`.
   * The type requires both but admits any number, and open-source BullMQ does
   * not validate a `limiter`: a fractional `duration` floors to 0ms and rate
   * limits nothing, and one past Redis's integer range fails every job fetch.
   */
  private assertNamedWorkstreamRateLimits(
    namedWorkstreams: PsychicBackgroundWorkstreamOptions[] | undefined,
    transitional: boolean,
  ) {
    for (const { name, rateLimit } of namedWorkstreams ?? []) {
      if (!rateLimit) continue

      for (const field of ['max', 'duration'] as const) {
        const value: unknown = rateLimit[field]
        if (!(typeof value === 'number' && Number.isSafeInteger(value) && value > 0))
          throw new NamedWorkstreamRateLimitMissingMaxOrDuration(name, transitional, field, value)
      }
    }
  }

  /**
   * @internal
   *
   * when `err` is a {@link RateLimitedPsychicJob} thrown on a queue whose workers
   * carry no BullMQ `limiter`, returns the misconfiguration error to fail the job
   * with instead; otherwise undefined. Declared as `Error` so the concrete,
   * unexported class stays out of the emitted declarations. Four callers, one
   * across a module boundary in `WorkerTestUtils`.
   */
  public misconfiguredRateLimitSignal(err: unknown, queue: Queue): Error | undefined {
    if (!(err instanceof RateLimitedPsychicJob)) return

    const record = this.queueWorkerRecords.get(queue)
    if (!record || record.hasLimiter) return

    return new RateLimitedPsychicJobThrownFromWorkerWithoutLimiter(err, record.description)
  }

  /**
   * @internal
   *
   * the processor every worker on `queue` runs: {@link doWork}, with a
   * {@link RateLimitedPsychicJob} translated into BullMQ's own rate-limit
   * signal — the queue's limiter key is set, pausing every worker on the queue,
   * then `RateLimitError` moves the job back without counting an attempt or
   * emitting `failed`. Thrown where the workers carry no `limiter`, it is
   * instead a misconfiguration: see {@link misconfiguredRateLimitSignal}.
   */
  private processorFor(queue: Queue) {
    return async (job: Job) => {
      try {
        await this.doWork(job)
      } catch (err) {
        const misconfigured = this.misconfiguredRateLimitSignal(err, queue)
        if (misconfigured) throw misconfigured

        if (err instanceof RateLimitedPsychicJob) {
          // a fractional number of seconds rounds up: the field is a lower bound on the pause
          const pauseForSeconds = Math.ceil(err.pauseQueueForSeconds)

          // short of PTTL on the limiter key, nothing else shows that this queue is stalled
          PsychicApp.logWithLevel(
            'warn',
            `[psychic-workers] pausing queue ${queue.name} for ${pauseForSeconds}s: a job threw RateLimitedPsychicJob`,
          )
          await queue.rateLimit(pauseForSeconds * 1000)
          throw new RateLimitError()
        }

        throw err
      }
    }
  }

  /**
   * starts background workers: connects if this process has not connected yet,
   * then builds the `Worker` objects for every queue `connect` recorded, and
   * installs the process-level fatal-error and signal handlers that shut them
   * down. An earlier producer-only `connect()` no longer leaves `work()` with
   * nothing to do. A process with no `defaultWorkerConnection` configured throws
   * here rather than returning quietly.
   */
  public work() {
    process.on('uncaughtException', (error: Error) => {
      PsychicApp.logWithLevel('error', '[psychic-workers] uncaughtException:', error)
      void this.shutdownAndExitAfterFatalError()
    })

    process.on('unhandledRejection', (reason: unknown) => {
      PsychicApp.logWithLevel('error', '[psychic-workers] unhandledRejection:', reason)
      void this.shutdownAndExitAfterFatalError()
    })

    process.on('SIGTERM', () => {
      if (!EnvInternal.isTest) PsychicApp.log('[psychic-workers] handle SIGTERM')

      void this.shutdownAndExit()
    })

    process.on('SIGINT', () => {
      if (!EnvInternal.isTest) PsychicApp.log('[psychic-workers] handle SIGINT')

      void this.shutdownAndExit()
    })

    this.connect({ activateWorkers: true })
  }

  /**
   * adds the static method of a provided class to BullMQ
   *
   * @param ObjectClass - the class you wish to background
   * @param method - the method you wish to background
   * @param globalName - the globalName of the class you are processing
   * @param args - (optional) a list of arguments to provide to your method when it is called
   * @param delaySeconds - (optional) the number of seconds you wish to wait before allowing this job to process
   * @param importKey - (optional) the import key for the class
   * @param jobConfig - (optional) the background job config to use when backgrounding this method
   */
  public async staticMethod(
    ObjectClass: Record<'name', string>,
    method: string,
    {
      globalName,
      delaySeconds,
      jobId,
      args = [],
      jobConfig = {},
    }: {
      globalName: string
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args?: any[]
      filepath?: string
      delaySeconds?: number
      jobId?: string | undefined
      importKey?: string
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jobConfig?: BackgroundJobConfig<any>
    },
  ) {
    this.connect()

    await this._addToQueue(
      `BackgroundJobQueueStaticJob`,
      {
        globalName,
        method,
        args,
      },
      {
        delaySeconds,
        jobId,
        jobConfig,
        groupId: this.jobConfigToGroupId(jobConfig),
        priority: this.jobConfigToPriority(jobConfig),
      },
    )
  }

  /**
   * adds the static method of a provided class to BullMQ,
   * to be scheduled to run at a specified cron pattern
   *
   * @param ObjectClass - the class you wish to background
   * @param pattern - the cron string you wish to use to govern the scheduling for this job
   * @param method - the method you wish to background
   * @param globalName - the globalName of the class you are processing
   * @param args - (optional) a list of arguments to provide to your method when it is called
   * @param importKey - (optional) the import key for the class
   * @param jobConfig - (optional) the background job config to use when backgrounding this method
   */
  public async scheduledMethod(
    ObjectClass: Record<'name', string>,
    pattern: string,
    method: string,
    {
      globalName,
      args = [],
      jobConfig = {},
      scheduleOpts = {},
    }: {
      globalName: string
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args?: any[]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jobConfig?: BackgroundJobConfig<any>
      scheduleOpts?: JobSchedulerTemplateOptions
    },
  ) {
    this.connect()

    const schedulerId = this.jobSchedulerId(globalName, method)
    const queueInstance = this.queueInstance(jobConfig)
    if (!queueInstance) throw new Error(`Missing queue for: ${jobConfig.queue?.toString()}`)

    await queueInstance.upsertJobScheduler(
      schedulerId,
      { pattern },
      {
        name: 'BackgroundJobQueueStaticJob',

        // the priority from the service's `backgroundJobConfig`, written where open-source
        // BullMQ reads it. Without it BullMQ enqueues every cron run at no priority at all,
        // into the `wait` list, which it drains before it looks at the prioritized set — so
        // a priority-less cron job is fetched ahead of every prioritized job on its queue.
        opts: {
          ...scheduleOpts,
          priority:
            scheduleOpts.priority ??
            this.mapPriorityWordToPriorityNumber(this.jobConfigToPriority(jobConfig)),
        },

        data: {
          globalName,
          method,
          args,
        },
      },
    )
  }

  /**
   * @internal
   *
   * Returns the id a scheduled job is registered with BullMQ under.
   *
   * `jobId` is used to determine uniqueness along with name and repeat pattern.
   * Since the name is really a job type and never changes, the `jobId` is the only
   * way to allow multiple jobs with the same cron repeat pattern. Uniqueness is
   * enforced by combining the global name and the method name.
   *
   * See: https://docs.bullmq.io/guide/jobs/repeatable
   *
   * @param globalName - the globalName of the class the method belongs to
   * @param method - the name of the scheduled method
   */
  public jobSchedulerId(globalName: string, method: string) {
    return `${globalName}:${method}`
  }

  /**
   * removes a scheduled job from BullMQ, preventing it from being run again
   *
   * Every queue is checked, rather than the one the job's current
   * `backgroundJobConfig` routes to, so that a job can still be unscheduled
   * after its workstream has changed, or after the class that scheduled it has
   * been deleted.
   *
   * @param jobSchedulerId - the id the job was scheduled under
   * @returns true if a scheduled job was removed, false if none was found
   */
  public async unschedule(jobSchedulerId: string): Promise<boolean> {
    this.connect()

    const removed = await Promise.all(this.queues.map(queue => queue.removeJobScheduler(jobSchedulerId)))

    return removed.some(Boolean)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private queueInstance(values: BackgroundJobConfig<any>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const workstreamConfig = values as WorkstreamBackgroundJobConfig<any>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queueConfig = values as QueueBackgroundJobConfig<any>
    const queueInstance: Queue | undefined =
      typeof workstreamConfig.workstream === 'string'
        ? this.namedQueues[workstreamConfig.workstream]
        : typeof queueConfig.queue === 'string'
          ? this.namedQueues[queueConfig.queue]
          : this.defaultQueue!

    if (!queueInstance) {
      if (typeof workstreamConfig.workstream === 'string')
        throw new NoQueueForSpecifiedWorkstream(workstreamConfig.workstream)
      if (typeof queueConfig.queue === 'string') throw new NoQueueForSpecifiedQueueName(queueConfig.queue)
    }

    return queueInstance
  }

  /**
   * adds the instance method of a provided dream model to BullMQ
   *
   * @param modelInstance - the dream model instance you wish to background
   * @param method - the method you wish to background
   * @param globalName - the globalName of the class you are processing
   * @param args - (optional) a list of arguments to provide to your method when it is called
   * @param importKey - (optional) the import key for the class
   * @param jobConfig - (optional) the background job config to use when backgrounding this method
   */
  public async modelInstanceMethod(
    modelInstance: Dream,
    method: string,
    {
      delaySeconds,
      jobId,
      args = [],
      jobConfig = {},
    }: {
      delaySeconds?: number
      jobId?: string | undefined
      importKey?: string
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args?: any[]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jobConfig?: BackgroundJobConfig<any>
    },
  ) {
    this.connect()

    await this._addToQueue(
      'BackgroundJobQueueModelInstanceJob',
      {
        id: modelInstance.primaryKeyValue() as string | number,
        globalName: (modelInstance.constructor as typeof Dream).globalName,
        method,
        args,
      },
      {
        delaySeconds,
        jobId,
        jobConfig,
        groupId: this.jobConfigToGroupId(jobConfig),
        priority: this.jobConfigToPriority(jobConfig),
      },
    )
  }

  // should be private, but public so we can test
  public async _addToQueue(
    jobType: JobTypes,
    jobData: BackgroundJobData,
    {
      delaySeconds,
      jobId,
      jobConfig,
      priority,
      groupId,
    }: {
      delaySeconds?: number | undefined
      jobId?: string | undefined
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jobConfig: BackgroundJobConfig<any>
      priority: BackgroundQueuePriority
      groupId?: string | undefined
    },
  ) {
    ;(jobData.args as unknown[]).forEach(arg => {
      if (arg instanceof Dream) throw new AttemtedToBackgroundEntireDreamModel(jobData.method, arg)
    })

    // set this variable out side of the conditional so that
    // mismatches will raise exceptions even in tests
    const queueInstance = this.queueInstance(jobConfig)

    // reads the raw `delaySeconds`, before the truthiness coercion below collapses
    // 0, -0 and NaN into `undefined`, and runs outside the test short-circuit so
    // that mismatches raise even in tests.
    if (jobId !== undefined) {
      const requestedDelay = (delaySeconds ?? NaN) * 1000

      // an empty string is a `jobId` given rather than omitted, and the
      // deduplication block below would read it as falsy and enqueue an ordinary
      // delayed job with no key and no signal.
      if (
        jobId === '' ||
        !Number.isFinite(requestedDelay) ||
        Math.abs(requestedDelay) > Number.MAX_SAFE_INTEGER ||
        requestedDelay < MINIMUM_DEDUPLICATION_DELAY_MS
      )
        throw new DeduplicatedJobRequiresMinimumDelay(jobId, delaySeconds, MINIMUM_DEDUPLICATION_DELAY_MS)

      // a legal delay can still be too short for the queue it lands on: the key
      // lifetime is the fastest this `jobId` can produce jobs, and a limiter bounds
      // how fast the queue can start them. Compared against the key lifetime rather
      // than the delay, so a burst that would have been fine is refused too.
      const record = queueInstance ? this.queueWorkerRecords.get(queueInstance) : undefined
      const limiter = record?.workerOptions.limiter

      // `connect` validates `max` and `duration` for named workstreams only, so
      // a global or native-mode limiter can be anything the type admits; a
      // cadence derived from one of those is not worth refusing a job over
      if (record && limiter && limiter.max > 0 && limiter.duration > 0 && Number.isFinite(limiter.duration)) {
        const keyLifetime = requestedDelay - DEDUPLICATION_KEY_MARGIN_MS

        if (keyLifetime < limiter.duration / limiter.max)
          throw new DeduplicatedJobOutpacesRateLimit(
            jobId,
            requestedDelay,
            keyLifetime,
            limiter,
            record.description,
          )
      }
    }

    // if delaySeconds is 0, we will intentionally treat
    // this as `undefined`
    const delay = delaySeconds ? delaySeconds * 1000 : undefined

    const workersApp = PsychicAppWorkers.getOrFail()

    // in test environments, this block will short-circuit adding to the queue,
    // causing the job to immediately invoke instead. This behavior can be bypassed
    // by setting `testInvocation=manual` in the workers config.
    if (EnvInternal.isTest && workersApp.testInvocation === 'automatic') {
      const queue = new Background.Queue('TestQueue', { connection: {} })
      const job = new Job(queue, jobType, jobData, {})

      try {
        await this.doWork(job)
      } catch (err) {
        // the job's real queue (not the throwaway TestQueue) decides whether a
        // RateLimitedPsychicJob is a usable signal or a misconfiguration, exactly
        // as the worker would in production
        throw (queueInstance && this.misconfiguredRateLimitSignal(err, queueInstance)) || err
      }

      return
      //
    }

    if (!queueInstance) throw new Error(`missing queue: ${jobConfig?.queue?.toString() || 'N/A'}`)

    const jobOptions: Partial<JobsOptions> = {}

    if (delay) jobOptions.delay = delay

    if (delay && jobId) {
      jobOptions.deduplication = {
        id: jobId,
        // deliberately shorter than the delay: see DEDUPLICATION_KEY_MARGIN_MS.
        // `Math.floor` is live — Redis `SET ... PX` rejects a fractional
        // argument, and `{ seconds: 3.0005 }` is fractional. `Math.max(1, …)`
        // cannot fire at the current floor, but a `ttl <= 0` fails
        // `deduplicateJob.lua:32` and sets the deduplication key with no expiry
        // at all, so anyone lowering the floor should revisit this line first.
        ttl: Math.max(1, Math.floor(delay - DEDUPLICATION_KEY_MARGIN_MS)),
        extend: true,
        replace: true,
      }
    }

    const priorityNumber = this.mapPriorityWordToPriorityNumber(priority)

    const groupConfig = this.groupIdToGroupConfig(groupId)

    // BullMQ Pro group priority, ignored by open-source BullMQ, which orders this job's
    // group against the queue's other groups alongside (not instead of) the job priority
    // below — unverified against an installed Pro build. Open-source `JobsOptions` does
    // not declare `group`, so without this annotation TypeScript checks nothing about the
    // key or its body at the `add` call: spread properties escape excess-property checking.
    const proGroupOption: { group: { id: string; priority: number } } | Record<string, never> = groupConfig
      ? { group: { ...groupConfig, priority: priorityNumber } }
      : {}

    await queueInstance.add(jobType, jobData, {
      ...jobOptions,

      // open-source BullMQ's job priority, and the only priority it reads. Written on
      // every job, grouped or not: without Pro the `group` key spread in below is stored
      // but never scheduled on, so a priority living only inside it would do nothing —
      // and every named workstream job carries a group id (see `jobConfigToGroupId`).
      priority: priorityNumber,

      ...proGroupOption,
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private jobConfigToPriority(jobConfig?: BackgroundJobConfig<any>): BackgroundQueuePriority {
    if (!jobConfig) return 'default'
    return jobConfig.priority || 'default'
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private jobConfigToGroupId(jobConfig?: BackgroundJobConfig<any>): string | undefined {
    if (!jobConfig) return

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const workstreamConfig = jobConfig as WorkstreamBackgroundJobConfig<any>
    if (typeof workstreamConfig.workstream === 'string') return workstreamConfig.workstream

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queueConfig = jobConfig as QueueBackgroundJobConfig<any>
    if (typeof queueConfig.groupId === 'string') return queueConfig.groupId

    return
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private jobConfigToGroup(jobConfig?: BackgroundJobConfig<any>): { id: string } | undefined {
    return this.groupIdToGroupConfig(this.jobConfigToGroupId(jobConfig))
  }

  private groupIdToGroupConfig(groupId: string | undefined): { id: string } | undefined {
    if (!groupId) return
    return { id: groupId }
  }

  // a priority is only honoured while the job is fetched from the prioritized set. BullMQ
  // returns a recovered stalled job to `wait`, which a worker drains ahead of the
  // prioritized set, so a job that stalls is re-run ahead of higher-priority work.
  private mapPriorityWordToPriorityNumber(priority: BackgroundQueuePriority) {
    switch (priority) {
      case 'urgent':
        return 1
      case 'default':
        return 2
      case 'not_urgent':
        return 3
      case 'last':
        return 4
      default:
        return 2
    }
  }

  public async doWork(job: Job) {
    const jobType = job.name as JobTypes
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { id, method, args, globalName } = job.data as BackgroundJobData
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let objectClass: any
    let dreamClass: typeof Dream | undefined

    switch (jobType) {
      case 'BackgroundJobQueueStaticJob':
        if (globalName) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          objectClass = PsychicApp.lookupClassByGlobalName(globalName)
        }

        if (!objectClass) throw new NoClassForSpecifiedGlobalName(globalName)

        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        await objectClass[method!](...args, job)
        break

      case 'BackgroundJobQueueModelInstanceJob': {
        if (globalName) {
          dreamClass = PsychicApp.lookupClassByGlobalName(globalName) as typeof Dream | undefined
        }

        if (!dreamClass) throw new NoClassForSpecifiedGlobalName(globalName)

        const modelInstance = await dreamClass.connection('primary').find(id)
        if (!modelInstance) return

        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        await (modelInstance as any)[method!](...args, job)
        break
      }
    }
  }
}

const background = new Background()
export default background
