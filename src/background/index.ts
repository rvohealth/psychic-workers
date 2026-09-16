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
 * the shortest delay a `jobId` (deduplication key) may be paired with. Below
 * this, a debounce window is no longer meaningfully longer than the time it
 * takes a worker to pick a job up, so `_addToQueue` refuses it rather than
 * silently raising the delay or deduplicating nothing.
 */
const MINIMUM_DEDUPLICATION_DELAY_MS = 10000

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
 * that queue: how the queue was configured, whether its workers carry a BullMQ
 * `limiter`, and the three things needed to build the workers themselves later.
 *
 * `description` is nested rather than flattened because it is what
 * {@link RateLimitedPsychicJobThrownFromWorkerWithoutLimiter} is handed; the
 * worker connection must not be able to ride into an error object.
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
   * and never read back off `workerOptions`: simple mode never writes a count
   * into the options at all, and native named mode omits it when the queue has
   * no `namedQueueWorkers` entry, so a read-back would build one worker for
   * every queue configured for none.
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
   * ## it is not the name the queue has in Redis
   *
   * `connect` rewrites every queue name — this one and each named workstream's
   * — per connection, through `nameToRedisQueueName`
   * (`src/background/helpers/nameToRedisQueueName.ts`). Braces are always
   * stripped. Then, on an ioredis `Cluster` connection, the whole name is
   * wrapped in Redis Cluster hash tags (`{MyAppBackgroundJobQueue}`) so that
   * the queue's keys hash to one slot; on a plain `Redis` connection it is left
   * bare, except under test, where a parallel vitest worker appends its pool id
   * (`MyAppBackgroundJobQueue-2`). Only one of the two ever applies to a given
   * connection: the hash tag is cluster-only, the test suffix non-cluster-only.
   *
   * ## so do not build Redis keys from this
   *
   * Every key BullMQ writes for the queue is namespaced by the *rewritten*
   * name, including the deduplication key behind a delayed job's `jobId`, whose
   * shape is `<prefix>:<queueName>:de:<jobId>`. A script that composes a key
   * from this getter matches in plain-Redis development and finds nothing in
   * cluster production — which looks the same as an empty queue. Read
   * `queue.name` off `background.queues` after connecting instead.
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
   * For every queue built by `connect`: how the queue was configured, whether
   * the workers for that queue carry a BullMQ `limiter`, and the options,
   * connection and count the workers themselves are built from. Computed from
   * the same options object the workers are built from, and recorded whether or
   * not workers are activated in this process, which makes it serve two
   * readers. The worker processors, test invocation, and `WorkerTestUtils` read
   * the first half, so that they all answer "may a job on this queue signal
   * {@link RateLimitedPsychicJob}?" the same way; {@link buildRecordedWorkers}
   * reads the second half, so that activation has everything it needs without
   * re-walking the configuration and works just as well after `connect` has
   * already returned.
   *
   * Keyed by Queue identity rather than name: a transitional workstream's
   * queue has the same formatted name as its current twin but its own
   * configuration.
   */
  private queueWorkerRecords = new Map<Queue, QueueWorkerRecord>()

  /**
   * @internal
   *
   * set immediately before {@link buildRecordedWorkers} runs its build loop, so
   * that a second activation builds nothing and a build that throws partway is
   * not retryable into a second copy of the workers already constructed
   */
  private workersActivated = false

  /**
   * Establishes connection to BullMQ via redis: builds the `Queue` objects for
   * the default and named workstreams and, only when `activateWorkers` is true,
   * the `Worker` objects that run jobs off them.
   *
   * ## connecting and activating are separate
   *
   * The queues are built once per instance — a repeat call finds them already
   * built and skips that work rather than building a second generation of
   * connections and queues. Activation is not tied to that check: every queue's
   * worker options, worker connection and worker count are recorded as the
   * queue is built, so a later `activateWorkers: true` — the one `work()`
   * passes — builds the workers from that record, whether or not this instance
   * had already connected. Workers are built once too, on the first activation.
   *
   * ## it is called for you
   *
   * You rarely call this yourself. Psychic connects on the
   * `server:init:after-routes` hook, on every enqueue path (`staticMethod`,
   * `scheduledMethod`, `modelInstanceMethod` and `unschedule`), in CLI codegen
   * (the `cli:sync` hook, via `ASTWorkersSchemaBuilder`), in the
   * `WorkerTestUtils` helpers (`work()`, `workScheduled()` and `clean()`), and
   * in `work()` — which is the one caller in this package that passes
   * `activateWorkers: true`.
   *
   * ## connecting does not make this a worker process
   *
   * `activateWorkers` defaults to `false`, so connecting never starts workers
   * by itself. A webserver, a console session or a one-off script that connects
   * gets the producer side only: queues it can add jobs to and inspect, and
   * nothing that consumes them. In practice jobs are worked by a process
   * running `work()`; `activateWorkers` is on this method's own signature, so a
   * caller can build workers directly, but nothing in this package does that
   * outside `work()`.
   *
   * What connecting as a producer does **not** do is foreclose becoming one
   * later. A process that connects first and calls `work()` afterwards — a
   * webserver that also works its own jobs, or a worker entrypoint that
   * registers a scheduler before it calls `work()` — gets its workers from that
   * `work()`. If that process configured no `defaultWorkerConnection`, the same
   * `work()` now raises the missing-connection error instead of returning
   * quietly.
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
   * an **empty array** — the fields it compacts all start out null or empty —
   * with no error and no warning. An inspection or maintenance script that
   * forgets to connect therefore iterates nothing, exits 0, and is
   * indistinguishable from an application with nothing queued. Call
   * `background.connect()` first.
   *
   * Each `Queue` here carries the rewritten Redis name rather than the name you
   * configured; see `Background.defaultQueueName` for how that rewrite works.
   * `queue.name` is the name Redis actually knows.
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
   * process has built, across the default queue, every named queue, and their
   * transitional twins.
   *
   * Only a process that activated workers has any — `work()`, or a direct
   * `connect({ activateWorkers: true })`. Anywhere else the getter returns an
   * **empty array**, with no error and no warning: a producer process that only
   * connected, a process that has not connected at all, and a process that
   * configured a `workerCount` of zero are indistinguishable here. A worker
   * entrypoint that attaches its failure listeners by looping over this getter
   * therefore attaches nothing at all if it runs before `work()` does, and logs
   * nothing to say so.
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
    // a partial rateLimit is a compile error, but an untyped config can still deliver one, and
    // open-source BullMQ would forward it as a limiter it does not validate, failing every job
    // fetch on that workstream. Refused here, for the current and the transitional workstreams
    // alike, before any queue or worker of this connect exists (the transitional re-entry below
    // has already been checked)
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
          // Pro documents its worker `group` option as `{ limit, concurrency }` with no `id` (grouping
          // happens at job add, see `_addToQueue`) per https://docs.bullmq.io/bullmq-pro/groups as read
          // 2026-09-14; not verified against an installed Pro build
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
   * records how `queue` was configured, whether the workers built for it carry
   * a BullMQ `limiter`, and the three things {@link buildRecordedWorkers} needs
   * to build those workers later: `workerOptions`, `workerConnection` and
   * `workerCount`. `workerOptions` is the very object the workers are built
   * from (minus the connection), so the record and the workers cannot disagree.
   *
   * It is the sole writer of {@link queueWorkerRecords}, and it records
   * unconditionally — whether or not this process ever activates workers — so
   * that processes which never build any (test invocation, `WorkerTestUtils`)
   * can still consult the limiter answer, and so that a process which activates
   * after `connect` has returned still finds everything the build needs.
   *
   * `workerCount` is passed rather than read back off `workerOptions`; see the
   * field's own TSDoc on {@link QueueWorkerRecord} for why a read-back is wrong.
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
   * builds every worker `connect` recorded a queue for, and is the only place
   * inside `connect` that constructs one. Each record carries the very options
   * object its queue's workers were always built from, so deferring the build
   * to here reproduces the order, the count and the options of building it
   * inline: the records are keyed by `Queue` identity in the order `connect`
   * built the queues, and the default queue's record is always first, so the
   * default missing-connection throw still pre-empts the named one.
   *
   * The activation flag is set before the loop, not after it: `_workers` is
   * append-only, so a build that throws partway must not be retryable into a
   * second copy of the workers it already constructed.
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
   * workstream whose `rateLimit` lacks a positive integer `max` or `duration`
   * (a stricter predicate than `RateLimitedPsychicJob`'s `pauseQueueForSeconds`,
   * which rounds a fractional value up rather than refusing it). The type
   * already requires both, but it admits any number; this catches the untyped
   * config, and the fractional or oversize value the type allows, that would
   * otherwise reach open-source BullMQ as a `limiter` it does not validate
   * (a fractional `duration` is floored to 0ms and rate limits nothing; one
   * past Redis's integer range fails every job fetch).
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
   * When `err` is a {@link RateLimitedPsychicJob} thrown by a job on a queue
   * whose workers carry no BullMQ `limiter`, returns the misconfiguration error
   * the job fails with in its place (whose message names the fix for that
   * queue's configuration); otherwise returns undefined. The worker processors,
   * test invocation, and `WorkerTestUtils` all run this same check.
   *
   * The return is declared as `Error` rather than as the concrete class this
   * builds. The class is deliberately not part of the package's public surface,
   * and this method is `public` (three callers, one of them across a module
   * boundary in `WorkerTestUtils`), so the concrete type would name the class in
   * the emitted declarations and make it reachable as
   * `ReturnType<Background['misconfiguredRateLimitSignal']>`. Callers only ever
   * throw it or fail a job with it, so `Error` is all any of them needs.
   */
  public misconfiguredRateLimitSignal(err: unknown, queue: Queue): Error | undefined {
    if (!(err instanceof RateLimitedPsychicJob)) return

    // every caller hands over a Queue that `connect` built and recorded; anything else is a
    // programming error, and guessing at its configuration would name a config entry that
    // does not exist
    const record = this.queueWorkerRecords.get(queue)
    if (!record)
      throw new Error(
        `[psychic-workers] no worker record for queue ${queue.name}: misconfiguredRateLimitSignal must be given a Queue built by Background#connect (one of Background#queues)`,
      )

    if (record.hasLimiter) return

    return new RateLimitedPsychicJobThrownFromWorkerWithoutLimiter(err, record.description)
  }

  /**
   * @internal
   *
   * the processor every worker on `queue` runs: {@link doWork}, with a
   * {@link RateLimitedPsychicJob} thrown by the job translated into BullMQ's
   * own rate-limit signal. The pause is logged at `warn` (its length comes
   * from the job and is applied as given, rounded up to a whole second), the
   * queue's limiter key is set for `pauseQueueForSeconds` seconds (pausing
   * every worker on the queue that carries a
   * `limiter`), then BullMQ's `RateLimitError` is thrown, which the worker
   * recognizes by its message and answers by moving the job back to the queue
   * without counting an attempt or emitting `failed`. `queue` is the Queue
   * built alongside the worker on the same connection pair, so a transitional
   * workstream's pause lands on its own Redis.
   *
   * Thrown from a job whose worker carries no `limiter`, the signal is a
   * misconfiguration: the job fails, ordinarily, with
   * {@link RateLimitedPsychicJobThrownFromWorkerWithoutLimiter}.
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
   * down.
   *
   * This is the one caller in this package that asks for workers, and it gets
   * them whatever the process did first — an earlier producer-only `connect()`,
   * from a webserver or from registering a scheduled service, no longer leaves
   * `work()` with nothing to do. A process with no `defaultWorkerConnection`
   * configured raises `ActivatingBackgroundWorkersWithoutDefaultWorkerConnection`
   * here for the same reason: asking for workers that cannot connect is an
   * error, not a quiet return. That class is not exported, so there is nothing
   * to catch it by; the remedy is to configure a `defaultWorkerConnection` in
   * that process, or not to call `work()` in it.
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

    // `JobSchedulerTemplateOptions` declares every field optional — `priority?: number`
    // among them — so `{ priority: maybePriority }`, the normal shape when the value comes
    // from a config object, an env var or a nullable column, carries an own `priority` key
    // whose value is `undefined` — a shape TypeScript admits for any consumer on the
    // default `exactOptionalPropertyTypes: false`, and checks not at all from JavaScript.
    // Spread over the mapped priority below
    // it would erase it, BullMQ would then drop the undefined value before Redis, and the
    // scheduler template would store no priority at all — putting every cron run this
    // scheduler produces back in the `wait` list. Stripping the undefined-valued keys makes
    // "caller-supplied options win" mean a caller-supplied *value*, not a caller-supplied
    // key.
    const definedScheduleOpts = Object.fromEntries(
      Object.entries(scheduleOpts).filter(([, value]) => value !== undefined),
    ) as JobSchedulerTemplateOptions

    await queueInstance.upsertJobScheduler(
      schedulerId,
      { pattern },
      {
        name: 'BackgroundJobQueueStaticJob',

        // the priority from the service's `backgroundJobConfig`, written where open-source
        // BullMQ reads it — the same top-level priority `_addToQueue` writes on an ordinary
        // job. Without it BullMQ enqueues every cron run at no priority at all, into the
        // `wait` list, which it drains before it looks at the prioritized set — so a
        // priority-less cron job is fetched ahead of every prioritized job on its queue.
        //
        // The two enqueue sites are written in opposite shapes on purpose. `_addToQueue`
        // spreads its options first and writes `priority` last, because nothing there can
        // supply a priority of its own — the options it merges are the ones it built
        // itself (delay, deduplication), and the priority always comes from the job config
        // or a `backgroundWith` override. This site must let an explicit `scheduleOpts`
        // priority through, so it spreads last instead. The invariant they share is the
        // one that matters: nothing can leave the mapped priority off the job. There it
        // follows from the ordering; here it follows from the undefined-stripping above.
        opts: {
          priority: this.mapPriorityWordToPriorityNumber(this.jobConfigToPriority(jobConfig)),
          ...definedScheduleOpts,
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

    // a `jobId` is a deduplication key, so it is only meaningful behind a delay
    // of at least MINIMUM_DEDUPLICATION_DELAY_MS. This reads the raw
    // `delaySeconds`, before the truthiness coercion below collapses 0, -0 and
    // NaN into `undefined`, and it is set outside the test short-circuit below
    // so that mismatches will raise exceptions even in tests.
    if (jobId !== undefined) {
      const requestedDelay = (delaySeconds ?? NaN) * 1000

      // an empty string is a `jobId` that was given rather than omitted (the
      // type admits it), but it is not a usable deduplication key: BullMQ
      // itself refuses it, and the deduplication block below reads it as falsy
      // and would enqueue an ordinary delayed job with no key and no signal.
      // Refuse it here, with the rest of the unusable pairs, so it cannot be
      // the one shape that deduplicates nothing quietly.
      if (
        jobId === '' ||
        !Number.isFinite(requestedDelay) ||
        Math.abs(requestedDelay) > Number.MAX_SAFE_INTEGER ||
        requestedDelay < MINIMUM_DEDUPLICATION_DELAY_MS
      )
        throw new DeduplicatedJobRequiresMinimumDelay(jobId, delaySeconds, MINIMUM_DEDUPLICATION_DELAY_MS)
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
        //
        // `Math.floor` is live: BullMQ hands this straight to Redis
        // `SET ... PX`, which rejects a fractional argument, and a duration
        // built from e.g. `{ seconds: 10.0005 }` is fractional.
        //
        // `Math.max(1, …)` is belt-and-braces and cannot currently fire. The
        // guard above has already refused any `jobId` under
        // MINIMUM_DEDUPLICATION_DELAY_MS, so `delay - DEDUPLICATION_KEY_MARGIN_MS`
        // is at least 9000 on every path into here. It is kept because it is
        // the coupling that is easy to miss: if the floor is ever lowered to
        // within a second of the margin, this clamp would turn an illegal
        // lifetime into a 1ms key — deduplication silently off — rather than an
        // error. Anyone lowering the floor should revisit this line first.
        ttl: Math.max(1, Math.floor(delay - DEDUPLICATION_KEY_MARGIN_MS)),
        extend: true,
        replace: true,
      }
    }

    const priorityNumber = this.mapPriorityWordToPriorityNumber(priority)

    // `group` is a BullMQ Pro option: open-source BullMQ's `JobsOptions` does not declare
    // it, so TypeScript checks nothing about it at the `add` call below — a misspelled key
    // or a body Pro would reject compiles clean. Naming the shape here is what gives the
    // compiler something to check the key and its body against.
    interface ProGroupOption {
      group: { id: string; priority: number }
    }

    const groupConfig = this.groupIdToGroupConfig(groupId)

    // BullMQ Pro group priority (ignored by open-source BullMQ), which orders this job's
    // group against the queue's other groups. It sits alongside, rather than instead of,
    // the job priority below: Pro documents the two as answering different questions —
    // which group runs next, and which job within a group runs next — per
    // https://docs.bullmq.io/bullmq-pro/groups as read 2026-09-14; not verified against an
    // installed Pro build. Empty for an ungrouped job, so it carries no `group` key at all.
    const proGroupOption: ProGroupOption | Record<string, never> = groupConfig
      ? { group: { ...groupConfig, priority: priorityNumber } }
      : {}

    await queueInstance.add(jobType, jobData, {
      ...jobOptions,

      // open-source BullMQ's job priority, and the only priority it reads. Written on
      // every job, grouped or not: a group is a BullMQ Pro concept, so without Pro the
      // `group` key spread in below is stored but never read — `Job.optsAsJSON` passes
      // unrecognised option keys straight through, so it round-trips out of Redis, but
      // nothing schedules on it — and a priority living only inside it would silently do
      // nothing. Named workstreams are the case that matters — every one of their jobs
      // carries a group id (the workstream name, see `jobConfigToGroupId`), even though
      // the workstream already has its own queue and needs no group to route.
      //
      // Written last, after the spread, which is the opposite shape from the scheduler
      // template in `scheduledMethod` — deliberately, since `jobOptions` here is built by
      // this method rather than supplied by the caller. See the comment there for why the
      // two differ and what they nonetheless guarantee alike.
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
