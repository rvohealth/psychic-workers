import { Queue, Worker } from 'bullmq'
import { Redis } from 'ioredis'
import { Background } from '../../src/package-exports/index.js'
import { BullMQNativeWorkerOptions } from '../../src/package-exports/types.js'

/**
 * Test doubles for the BullMQ `Queue` and `Worker` classes, recording the
 * arguments they were constructed with so specs can assert on the queues and
 * workers a `Background#connect` call builds.
 *
 * They are provided to `Background` through the `Background.Queue` and
 * `Background.Worker` static getters, which exist as a seam for BullMQ Pro.
 *
 * Call `installBullMQRecorders()` once in a `describe` body: it mints a fresh
 * pair of recorder classes for that block and registers the `beforeEach` that
 * installs them on the seam and empties the recordings, so no spec has to
 * remember to reset shared state.
 */

export interface RecordedJobAdd {
  jobType: string
  jobData: unknown
  opts: Record<string, unknown>
}

export interface RecordingQueue {
  queueName: string
  queueOptions: Record<string, unknown>
  adds: RecordedJobAdd[]
  jobSchedulers: unknown[][]

  /**
   * BullMQ's `Job` constructor binds `toKey` off the queue it is handed and
   * builds a `Scripts` instance from the queue's `keys`, so the recorder needs
   * both to stand in for the throwaway `TestQueue` that `Background#_addToQueue`
   * constructs when it short-circuits job invocation in test mode. Nothing ever
   * reaches Redis: the Job is only used to carry job data into `doWork`.
   */
  keys: Record<string, string>

  add(jobType: string, jobData: unknown, opts: Record<string, unknown>): Promise<null>
  toKey(type: string): string
  upsertJobScheduler(...args: unknown[]): Promise<null>
  close(): null
}

export interface RecordingWorker {
  queueName: string
  processor: unknown
  workerOptions: Record<string, unknown>
  close(): null
}

export interface BullMQRecorders {
  /**
   * the recorder classes themselves, for `toBeInstanceOf` assertions and for
   * specs that need to hand the seam something by identity.
   */
  Queue: new (queueName: string, queueOptions: Record<string, unknown>) => RecordingQueue
  Worker: new (
    queueName: string,
    processor: unknown,
    workerOptions: Record<string, unknown>,
  ) => RecordingWorker

  /**
   * every queue constructed during the current example, excluding the throwaway
   * `TestQueue` that `Background#_addToQueue` builds when it short-circuits job
   * invocation in test mode. The name is owned by `src/background/index.ts`
   * (`new Background.Queue('TestQueue', ...)`) and is not exported, so it is
   * duplicated here.
   */
  readonly queues: RecordingQueue[]

  /** every queue constructed during the current example, `TestQueue` included */
  readonly allQueues: RecordingQueue[]

  /** every worker constructed during the current example */
  readonly workers: RecordingWorker[]
}

/**
 * the queue name `Background#_addToQueue` uses for the throwaway queue it
 * builds to construct a Job when short-circuiting job invocation in test mode
 */
const TEST_QUEUE_NAME = 'TestQueue'

export function installBullMQRecorders(): BullMQRecorders {
  const allQueues: RecordingQueue[] = []
  const workers: RecordingWorker[] = []

  class QueueRecorder implements RecordingQueue {
    public adds: RecordedJobAdd[] = []
    public jobSchedulers: unknown[][] = []
    public keys: Record<string, string> = {}

    constructor(
      public queueName: string,
      public queueOptions: Record<string, unknown>,
    ) {
      allQueues.push(this)
    }

    public add(jobType: string, jobData: unknown, opts: Record<string, unknown>) {
      this.adds.push({ jobType, jobData, opts })
      return Promise.resolve(null)
    }

    public toKey(type: string) {
      return `${this.queueName}:${type}`
    }

    public upsertJobScheduler(...args: unknown[]) {
      this.jobSchedulers.push(args)
      return Promise.resolve(null)
    }

    public close() {
      return null
    }
  }

  class WorkerRecorder implements RecordingWorker {
    constructor(
      public queueName: string,
      public processor: unknown,
      public workerOptions: Record<string, unknown>,
    ) {
      workers.push(this)
    }

    public close() {
      return null
    }
  }

  beforeEach(() => {
    allQueues.length = 0
    workers.length = 0

    vi.spyOn(Background, 'Queue', 'get').mockReturnValue(QueueRecorder as unknown as typeof Queue)
    vi.spyOn(Background, 'Worker', 'get').mockReturnValue(WorkerRecorder as unknown as typeof Worker)
  })

  return {
    Queue: QueueRecorder,
    Worker: WorkerRecorder,

    get queues() {
      return allQueues.filter(queue => queue.queueName !== TEST_QUEUE_NAME)
    },

    get allQueues() {
      return allQueues
    },

    get workers() {
      return workers
    },
  }
}

/**
 * a stand-in for an ioredis connection. `nameToRedisQueueName` only asks
 * whether a connection `instanceof Cluster`, and `closeAllRedisConnections`
 * only calls `quit`, so specs never need a live Redis.
 */
export function fakeRedisConnection(label: string): Redis {
  return {
    __label: label,
    quit: () => Promise.resolve('OK'),
  } as unknown as Redis
}

/**
 * `BullMQNativeWorkerOptions` extends BullMQ's `WorkerOptions` without omitting
 * `connection`, so every `namedQueueWorkers` / `defaultWorkerOptions` entry is
 * required to carry a connection that Psychic then overwrites. Specs use this
 * helper to express the config a real app would want to write.
 */
export function nativeWorkerOptions(
  options: Omit<Partial<BullMQNativeWorkerOptions>, 'connection'> = {},
): BullMQNativeWorkerOptions {
  return options as BullMQNativeWorkerOptions
}
