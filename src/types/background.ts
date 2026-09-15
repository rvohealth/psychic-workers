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
 * ## this is a debounce
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
 * That is what the feature is for: running an expensive thing once instead of
 * once per call. What the package promises is that a run happens *after the
 * last call* — not that every call produces a run, and not that any particular
 * call is the one that produced it.
 *
 * ## a delay always needs a duration
 *
 * A delay object must carry at least one of `seconds`, `minutes`, `hours` or
 * `days`. `{}` and `{ jobId: 'my-job' }` are compile errors, since a delay with
 * no duration delays nothing and a `jobId` with no duration deduplicates
 * nothing.
 */
export type DelayedJobOpts = AtLeastOneDelayedJobDuration & {
  /**
   * a **deduplication key**, which debounces repeated calls: see
   * `DelayedJobOpts` above for what that means. Everything below is the fine
   * print on that guarantee.
   *
   * ## it is not a job id
   *
   * Despite the name, this is not the BullMQ job id of the job that gets
   * enqueued, and `queue.getJob(jobId)` will not resolve the debounced job
   * through it. BullMQ stores it as a separate Redis key, whose real shape is
   * `<prefix>:<queueName>:de:<jobId>` — where `<queueName>` is this package's
   * own rewrite of the queue name you configured (see `nameToRedisQueueName`),
   * not the configured name itself. The matching read is
   * `queue.getDeduplicationJobId(jobId)`, which returns the id of the job the
   * key currently points at.
   *
   * ## the delay must be at least ten seconds
   *
   * A shorter delay is refused rather than accepted, and that floor is a
   * property of the mechanism rather than an arbitrary limit: below roughly ten
   * seconds, the time it takes a worker to promote and pick up a delayed job is
   * the same order of magnitude as the debounce window itself, so the window
   * stops describing anything a caller can reason about.
   *
   * ## the guarantee has a premise, and there is no knob
   *
   * The deduplication key is armed for one second less than the delay, so that
   * it dies before the job fires and a late call starts a new timer instead of
   * being dropped on the floor. That one second has to cover the round trip
   * that adds the job **and** the disagreement between the clock that stamped
   * the job's fire time and the clock that promotes it — together, not a second
   * of each. A Redis failover, an ioredis reconnect that buffers the add in its
   * offline queue, or a fork pause during `BGSAVE` will consume the whole
   * budget on its own, even with perfectly synchronised clocks. Where several
   * processes share one `jobId`, the fire time comes from the clock of whichever
   * process made the last call, so the premise must hold for the worst-clocked
   * of them. A deployment whose clocks or Redis round trips drift past that is
   * outside what this package can promise, and there is no option exposed to
   * widen the margin.
   *
   * Four things are worth knowing about that premise, because they decide what
   * a deployment can do about it:
   *
   * - **Only one direction of clock skew breaks it.** A *worker* clock ahead of
   *   the *producer* clock eats the margin; a worker clock behind it is
   *   harmless, since promotion simply happens late and the window shrinks. One
   *   producer with one bad clock is enough — no second producer is needed. A
   *   3s offset leaves a 2s window in which a call is swallowed after the job
   *   has run, with no network latency involved at all.
   * - **`enableOfflineQueue: false` is the one mitigation available.** The
   *   scaffolded `defaultQueueConnection` already sets it. With it, a command issued
   *   while the connection is down is rejected at the call site instead of
   *   being buffered and landing late — a visible failure rather than a silent
   *   swallow. It does not cover a half-open TCP connection to a dead master,
   *   so it narrows the hazard rather than removing it.
   * - **A failover is not bounded by one round trip.** When the margin is
   *   consumed by an outage, the exposure is the length of the outage. An 8s
   *   Sentinel failover on a 10s delay leaves roughly 6.9s during which every
   *   call for that `jobId` is swallowed after the job has already run — the
   *   original missed-run failure, scaled up.
   * - **Retries are safe.** A job that fails and is re-delayed cannot be
   *   swallowed: its key is long gone by then. Nor can a retry's finalization
   *   clobber a newer key, since finalization is a no-op while a key's TTL is
   *   still live. This is a hazard that looks real and does not materialise.
   *
   * ## the last second of the window does not deduplicate
   *
   * The margin has a cost, and it is the largest behavioural consequence of the
   * mechanism: because the key dies one second before the job fires, the last
   * second of every window deduplicates nothing. At the ten-second floor that
   * is 10% of the window; at an hour it is 0.03%.
   *
   * A caller whose cadence happens to land inside that band degrades from a
   * debounce to **no debounce at all**, not merely to an occasional extra run.
   * With `{ seconds: 10 }`: a call at 0.0 arms a key that expires at 9.0 for a
   * job due at 10.0; a call at 9.5 finds no key and starts a second job, due at
   * 19.5, while the first still runs at 10.0; a call at 19.0 does it again. Every
   * call produces a run.
   *
   * The lever is the delay. The margin is a flat second, so **longer delays are
   * strictly cheaper**: the dead band is a fixed width and shrinks as a fraction
   * of the window as the delay grows. A caller that cares about collapsing and
   * can tolerate a later run should widen the delay rather than tighten it.
   *
   * ## a collapsed call is silent
   *
   * When a call is collapsed, nothing marks it: no event is emitted, no flag is
   * returned, and the awaited call resolves indistinguishably from one that
   * enqueued. There is therefore no way to instrument around it. BullMQ's
   * `deduplicated` event is not that signal — it fires when a pending job is
   * successfully replaced, so it counts collapses, not the calls that were
   * dropped without one.
   *
   * ## a stalled worker stops the collapsing
   *
   * Collapsing only happens while the job is still waiting in the delayed set.
   * If promotion stalls — a rate-limited workstream, a paused worker, a
   * `concurrency: 1` worker stuck behind a long job, a deploy with no worker
   * running — the key expires while the job sits there, and for the rest of the
   * stall every call adds its own pending job rather than collapsing into the
   * existing one. Under the package's own framing that is a lost optimisation
   * rather than a failure: extra runs, not missing ones.
   *
   * ## reaching past this API invalidates the guarantee
   *
   * Promoting or re-delaying a debounced job by hand through `background.queues`
   * — `job.promote()`, `job.changeDelay()` — moves the job out from under its
   * deduplication key without touching the key, so subsequent calls are
   * collapsed into a job that is no longer pending and the run after the last
   * call never happens. Follow either with
   * `await queue.removeDeduplicationKey(jobId)` — that call takes the
   * deduplication key, which is this field. Removing the *job* needs no
   * follow-up: `queue.remove(job.id)` clears the key as part of removing the
   * job. Note the two different identifiers — `queue.remove` takes BullMQ's
   * generated job id, and handing it this deduplication key instead removes
   * neither the job nor the key.
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
   * deduplication key rather than a BullMQ job id, and a delay carrying one
   * must be at least ten seconds. See `DelayedJobOpts` for the full contract.
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
