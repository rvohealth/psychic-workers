import { Dream } from '@rvoh/dream'
import { BackgroundJobConfig, DelayedJobOpts } from '../types/background.js'
import { FunctionPropertyNames } from '../types/utils.js'
import { BackgroundableMethodArgs } from './BaseBackgroundedService.js'
import background from './index.js'
import durationToSeconds from '../helpers/durationToSeconds.js'

export default class BaseBackgroundedModel extends Dream {
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
  public static get backgroundJobConfig(): BackgroundJobConfig<BaseBackgroundedModel> {
    return {}
  }

  /**
   * @internal
   *
   * shadows the static `backgroundJobConfig` getter provided by the user.
   * This should never be overridden, and is meant to provide easy access
   * to the config from within an instance.
   */
  protected get backgroundJobConfig(): BackgroundJobConfig<BaseBackgroundedModel> {
    const klass = this.constructor as typeof BaseBackgroundedModel
    return klass.backgroundJobConfig
  }

  /**
   * runs the specified method in a background queue, driven by BullMQ,
   * sending in the provided args.
   *
   * ```ts
   * await User.background('myMethod', 'abc', 123)
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
    MethodName extends PsychicBackgroundedModelStaticMethods<T & typeof BaseBackgroundedModel>,
    MethodFunc extends T[MethodName & keyof T],
    MethodArgs extends BackgroundableMethodArgs<MethodFunc>,
  >(this: T, methodName: MethodName, ...args: MethodArgs) {
    const safeThis: typeof BaseBackgroundedModel = this as typeof BaseBackgroundedModel

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
   * await User.backgroundWithDelay('myMethod', 'abc', 123)
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
    MethodName extends PsychicBackgroundedModelStaticMethods<T & typeof BaseBackgroundedModel>,
    MethodFunc extends T[MethodName & keyof T],
    MethodArgs extends BackgroundableMethodArgs<MethodFunc>,
  >(this: T, delay: DelayedJobOpts, methodName: MethodName, ...args: MethodArgs) {
    const safeThis: typeof BaseBackgroundedModel = this as typeof BaseBackgroundedModel

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

  /**
   * runs the specified method in a background queue, driven by BullMQ,
   * sending in the provided args.
   *
   * ```ts
   * const user = await User.lastOrFail()
   * await user.background('myMethod', 'abc', 123)
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
  public async background<
    T,
    MethodName extends PsychicBackgroundedServiceInstanceMethods<T & BaseBackgroundedModel>,
    MethodFunc extends T[MethodName & keyof T],
    MethodArgs extends BackgroundableMethodArgs<MethodFunc>,
  >(this: T, methodName: MethodName, ...args: MethodArgs) {
    const safeThis: BaseBackgroundedModel = this as BaseBackgroundedModel

    return await background.modelInstanceMethod(safeThis, methodName, {
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
   * const user = await User.lastOrFail()
   * await user.backgroundWithDelay('myMethod', 'abc', 123)
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
  public async backgroundWithDelay<
    T,
    MethodName extends PsychicBackgroundedServiceInstanceMethods<T & BaseBackgroundedModel>,
    MethodFunc extends T[MethodName & keyof T],
    MethodArgs extends BackgroundableMethodArgs<MethodFunc>,
  >(this: T, delay: DelayedJobOpts, methodName: MethodName, ...args: MethodArgs) {
    const safeThis: BaseBackgroundedModel = this as BaseBackgroundedModel

    return await background.modelInstanceMethod(safeThis, methodName, {
      args,
      delaySeconds: durationToSeconds(delay),
      jobId: delay.jobId,
      jobConfig: safeThis.backgroundJobConfig,
    })
  }
}

export type PsychicBackgroundedModelStaticMethods<T extends typeof BaseBackgroundedModel> = Exclude<
  FunctionPropertyNames<Required<T>>,
  FunctionPropertyNames<typeof BaseBackgroundedModel>
>

export type PsychicBackgroundedServiceInstanceMethods<T extends BaseBackgroundedModel> = Exclude<
  FunctionPropertyNames<Required<T>>,
  FunctionPropertyNames<BaseBackgroundedModel>
>
