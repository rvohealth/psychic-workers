import { Dream } from '@rvoh/dream'
import { closeAllDbConnections } from '@rvoh/dream/db'
import { pascalize } from '@rvoh/dream/utils'
import { PsychicApp } from '@rvoh/psychic'
import { randomUUID } from 'node:crypto'
import {
  Job,
  JobSchedulerTemplateOptions,
  JobsOptions,
  Queue,
  QueueOptions,
  Worker,
  WorkerOptions,
} from 'bullmq'
import ActivatingBackgroundWorkersWithoutDefaultWorkerConnection from '../error/background/ActivatingBackgroundWorkersWithoutDefaultWorkerConnection.js'
import ActivatingNamedQueueBackgroundWorkersWithoutWorkerConnection from '../error/background/ActivatingNamedQueueBackgroundWorkersWithoutWorkerConnection.js'
import DefaultBullMQNativeOptionsMissingQueueConnectionAndDefaultQueueConnection from '../error/background/DefaultBullMQNativeOptionsMissingQueueConnectionAndDefaultQueueConnection.js'
import DuplicateNamedWorkstream from '../error/background/DuplicateNamedWorkstream.js'
import InvalidJobSchedulerLocator from '../error/background/InvalidJobSchedulerLocator.js'
import NamedBullMQNativeOptionsMissingQueueConnectionAndDefaultQueueConnection from '../error/background/NamedBullMQNativeOptionsMissingQueueConnectionAndDefaultQueueConnection.js'
import NoClassForSpecifiedGlobalName from '../error/background/NoClassForSpecifiedGlobalName.js'
import NoQueueForSpecifiedQueueName from '../error/background/NoQueueForSpecifiedQueueName.js'
import NoQueueForSpecifiedWorkstream from '../error/background/NoQueueForSpecifiedWorkstream.js'
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
  PsychicJobScheduler,
  PsychicJobSchedulerOrigin,
  PsychicJobSchedulerRoute,
  QueueBackgroundJobConfig,
  WorkstreamBackgroundJobConfig,
} from '../types/background.js'
import nameToRedisQueueName from './helpers/nameToRedisQueueName.js'

const DEFAULT_CONCURRENCY = 10
const JOB_SCHEDULER_LOCATOR_PREFIX = 'psychic-job-scheduler'
const JOB_SCHEDULER_LOCATOR_VERSION = 'v1'

interface JobSchedulerIdentity {
  jobSchedulerId: string
  locator: string
  globalName: string
  method: string
  route: PsychicJobSchedulerRoute
}

interface JobSchedulerRoutingConfig {
  workstream?: string
  queue?: string
}

interface JobSchedulerQueueTopology {
  queue: Queue
  origin: PsychicJobSchedulerOrigin
}

/**
 * the underlying class driving the `background` singleton,
 * available as an import from `psychic-workers`.
 */
export class Background {
  /**
   * returns the default queue name for your app
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
   * Origin-aware queue topology used by scheduler inventory and exact removal.
   */
  private readonly jobSchedulerQueueTopology: JobSchedulerQueueTopology[] = []

  /**
   * @internal
   *
   * Binds exact queue origins to the Background instance that constructed them.
   */
  private readonly jobSchedulerTopologyGeneration = randomUUID()

  /** @internal */
  private jobSchedulerRoutingMode: 'simple' | 'native' | undefined

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
   * Establishes connection to BullMQ via redis
   */
  public connect({
    activateWorkers = false,
  }: {
    activateWorkers?: boolean
  } = {}) {
    if (this.defaultQueue) return

    const psychicWorkersApp = PsychicAppWorkers.getOrFail()
    const backgroundOptions = psychicWorkersApp.backgroundOptions
    this.validateNamedWorkstreamConfiguration(backgroundOptions)

    const defaultBullMQQueueOptions = backgroundOptions.defaultBullMQQueueOptions || {}

    if ((backgroundOptions as PsychicBackgroundNativeBullMQOptions).nativeBullMQ) {
      this.jobSchedulerRoutingMode = 'native'
      this.nativeBullMQConnect(
        defaultBullMQQueueOptions,
        backgroundOptions as PsychicBackgroundNativeBullMQOptions,
        { activateWorkers },
      )
    } else {
      this.jobSchedulerRoutingMode = 'simple'
      this.simpleConnect(defaultBullMQQueueOptions, backgroundOptions as PsychicBackgroundSimpleOptions, {
        activateWorkers,
      })
    }
  }

