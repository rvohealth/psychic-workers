import { GlobalNameNotSet } from '@rvoh/dream/errors'
import { Job } from 'bullmq'
import durationToSeconds from '../helpers/durationToSeconds.js'
import { BackgroundJobConfig, BackgroundWithOpts, DelayedJobOpts } from '../types/background.js'
import { FunctionPropertyNames } from '../types/utils.js'
import background from './index.js'

export default class BaseBackgroundedService {
  /**
   * A getter meant to be overridden in child classes. This does
   * not have to be explicitly provided, but if so, it would allow
   * you to override the default behavior of anything backgrounded
   * by this service, such as the priority or workstream.
   *
   * @returns {object} config - the background job config
   * @returns {string} config.priority - 'default' | 'urgent' | 'not_urgent' | 'last'
   * @returns {string} config.workstream - a workstream name. This would be the name of a workstream, as defined in conf/workers.ts
   * @returns {string} config.queue - the name of the BullMQ queue you wish to connect to. This can only be provided if workstream is not provided.
   * @returns {string} config.groupId - the groupId of the BullMQ queue you wish to connect to. This can only be provided if workstream is not provided.
   */
  public static get backgroundJobConfig(): BackgroundJobConfig<BaseBackgroundedService> {
    return {}
  }

  /**
   * @internal
   *
   * Returns a unique global name for the given service.
   *
   * @returns A string representing a unique key for this service
   */
  public static get globalName(): string {
    if (!this._globalName) throw new GlobalNameNotSet(this)
    return this._globalName
  }

  /**
   * @internal
   *
   * Used by PsychicApplicationWorkers during the load process
   * for services to assign unique global names to each service
   * based on the file name of that model.
   */
  public static setGlobalName(globalName: string) {
    this._globalName = globalName
  }
  private static _globalName: string | undefined

  /**
   * runs the specified method in a background queue, driven by BullMQ,
   * sending in the provided args.
   *
   * ```ts
   * await MyBackgroundableClass.background('myMethod', 'abc', 123)
   * ```
   * Outside automatic test invocation, awaiting `background` confirms that
   * a run is queued or pending, not that the method has completed.
   *
   * In tests with `testInvocation: 'automatic'` (the default), Psychic invokes
   * the method immediately and awaits its completion.
   * With `testInvocation: 'manual'`, the job is queued for explicit processing
   * with `WorkerTestUtils.work()`.
   *
   * @param methodName - the name of the static method you wish to run in the background
   * @param args - a variadic list of arguments to be sent to your method
   */
  public static async background<
    T,
    MethodName extends PsychicBackgroundedServiceStaticMethods<T & typeof BaseBackgroundedService>,
    MethodFunc extends T[MethodName & keyof T],
    MethodArgs extends BackgroundableMethodArgs<MethodFunc>,
  >(this: T, methodName: MethodName, ...args: MethodArgs) {
    const safeThis: typeof BaseBackgroundedService = this as typeof BaseBackgroundedService

    return await background.staticMethod(safeThis, methodName, {
      globalName: safeThis.globalName,
      args,
      jobConfig: safeThis.backgroundJobConfig,
    })
  }

  /**
   * runs the specified method in a background queue, driven by BullMQ,
   * sending in the provided args, along with a delay object — one or more of
   * `{ seconds, minutes, hours, days }` — which holds the job off for that much
   * time after it is entered into the queue.
   *
   * The delay object also accepts an optional `jobId`, which turns the delay
   * into a **debounce**: repeated calls carrying the same `jobId` collapse into
   * a single execution, which runs once the delay has elapsed without another
   * call arriving. `jobId` is a deduplication key rather than a BullMQ job id.
   *
   * See {@link DelayedJobOpts.jobId}.
   *
   * ```ts
   * await MyBackgroundableClass.backgroundWithDelay({ minutes: 5 }, 'myMethod', 'abc', 123)
   * ```
   * Outside automatic test invocation, awaiting `backgroundWithDelay` confirms that
   * a run is queued or pending, not that the method has completed.
   *
   * In tests with `testInvocation: 'automatic'` (the default), Psychic invokes
   * the method immediately and awaits its completion, ignoring the delay.
   * With `testInvocation: 'manual'`, the job is queued for explicit processing
   * with `WorkerTestUtils.work()`, or `WorkerTestUtils.workScheduled()` when delayed.
   *
   * @deprecated use `backgroundWith({ delay }, methodName, ...args)` instead. This method will be removed in a future major version.
   *
   * @param delay - how long you want to hold off before allowing the job to run, given as at least one of `seconds`, `minutes`, `hours` or `days`, plus an optional `jobId` (a deduplication key) which debounces repeated calls into a single run
   * @param methodName - the name of the static method you wish to run in the background
   * @param args - a variadic list of arguments to be sent to your method
   */
  public static async backgroundWithDelay<
    T,
    MethodName extends PsychicBackgroundedServiceStaticMethods<T & typeof BaseBackgroundedService>,
    MethodFunc extends T[MethodName & keyof T],
    MethodArgs extends BackgroundableMethodArgs<MethodFunc>,
  >(this: T, delay: DelayedJobOpts, methodName: MethodName, ...args: MethodArgs) {
    const safeThis: typeof BaseBackgroundedService = this as typeof BaseBackgroundedService

    return await background.staticMethod(safeThis, methodName, {
      globalName: safeThis.globalName,
      delaySeconds: durationToSeconds(delay),
      jobId: delay.jobId,
      args,
      jobConfig: safeThis.backgroundJobConfig,
    })
  }

