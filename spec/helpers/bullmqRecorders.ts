import { Redis } from 'ioredis'
import { BullMQNativeWorkerOptions } from '../../src/package-exports/types.js'

/**
 * Test doubles for the BullMQ `Queue` and `Worker` classes, recording the
 * arguments they were constructed with so specs can assert on the queues and
 * workers a `Background#connect` call builds.
 *
 * They are provided to `Background` through the `Background.Queue` and
 * `Background.Worker` static getters, which exist as a seam for BullMQ Pro.
 */

export interface RecordedJobAdd {
  jobType: string
  jobData: unknown
  opts: Record<string, unknown>
}

export class RecordingQueue {
  public static instances: RecordingQueue[] = []

  public static reset() {
    RecordingQueue.instances = []
  }

  /**
   * every queue constructed since the last reset, excluding the throwaway
   * `TestQueue` that `Background#_addToQueue` builds when it short-circuits
   * job invocation in test mode. The name is owned by
   * `src/background/index.ts` (`new Background.Queue('TestQueue', ...)`) and is
   * not exported, so it is duplicated here.
   */
  public static get constructed(): RecordingQueue[] {
    return RecordingQueue.instances.filter(queue => queue.queueName !== 'TestQueue')
  }

  public adds: RecordedJobAdd[] = []
  public jobSchedulers: unknown[][] = []

  constructor(
    public queueName: string,
    public queueOptions: Record<string, unknown>,
  ) {
    RecordingQueue.instances.push(this)
  }

  public add(jobType: string, jobData: unknown, opts: Record<string, unknown>) {
    this.adds.push({ jobType, jobData, opts })
    return Promise.resolve(null)
  }

  /**
   * BullMQ's `Job` constructor binds `toKey` off the queue it is handed and
   * builds a `Scripts` instance from the queue's `keys`, so the recorder needs
   * both to stand in for the throwaway `TestQueue` that `Background#_addToQueue`
   * constructs when it short-circuits job invocation in test mode. Nothing ever
   * reaches Redis: the Job is only used to carry job data into `doWork`.
   */
  public keys: Record<string, string> = {}

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

export class RecordingWorker {
  public static instances: RecordingWorker[] = []

  public static reset() {
    RecordingWorker.instances = []
  }

  constructor(
    public queueName: string,
    public processor: unknown,
    public workerOptions: Record<string, unknown>,
  ) {
    RecordingWorker.instances.push(this)
  }

  public close() {
    return null
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