  /**
   * Returns all the queues in your application
   */
  public get queues(): Queue[] {
    return this.jobSchedulerQueueTopology.map(({ queue }) => queue)
  }

  /**
   * Lists Psychic-owned job schedulers from every configured current and
   * transitional queue origin.
   *
   * The result is unordered. Each queue is read independently, so the aggregate
   * is not a globally consistent snapshot and concurrent changes or aliased
   * origins can produce mixed-time duplicates or omissions. BullMQ schedulers
   * not recognizable as Psychic scheduled static jobs are excluded.
   *
   * @returns Framework-owned scheduler metadata without job arguments, Redis
   * connections, BullMQ queue objects, or BullMQ scheduler DTOs.
   * @throws When any configured queue client rejects its inventory read. No
   * partial result is returned. Caller-supplied Redis behavior may instead keep
   * an unavailable read pending.
   */
  public async getJobSchedulers(): Promise<PsychicJobScheduler[]> {
    this.connect()

    const schedulerLists = await Promise.all(
      this.jobSchedulerQueueTopology.map(async ({ queue, origin }) => {
        const schedulers: unknown[] = await queue.getJobSchedulers()
        return schedulers.flatMap(scheduler => {
          const psychicScheduler = this.psychicJobScheduler(scheduler, origin)
          return psychicScheduler ? [psychicScheduler] : []
        })
      }),
    )

    return schedulerLists.flat()
  }

  /**
   * Removes the scheduler represented by an inventory row from that row's exact
   * configured queue origin.
   *
   * Inventory origins are bound to the {@link Background} instance that created
   * them. A cloned row from the same instance is valid, but a row from another
   * initialization generation is rejected. The removal is keyed by scheduler
   * identity, so stale cadence metadata remains removable. When two origins
   * alias the same BullMQ keyspace, removal through one returns `true` and a
   * later removal through the other observation returns `false`.
   *
   * Removing a scheduler prevents BullMQ from emitting future occurrences. An
   * occurrence BullMQ already emitted may still execute whether it is waiting,
   * prioritized, or active. Scheduling the same identity later recreates it.
   *
   * @param jobScheduler - A row returned by this instance's
   * {@link Background.getJobSchedulers} method.
   * @returns `true` when the scheduler was removed, or `false` when it was
   * already absent at that origin.
   * @throws When locator metadata contradicts the row, the origin belongs to a
   * different initialization generation, the origin is no longer configured,
   * or the queue client rejects. Caller-supplied Redis behavior may instead
   * keep an unavailable removal pending.
   */
  public async removeJobScheduler(jobScheduler: PsychicJobScheduler): Promise<boolean> {
    this.connect()

    const identity = this.jobSchedulerIdentityFromLocator(jobScheduler.locator)
    if (
      identity.globalName !== jobScheduler.globalName ||
      identity.method !== jobScheduler.method ||
      !this.jobSchedulerRoutesMatch(identity.route, jobScheduler.origin.route)
    )
      throw new Error('Job scheduler metadata does not match its locator')

    if (jobScheduler.origin.generation !== this.jobSchedulerTopologyGeneration)
      throw new Error('Job scheduler origin belongs to a different Background generation')

    const topologyEntry = this.jobSchedulerQueueTopology.find(
      ({ origin }) =>
        origin.generation === jobScheduler.origin.generation &&
        origin.source === jobScheduler.origin.source &&
        this.jobSchedulerRoutesMatch(origin.route, jobScheduler.origin.route),
    )
    if (!topologyEntry) throw new Error('No configured queue matches this job scheduler origin')

    return await topologyEntry.queue.removeJobScheduler(identity.jobSchedulerId)
  }