  /**
   * runs the specified method in a background queue, driven by BullMQ,
   * sending in the provided args, along with an options object which can
   * be used to delay the job and/or override the priority provided by
   * the `backgroundJobConfig` getter on this service.
   *
   * Adding a `jobId` to the delay turns it into a **debounce**: repeated calls
   * carrying the same `jobId` collapse into a single execution, which runs once
   * the delay has elapsed without another call arriving. `jobId` is a
   * deduplication key rather than a BullMQ job id.
   *
   * See {@link DelayedJobOpts.jobId}.
   *
   * ```ts
   * await MyBackgroundableClass.backgroundWith(
   *   { delay: { seconds: 30, jobId: 'my-unique-job-id' }, priority: 'urgent' },
   *   'myMethod',
   *   'abc',
   *   123,
   * )
   * ```
   * Outside automatic test invocation, awaiting `backgroundWith` confirms that
   * a run is queued or pending, not that the method has completed.
   *
   * In tests with `testInvocation: 'automatic'` (the default), Psychic invokes
   * the method immediately and awaits its completion, ignoring the delay.
   * With `testInvocation: 'manual'`, the job is queued for explicit processing
   * with `WorkerTestUtils.work()`, or `WorkerTestUtils.workScheduled()` when delayed.
   *
   * @param opts - options for backgrounding this job
   * @param opts.delay - (optional) how long you want to hold off before allowing the job to run, given as at least one of `seconds`, `minutes`, `hours` or `days`, plus an optional `jobId` (a deduplication key) which debounces repeated calls into a single run
   * @param opts.priority - (optional) a priority which, when provided, overrides the priority provided by `backgroundJobConfig`
   * @param methodName - the name of the static method you wish to run in the background
   * @param args - a variadic list of arguments to be sent to your method
   */
  public static async backgroundWith<
    T,
    MethodName extends PsychicBackgroundedServiceStaticMethods<T & typeof BaseBackgroundedService>,
    MethodFunc extends T[MethodName & keyof T],
    MethodArgs extends BackgroundableMethodArgs<MethodFunc>,
  >(this: T, opts: BackgroundWithOpts, methodName: MethodName, ...args: MethodArgs) {
    const safeThis: typeof BaseBackgroundedService = this as typeof BaseBackgroundedService

    return await background.staticMethod(safeThis, methodName, {
      globalName: safeThis.globalName,
      ...(opts.delay ? { delaySeconds: durationToSeconds(opts.delay), jobId: opts.delay.jobId } : {}),
      args,
      jobConfig: mergeBackgroundWithOptsIntoJobConfig(safeThis.backgroundJobConfig, opts),
    })
  }

  /**
   * types composed by psychic must be provided, since psychic-workers leverages
   * the sync command in psychic to read your backgroundable services and extract
   * metadata, which can be used to help provide types for the underlying methods
   * in psychic-workers.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public get psychicWorkerTypes(): any {
    throw new Error(
      'Must define psychicWorkerTypes getter in ApplicationBackgroundedService class within your application',
    )
  }
}

/**
 * @internal
 *
 * returns a copy of the provided job config, with the priority
 * replaced by the priority found in the `backgroundWith` opts,
 * if one was provided.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mergeBackgroundWithOptsIntoJobConfig<T extends BackgroundJobConfig<any>>(
  jobConfig: T,
  opts: BackgroundWithOpts,
): T {
  if (!opts.priority) return jobConfig
  return { ...jobConfig, priority: opts.priority }
}

export type PsychicBackgroundedServiceStaticMethods<T extends typeof BaseBackgroundedService> = Exclude<
  FunctionPropertyNames<Required<T>>,
  FunctionPropertyNames<typeof BaseBackgroundedService>
>

export type PsychicBackgroundedServiceInstanceMethods<T extends BaseBackgroundedService> = Exclude<
  FunctionPropertyNames<Required<T>>,
  FunctionPropertyNames<BaseBackgroundedService>
>

type OmitJobFromEndOfArguments<Original extends unknown[]> = Original extends [Job]
  ? // this [string] check after [Job] check is in case the backgrounded method accepts
    // an argument typed as `any`
    Original extends [string]
    ? Original
    : []
  : Original extends [...infer Rest, Job]
    ? // this string check after Job check is in case the backgrounded method accepts
      // an argument typed as `any`
      Original extends [...unknown[], string]
      ? Original
      : Rest
    : Original

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BackgroundableMethodArgs<MethodFunc> = MethodFunc extends (...args: any) => any
  ? OmitJobFromEndOfArguments<Parameters<MethodFunc>>
  : never
