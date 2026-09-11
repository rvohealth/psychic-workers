import BaseBackgroundedService from '../background/BaseBackgroundedService.js'
import BaseScheduledService from '../background/BaseScheduledService.js'
import {
  PsychicBackgroundNativeBullMQOptions,
  PsychicBackgroundSimpleOptions,
} from '../psychic-app-workers/index.js'
import { Either } from './utils.js'

export interface BackgroundJobData {
  /**
   * the id of the background job. This is provided by BullMQ
   */
  id?: string | number

  /**
   * the method name of the method on the provided class
   */
  method?: string

  /**
   * the arguments that are fed into your background job
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any

  /**
   * the path to the file containing the class you are backgrounding
   */
  filepath?: string

  /**
   * the import key of the class, which will be 'default' if the class is the default
   * export of the file, and will otherwise be the name of the exported class.
   */
  importKey?: string

  /**
   * the globalName value of the service that is being backgrounded.
   */
  globalName?: string
}

export type DelayedJobOpts = DelayedJobDuration & {
  /**
   * a unique identifier for your job. this identifier will be
   * used to debounce, leveraging the internal throttling mechanisms
   * provided by BullMQ
   */
  jobId?: string
}

export interface DelayedJobDuration {
  seconds?: number
  minutes?: number
  hours?: number
  days?: number
}

export type JobTypes =
  | 'BackgroundJobQueueFunctionJob'
  | 'BackgroundJobQueueStaticJob'
  | 'BackgroundJobQueueModelInstanceJob'

export type BackgroundQueuePriority = 'default' | 'urgent' | 'not_urgent' | 'last'

/**
 * The secret-free logical queue route stored in a Psychic job scheduler
 * locator and reported by scheduler inventory.
 */
export type PsychicJobSchedulerRoute =
  | {
      /** Selects the application's configured default background queue. */
      kind: 'default'
    }
  | {
      /** Selects a configured named workstream or native BullMQ queue. */
      kind: 'named'
      /** The configured logical workstream or native queue name. */
      name: string
    }

/**
 * Identifies the exact configured queue origin where a scheduler was observed.
 *
 * Origins are suitable for immediate inventory-driven removal. They are not
 * portable across application initialization generations; persist
 * {@link PsychicJobScheduler.locator} instead.
 */
export interface PsychicJobSchedulerOrigin {
  /**
   * An opaque token binding this origin to the `Background` instance that
   * produced it.
   */
  generation: string

  /** Whether the queue came from the current or transitional topology. */
  source: 'current' | 'transitional'

  /** The secret-free logical route configured for the queue. */
  route: PsychicJobSchedulerRoute
}

/**
 * Framework-owned metadata for a Psychic scheduled static job.
 *
 * Inventory rows omit serialized arguments, Redis connections, BullMQ queue
 * objects, and BullMQ scheduler DTOs. The metadata is a point-in-time
 * observation and may be stale by the time it is used. Removing the represented
 * scheduler deletes its pending delayed occurrence and prevents BullMQ from
 * emitting later ones. It does not cancel an occurrence already released from
 * that scheduler into queue-managed work; that occurrence may still execute
 * regardless of its current BullMQ state, for example waiting, prioritized,
 * paused, active, or awaiting retry.
 */
export interface PsychicJobScheduler {
  /**
   * The opaque, portable locator used for route-wide unscheduling. This is the
   * value to persist when the concrete scheduled-service class may be removed.
   */
  locator: string

  /** The Psychic global name of the scheduled service. */
  globalName: string

  /** The scheduled static method name. */
  method: string

  /** The registered cron pattern. */
  pattern: string

  /** The next scheduled occurrence as Unix epoch milliseconds, when known. */
  nextRunAt?: number

  /** The exact configured queue origin where this scheduler was observed. */
  origin: PsychicJobSchedulerOrigin
}

export interface BackgroundWithOpts {
  /**
   * an optional delay to hold off the job for a certain amount of
   * time after it is entered into the queue. Accepts the same options
   * as `backgroundWithDelay`, including an optional `jobId` which
   * debounces repeated calls within the delay window.
   */
  delay?: DelayedJobOpts

  /**
   * an optional priority. When provided, this overrides the priority
   * set on the `backgroundJobConfig` of the service or model.
   */
  priority?: BackgroundQueuePriority
}

interface BaseBackgroundJobConfig {
  priority?: BackgroundQueuePriority
  // TODO: accept T generic, if BaseScheduledService,
  // add 'scheduleOpts?: JobSchedulerTemplateOptions'
}

export interface WorkstreamBackgroundJobConfig<T extends BaseScheduledService | BaseBackgroundedService>
  extends BaseBackgroundJobConfig {
  workstream?: T['psychicWorkerTypes']['workstreamNames'][number]
}

export interface QueueBackgroundJobConfig<
  T extends BaseScheduledService | BaseBackgroundedService,
  WorkerTypes extends T['psychicWorkerTypes'] = T['psychicWorkerTypes'],
  QueueGroupMap = WorkerTypes['queueGroupMap'],
  Queue extends keyof QueueGroupMap & string = keyof QueueGroupMap & string,
  Groups extends QueueGroupMap[Queue] = QueueGroupMap[Queue],
  GroupId = Groups[number & keyof Groups],
> extends BaseBackgroundJobConfig {
  groupId?: GroupId
  queue?: Queue
}

export type BackgroundJobConfig<T extends BaseScheduledService | BaseBackgroundedService> = Either<
  WorkstreamBackgroundJobConfig<T>,
  QueueBackgroundJobConfig<T>
>

export type PsychicBackgroundOptions =
  | (PsychicBackgroundSimpleOptions &
      Partial<
        Record<
          Exclude<keyof PsychicBackgroundNativeBullMQOptions, keyof PsychicBackgroundSimpleOptions>,
          never
        >
      >)
  | (PsychicBackgroundNativeBullMQOptions &
      Partial<
        Record<
          Exclude<keyof PsychicBackgroundSimpleOptions, keyof PsychicBackgroundNativeBullMQOptions>,
          never
        >
      >)