  /**
   * @internal
   *
   * Produces the shared queue-local identity and portable locator for a Psychic
   * scheduled static job. This method performs no queue construction or I/O.
   */
  public jobSchedulerIdentity(
    globalName: string,
    method: string,
    jobConfig: JobSchedulerRoutingConfig = {},
  ): JobSchedulerIdentity {
    const route = this.jobSchedulerRoute(jobConfig)

    return {
      jobSchedulerId: this.jobSchedulerId(globalName, method),
      locator: this.encodeJobSchedulerLocator(globalName, method, route),
      globalName,
      method,
      route,
    }
  }

  /**
   * @internal
   *
   * Decodes any locator version supported by this major release into the shared
   * scheduler identity. Unsupported or malformed values use a framework error.
   */
  public jobSchedulerIdentityFromLocator(locator: string): JobSchedulerIdentity {
    const [prefix, version, encodedPayload, ...remainder] = locator.split(':')
    if (
      prefix !== JOB_SCHEDULER_LOCATOR_PREFIX ||
      version !== JOB_SCHEDULER_LOCATOR_VERSION ||
      !encodedPayload ||
      remainder.length > 0
    ) {
      throw new InvalidJobSchedulerLocator()
    }

    const payloadBuffer = Buffer.from(encodedPayload, 'base64url')
    if (payloadBuffer.toString('base64url') !== encodedPayload) throw new InvalidJobSchedulerLocator()

    let payload: unknown
    try {
      payload = JSON.parse(payloadBuffer.toString('utf8'))
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      throw new InvalidJobSchedulerLocator()
    }

    if (!Array.isArray(payload) || payload.length !== 3) throw new InvalidJobSchedulerLocator()

    const [globalName, method, encodedRoute] = payload as unknown[]
    if (typeof globalName !== 'string' || !globalName || typeof method !== 'string' || !method)
      throw new InvalidJobSchedulerLocator()

    const route = this.decodeJobSchedulerRoute(encodedRoute)
    return {
      jobSchedulerId: this.jobSchedulerId(globalName, method),
      locator,
      globalName,
      method,
      route,
    }
  }

  /**
   * @internal
   *
   * Removes the scheduler identified by a portable Psychic locator from every
   * configured queue origin for its logical route.
   */
  public async unscheduleByLocator(locator: string): Promise<boolean> {
    this.connect()

    const identity = this.jobSchedulerIdentityFromLocator(locator)
    const matchingQueues = this.jobSchedulerQueueTopology.filter(({ origin }) =>
      this.jobSchedulerRoutesMatch(origin.route, identity.route),
    )

    if (matchingQueues.length === 0) throw this.missingQueueForJobSchedulerRoute(identity.route)

    const removalResults = await Promise.allSettled(
      matchingQueues.map(async ({ queue }) => await queue.removeJobScheduler(identity.jobSchedulerId)),
    )
    const rejectedRemoval = removalResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (rejectedRemoval) throw rejectedRemoval.reason

    return removalResults.some(result => result.status === 'fulfilled' && result.value)
  }

  private jobSchedulerId(globalName: string, method: string) {
    return `${globalName}:${method}`
  }

