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

/**
 * the delay to hold a job for and, when a `jobId` is provided, the debounce
 * that delay drives.
 *
 * Calling a delayed background method repeatedly with the same `jobId`
 * collapses those calls into a **single execution**. Each call slides the
 * pending job's fire time further out, and the job runs once, after the last
 * call, when the delay has finally elapsed without another call arriving.
 *
 * ```ts
 * // ten calls in quick succession; the report is generated once,
 * // ten seconds after the last of them
 * await Report.backgroundWith({ delay: { seconds: 10, jobId: `report-${user.id}` } }, 'generate', user.id)
 * ```
 *
 * A delay object must carry at least one of `seconds`, `minutes`, `hours` or
 * `days`. `{}` and `{ jobId: 'my-job' }` are compile errors, since a delay with
 * no duration delays nothing and a `jobId` with no duration deduplicates
 * nothing.
 */
export type DelayedJobOpts = AtLeastOneDelayedJobDuration & {
  /**
   * a **deduplication key**, which debounces repeated calls: calls carrying the
   * same `jobId` collapse into a single execution, which runs once the delay
   * has elapsed without another call arriving. The window runs from the last
   * call, not the first, so a burst is collapsed however long it lasts.
   *
   * Despite the name, this is not the BullMQ job id of the enqueued job, and
   * `queue.getJob(jobId)` will not resolve the debounced job through it. BullMQ
   * stores it as a separate Redis key; the matching read is
   * `queue.getDeduplicationJobId(jobId)`.
   *
   * A delay carrying a `jobId` must be **at least three seconds**, and a
   * shorter one is refused at enqueue.
   *
   * On a rate-limited workstream the delay must also clear the limiter's
   * spacing: `delay - 1s >= duration / max`, so a workstream limited to one job
   * a minute needs a 61-second delay. A delay that does not is refused at
   * enqueue, naming the queue, both limiter numbers and a delay that would
   * pass.
   */
  jobId?: string
}

/**
 * `DelayedJobDuration` with at least one of its fields made required, as a
 * union of the four ways to satisfy that. Deliberately not exported: it exists
 * only to narrow `DelayedJobOpts`, and `DelayedJobDuration` itself must stay
 * all-optional, since it is also the parameter type of the shared
 * `durationToSeconds` helper.
 */
type AtLeastOneDelayedJobDuration = {
  [Field in keyof DelayedJobDuration]-?: Required<Pick<DelayedJobDuration, Field>> &
    Partial<Omit<DelayedJobDuration, Field>>
}[keyof DelayedJobDuration]

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

export interface BackgroundWithOpts {
  /**
   * an optional delay to hold off the job for a certain amount of
   * time after it is entered into the queue. Accepts the same options
   * as `backgroundWithDelay`, and must carry at least one of `seconds`,
   * `minutes`, `hours` or `days`.
   *
   * Adding a `jobId` turns the delay into a **debounce**: repeated calls
   * carrying the same `jobId` collapse into a single execution, which runs
   * once the delay has elapsed without another call arriving. `jobId` is a
   * deduplication key rather than a BullMQ job id.
   *
   * See {@link DelayedJobOpts.jobId}.
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
