import { closeAllDbConnections, compact, Dream, pascalize } from '@rvoh/dream'
import { PsychicApp } from '@rvoh/psychic'
import { Job, JobsOptions, Queue, QueueOptions, Worker, WorkerOptions } from 'bullmq'
import ActivatingBackgroundWorkersWithoutDefaultWorkerConnection from '../error/background/ActivatingBackgroundWorkersWithoutDefaultWorkerConnection.js'
import ActivatingNamedQueueBackgroundWorkersWithoutWorkerConnection from '../error/background/ActivatingNamedQueueBackgroundWorkersWithoutWorkerConnection.js'
import DefaultBullMQNativeOptionsMissingQueueConnectionAndDefaultQueueConnection from '../error/background/DefaultBullMQNativeOptionsMissingQueueConnectionAndDefaultQueueConnection.js'
import NamedBullMQNativeOptionsMissingQueueConnectionAndDefaultQueueConnection from '../error/background/NamedBullMQNativeOptionsMissingQueueConnectionAndDefaultQueueConnection.js'
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
    const defaultBullMQQueueOptions = psychicWorkersApp.backgroundOptions.defaultBullMQQueueOptions || {}

    if ((psychicWorkersApp.backgroundOptions as PsychicBackgroundNativeBullMQOptions).nativeBullMQ) {
      this.nativeBullMQConnect(
        defaultBullMQQueueOptions,
        psychicWorkersApp.backgroundOptions as PsychicBackgroundNativeBullMQOptions,
        { activateWorkers },
      )
    } else {
      this.simpleConnect(
        defaultBullMQQueueOptions,
        psychicWorkersApp.backgroundOptions as PsychicBackgroundSimpleOptions,
        { activateWorkers },
      )
    }
  }

  /**
   * Returns all the queues in your application
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
   * Returns all the workers in your application
   */
  public get workers() {
    return [...this._workers]
  }

  private async shutdownAndExit() {
    await this.shutdown()
    // https://docs.bullmq.io/guide/going-to-production#gracefully-shut-down-workers
    process.exit(0)
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
      await worker.close()
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
      ...(nativeBullMQ.defaultQueueOptions || {}),
      connection: defaultQueueConnection,
    })
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
            ...(backgroundOptions.nativeBullMQ.defaultWorkerOptions || {}),
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

      this.namedQueues[queueName] = new Background.Queue(formattedQueuename, {
        ...defaultBullMQQueueOptions,
        ...namedQueueOptions,
        connection: namedQueueConnection,
      })

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
      PsychicApp.log('[psychic-workers] uncaughtException:', error)
    })

    process.on('unhandledRejection', (error: Error) => {
      PsychicApp.log('[psychic-workers] unhandledRejection:', error)
    })

    process.on('SIGTERM', () => {
      if (!EnvInternal.isTest) PsychicApp.log('[psychic-workers] handle SIGTERM')

      void this.shutdownAndExit()
        .then(() => {})
        .catch(() => {})
    })

    process.on('SIGINT', () => {
      if (!EnvInternal.isTest) PsychicApp.log('[psychic-workers] handle SIGINT')

      void this.shutdownAndExit()
        .then(() => {})
        .catch(() => {})
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
    }: {
      globalName: string
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args?: any[]
      filepath?: string
      importKey?: string
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jobConfig?: BackgroundJobConfig<any>
    },
  ) {
    this.connect()

    // `jobId` is used to determine uniqueness along with name and repeat pattern.
    // Since the name is really a job type and never changes, the `jobId` is the only
    // way to allow multiple jobs with the same cron repeat pattern. Uniqueness will
    // now be enforced by combining class name, method name, and cron repeat pattern.
    //
    // See: https://docs.bullmq.io/guide/jobs/repeatable
    const jobId = `${ObjectClass.name}:${method}`
    const queueInstance = this.queueInstance(jobConfig)
    if (!queueInstance) throw new Error(`Missing queue for: ${jobConfig.queue?.toString()}`)

    await queueInstance.add(
      'BackgroundJobQueueStaticJob',
      {
        globalName,
        method,
        args,
      },
      {
        repeat: {
          pattern,
        },
        jobId,
        group: this.jobConfigToGroup(jobConfig),
        priority: this.mapPriorityWordToPriorityNumber(this.jobConfigToPriority(jobConfig)),
        // explicitly typing as JobsOptions because Psychic can't be aware of BullMQ Pro options
      } as JobsOptions,
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
        id: modelInstance.primaryKeyValue,
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
    // set this variable out side of the conditional so that
    // mismatches will raise exceptions even in tests
    const queueInstance = this.queueInstance(jobConfig)

    // if delaySeconds is 0, we will intentionally treat
    // this as `undefined`
    const delay = delaySeconds ? delaySeconds * 1000 : undefined

    if (EnvInternal.isTest && !EnvInternal.boolean('REALLY_TEST_BACKGROUND_QUEUE')) {
      const queue = new Background.Queue('TestQueue', { connection: {} })
      const job = new Job(queue, jobType, jobData, {})
      await this.doWork(job)
      return
      //
    }

    if (!queueInstance) throw new Error(`missing queue: ${jobConfig?.queue?.toString() || 'N/A'}`)

    if (groupId && priority) {
      await queueInstance.add(jobType, jobData, {
        delay,
        jobId,
        group: {
          ...this.groupIdToGroupConfig(groupId),
          priority: this.mapPriorityWordToPriorityNumber(priority),
        },
        // explicitly typing as JobsOptions because Psychic can't be aware of BullMQ Pro options
      } as JobsOptions)
      //
    } else {
      await queueInstance.add(jobType, jobData, {
        delay,
        jobId,
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

        if (!objectClass) return

        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        await objectClass[method!](...args, job)
        break

      case 'BackgroundJobQueueModelInstanceJob':
        if (globalName) {
          dreamClass = PsychicApp.lookupClassByGlobalName(globalName) as typeof Dream | undefined
        }

        if (dreamClass) {
          const modelInstance = await dreamClass.connection('primary').find(id)
          if (!modelInstance) return

          // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          await (modelInstance as any)[method!](...args, job)
        }
        break
    }
  }
}

const background = new Background()
export default background

export async function stopBackgroundWorkers() {
  await background.shutdown()
}