  private psychicJobScheduler(
    scheduler: unknown,
    origin: PsychicJobSchedulerOrigin,
  ): PsychicJobScheduler | undefined {
    if (!this.isRecord(scheduler)) return

    const data = this.isRecord(scheduler.template) ? scheduler.template.data : undefined
    if (
      scheduler.name !== 'BackgroundJobQueueStaticJob' ||
      typeof scheduler.pattern !== 'string' ||
      !this.isRecord(data) ||
      typeof data.globalName !== 'string' ||
      !data.globalName ||
      typeof data.method !== 'string' ||
      !data.method ||
      !Array.isArray(data.args)
    )
      return

    if (
      scheduler.next !== undefined &&
      scheduler.next !== null &&
      (typeof scheduler.next !== 'number' || !Number.isFinite(scheduler.next))
    )
      return

    const identity = this.jobSchedulerIdentity(
      data.globalName,
      data.method,
      this.jobSchedulerRoutingConfig(origin.route),
    )
    if (scheduler.key !== identity.jobSchedulerId) return

    return {
      locator: identity.locator,
      globalName: identity.globalName,
      method: identity.method,
      pattern: scheduler.pattern,
      ...(typeof scheduler.next === 'number' ? { nextRunAt: scheduler.next } : {}),
      origin: this.copyJobSchedulerOrigin(origin),
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  private jobSchedulerRoutingConfig(route: PsychicJobSchedulerRoute): JobSchedulerRoutingConfig {
    switch (route.kind) {
      case 'default':
        return {}
      case 'named':
        return { workstream: route.name }
      default: {
        const _never: never = route
        throw new Error(`Unhandled PsychicJobSchedulerRoute: ${String(_never)}`)
      }
    }
  }

  private copyJobSchedulerOrigin(origin: PsychicJobSchedulerOrigin): PsychicJobSchedulerOrigin {
    return {
      generation: origin.generation,
      source: origin.source,
      route: { ...origin.route },
    }
  }

  private jobSchedulerRoute(jobConfig: JobSchedulerRoutingConfig): PsychicJobSchedulerRoute {
    if (typeof jobConfig.workstream === 'string') return { kind: 'named', name: jobConfig.workstream }
    if (typeof jobConfig.queue === 'string') return { kind: 'named', name: jobConfig.queue }
    return { kind: 'default' }
  }

  private jobSchedulerRoutesMatch(left: PsychicJobSchedulerRoute, right: PsychicJobSchedulerRoute): boolean {
    switch (left.kind) {
      case 'default':
        return right.kind === 'default'
      case 'named':
        return right.kind === 'named' && left.name === right.name
      default: {
        const _never: never = left
        throw new Error(`Unhandled PsychicJobSchedulerRoute: ${String(_never)}`)
      }
    }
  }

  private missingQueueForJobSchedulerRoute(route: PsychicJobSchedulerRoute): Error {
    switch (route.kind) {
      case 'default':
        return new Error('No default queue is configured for this job scheduler')
      case 'named': {
        return this.jobSchedulerRoutingMode === 'native'
          ? new NoQueueForSpecifiedQueueName(route.name)
          : new NoQueueForSpecifiedWorkstream(route.name)
      }
      default: {
        const _never: never = route
        throw new Error(`Unhandled PsychicJobSchedulerRoute: ${String(_never)}`)
      }
    }
  }

  private encodeJobSchedulerLocator(globalName: string, method: string, route: PsychicJobSchedulerRoute) {
    const encodedRoute =
      route.kind === 'default' ? ['default'] : (['named', route.name] satisfies [string, string])
    const payload = Buffer.from(JSON.stringify([globalName, method, encodedRoute]), 'utf8').toString(
      'base64url',
    )

    return `${JOB_SCHEDULER_LOCATOR_PREFIX}:${JOB_SCHEDULER_LOCATOR_VERSION}:${payload}`
  }

  private decodeJobSchedulerRoute(encodedRoute: unknown): PsychicJobSchedulerRoute {
    if (Array.isArray(encodedRoute) && encodedRoute.length === 1 && encodedRoute[0] === 'default')
      return { kind: 'default' }

    if (
      Array.isArray(encodedRoute) &&
      encodedRoute.length === 2 &&
      encodedRoute[0] === 'named' &&
      typeof encodedRoute[1] === 'string'
    )
      return { kind: 'named', name: encodedRoute[1] }

    throw new InvalidJobSchedulerLocator()
  }

  private validateNamedWorkstreamConfiguration(
    backgroundOptions: PsychicBackgroundNativeBullMQOptions | PsychicBackgroundSimpleOptions,
  ) {
    if ((backgroundOptions as PsychicBackgroundNativeBullMQOptions).nativeBullMQ) return

    const simpleOptions = backgroundOptions as PsychicBackgroundSimpleOptions
    this.validateNamedWorkstreams(simpleOptions.namedWorkstreams, 'current')
    this.validateNamedWorkstreams(simpleOptions.transitionalWorkstreams?.namedWorkstreams, 'transitional')
  }

  private validateNamedWorkstreams(
    workstreams: PsychicBackgroundWorkstreamOptions[] | undefined,
    source: 'current' | 'transitional',
  ) {
    const names = new Set<string>()
    for (const workstream of workstreams || []) {
      if (names.has(workstream.name)) throw new DuplicateNamedWorkstream(workstream.name, source)
      names.add(workstream.name)
    }
  }

  private registerJobSchedulerQueue(
    queue: Queue,
    source: 'current' | 'transitional',
    route: PsychicJobSchedulerRoute,
  ) {
    this.jobSchedulerQueueTopology.push({
      queue,
      origin: {
        generation: this.jobSchedulerTopologyGeneration,
        source,
        route,
      },
    })
  }

  /**
   * Returns all the workers in your application
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
      activateWorkers = false,
      activatingTransitionalWorkstreams = false,
    }: {
      activateWorkers?: boolean
      activatingTransitionalWorkstreams?: boolean
    },
  ) {
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
    this.registerJobSchedulerQueue(
      defaultQueue,
      activatingTransitionalWorkstreams ? 'transitional' : 'current',
      { kind: 'default' },
    )
    ////////////////////////////////////
    // end: create default workstream //
    ////////////////////////////////////

    /////////////////////////////
    // create default workers //
    /////////////////////////////
    if (activateWorkers) {
      if (!defaultWorkerConnection) throw new ActivatingBackgroundWorkersWithoutDefaultWorkerConnection()

      const workerCount = backgroundOptions.defaultWorkstream?.workerCount ?? 1
      for (let i = 0; i < workerCount; i++) {
        this._workers.push(
          new Background.Worker(formattedQueueName, async job => await this.doWork(job), {
            autorun: !EnvInternal.isTest,
            ...backgroundOptions.defaultBullMQWorkerOptions,
            connection: defaultWorkerConnection,
            concurrency: backgroundOptions.defaultWorkstream?.concurrency || DEFAULT_CONCURRENCY,
          }),
        )
      }
    }
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
      this.registerJobSchedulerQueue(
        namedQueue,
        activatingTransitionalWorkstreams ? 'transitional' : 'current',
        { kind: 'named', name: namedWorkstream.name },
      )

      //////////////////////////
      // create named workers //
      //////////////////////////
      if (activateWorkers) {
        if (!namedWorkstreamWorkerConnection)
          throw new ActivatingNamedQueueBackgroundWorkersWithoutWorkerConnection(namedWorkstream.name)

        const workerCount = namedWorkstream.workerCount ?? 1
        for (let i = 0; i < workerCount; i++) {
          this._workers.push(
            new Background.Worker(namedWorkstreamFormattedQueueName, async job => await this.doWork(job), {
              autorun: !EnvInternal.isTest,
              ...backgroundOptions.defaultBullMQWorkerOptions,
              group: {
                id: namedWorkstream.name,
                limit: namedWorkstream.rateLimit,
              },
              connection: namedWorkstreamWorkerConnection,
              concurrency: namedWorkstream.concurrency || DEFAULT_CONCURRENCY,
              // explicitly typing as WorkerOptions because Psychic can't be aware of BullMQ Pro options
            } as WorkerOptions),
          )
        }
      }
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
        activateWorkers,
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
    {
      activateWorkers = false,
    }: {
      activateWorkers?: boolean
    },
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
    this.defaultQueue = new Background.Queue(formattedQueueName, {
      ...defaultBullMQQueueOptions,
      ...nativeBullMQ.defaultQueueOptions,
      connection: defaultQueueConnection,
    })
    this.registerJobSchedulerQueue(this.defaultQueue, 'current', { kind: 'default' })
    ///////////////////////////////
    // end: create default queue //
    ///////////////////////////////

    /////////////////////////////
    // create default workers //
    /////////////////////////////
    if (activateWorkers) {
      if (!defaultWorkerConnection) throw new ActivatingBackgroundWorkersWithoutDefaultWorkerConnection()

      const workerCount = nativeBullMQ.defaultWorkerCount ?? 1
      for (let i = 0; i < workerCount; i++) {
        this._workers.push(
          new Background.Worker(formattedQueueName, async job => await this.doWork(job), {
            autorun: !EnvInternal.isTest,
            ...backgroundOptions.defaultBullMQWorkerOptions,
            ...backgroundOptions.nativeBullMQ.defaultWorkerOptions,
            connection: defaultWorkerConnection,
          }),
        )
      }
    }
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
      this.registerJobSchedulerQueue(namedQueue, 'current', { kind: 'named', name: queueName })

      //////////////////////////
      // create extra workers //
      //////////////////////////
      const extraWorkerOptionsMap: Record<string, BullMQNativeWorkerOptions> =
        nativeBullMQ.namedQueueWorkers || {}
      const extraWorkerOptions: BullMQNativeWorkerOptions | undefined = extraWorkerOptionsMap[queueName]
      const extraWorkerCount = extraWorkerOptions ? (extraWorkerOptions.workerCount ?? 1) : 0

      this.groupNames[queueName] ||= []
      if (extraWorkerOptions?.group?.id) this.groupNames[queueName].push(extraWorkerOptions.group.id)

      if (activateWorkers) {
        if (!namedWorkerConnection)
          throw new ActivatingNamedQueueBackgroundWorkersWithoutWorkerConnection(queueName)

        for (let i = 0; i < extraWorkerCount; i++) {
          this._workers.push(
            new Background.Worker(formattedQueuename, async job => await this.doWork(job), {
              autorun: !EnvInternal.isTest,
              ...backgroundOptions.defaultBullMQWorkerOptions,
              ...extraWorkerOptions,
              connection: namedWorkerConnection,
            }),
          )
        }
      }
      ///////////////////////////////
      // end: create extra workers //
      ///////////////////////////////
    })
    //////////////////////////////
    // end: create named queues //
    //////////////////////////////
  }

  /**
   * starts background workers
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

    const identity = this.jobSchedulerIdentity(globalName, method, jobConfig)
    const queueInstance = this.queueInstance(jobConfig)
    if (!queueInstance) throw new Error(`Missing queue for: ${jobConfig.queue?.toString()}`)

    await queueInstance.upsertJobScheduler(
      identity.jobSchedulerId,
      { pattern },
      {
        name: 'BackgroundJobQueueStaticJob',
        opts: scheduleOpts,

        data: {
          globalName,
          method,
          args,
        },
      },
    )
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
      await this.doWork(job)
      return
      //
    }

    if (!queueInstance) throw new Error(`missing queue: ${jobConfig?.queue?.toString() || 'N/A'}`)

    const jobOptions: Partial<JobsOptions> = {}

    if (delay) jobOptions.delay = delay

    if (delay && jobId) {
      jobOptions.deduplication = {
        id: jobId,
        ttl: delay,
        extend: true,
        replace: true,
      }
    }

    if (groupId && priority) {
      await queueInstance.add(jobType, jobData, {
        ...jobOptions,
        group: {
          ...this.groupIdToGroupConfig(groupId),
          priority: this.mapPriorityWordToPriorityNumber(priority),
        },
        // explicitly typing as JobsOptions because Psychic can't be aware of BullMQ Pro options
      } as JobsOptions)
      //
    } else {
      await queueInstance.add(jobType, jobData, {
        ...jobOptions,
        group: this.groupIdToGroupConfig(groupId),
        priority: this.mapPriorityWordToPriorityNumber(priority),
        // explicitly typing as JobsOptions because Psychic can't be aware of BullMQ Pro options
      } as JobsOptions)
    }
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
