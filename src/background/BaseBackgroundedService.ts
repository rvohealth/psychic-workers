import { GlobalNameNotSet } from '@rvoh/dream'
import { Job } from 'bullmq'
import { BackgroundJobConfig, DelayedJobOpts } from '../types/background.js'
import { FunctionPropertyNames } from '../types/utils.js'
import background from './index.js'
import durationToSeconds from '../helpers/durationToSeconds.js'

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
   * @returns {string} config.queueId - the id of the BullMQ queue you wish to connect to. This can only be provided if workstream is not provided.
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
   * though calling background must be awaited, the resolution of the promise
   * is an indication that the job was put in the queue, not that it has
   * completed.
   *
   * NOTE: in test environments, psychic will immediately invoke the underlying
   * method, preventing you from needing to explicitly wait for queues to flush
   * before making assertions.
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
   * sending in the provided args, including a delay in seconds, which
   * can be used to hold off the job for a certain amount of time after
   * it is entered into the queue.
   *
   * ```ts
   * await MyBackgroundableClass.backgroundWithDelay('myMethod', 'abc', 123)
   * ```
   * though calling background must be awaited, the resolution of the promise
   * is an indication that the job was put in the queue, not that it has
   * completed.
   *
   * NOTE: in test environments, psychic will immediately invoke the underlying
   * method, preventing you from needing to explicitly wait for queues to flush
   * before making assertions.
   *
   * @param delaySeconds - the amount of time (in seconds) you want to hold off before allowing the job to run
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
   * types composed by psychic must be provided, since psychic-workers leverages
   * the sync command in psychic to read your backgroundable services and extract
   * metadata, which can be used to help provide types for the underlying methods
   * in psychic-workers.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public get psychicTypes(): any {
    throw new Error('Must define psychicTypes getter in BackgroundedService class within your application')
  }
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
