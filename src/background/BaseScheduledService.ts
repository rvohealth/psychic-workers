import { GlobalNameNotSet } from '@rvoh/dream'
import { BackgroundJobConfig } from '../types/background.js'
import { FunctionPropertyNames } from '../types/utils.js'
import background from './index.js'

export default class BaseScheduledService {
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
  public static get backgroundJobConfig(): BackgroundJobConfig<BaseScheduledService> {
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
   * Schedules a job to be run repeatedly at a certain cron interval
   * sending in the provided args.
   *
   * ```ts
   * await MySchedulableClass.schedule('0 * * * *', 'myHourlyMethod', 'abc', 123)
   * ```
   * though calling background must be awaited, the resolution of the promise
   * is an indication that the job was put in the queue, not that it has
   * completed.
   *
   * NOTE: in test environments, psychic will immediately invoke the underlying
   * method, preventing you from needing to explicitly wait for queues to flush
   * before making assertions.
   *
   * @param pattern - A cron string representing the time interval you wish this to run on
   * @param methodName - the name of the static method you wish to run in the background
   * @param args - a variadic list of arguments to be sent to your method
   */
  public static async schedule<
    T,
    MethodName extends FunctionPropertyNames<Required<T>>,
    MethodFunc extends T[MethodName & keyof T],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    MethodArgs extends MethodFunc extends (...args: any) => any ? Parameters<MethodFunc> : never,
  >(this: T, pattern: string, methodName: MethodName, ...args: MethodArgs) {
    const safeThis: typeof BaseScheduledService = this as typeof BaseScheduledService

    return await background.scheduledMethod(safeThis, pattern, methodName, {
      globalName: safeThis.globalName,
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

export type PsychicScheduledServiceStaticMethods<T extends typeof BaseScheduledService> = Exclude<
  FunctionPropertyNames<Required<T>>,
  FunctionPropertyNames<typeof BaseScheduledService>
>
