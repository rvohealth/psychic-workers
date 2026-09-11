import { GlobalNameNotSet } from '@rvoh/dream/errors'
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
   * Returns the id that `schedule` registers a job under, which can be passed
   * to {@link BaseScheduledService.unschedule} to remove that job.
   *
   * The id is derived from the service's global name and the method name. It
   * performs no queue construction and no redis I/O, so it is safe to call
   * anywhere, including from a console in development.
   *
   * The intended workflow for deleting a scheduled service is to read the id
   * off the class before removing it:
   *
   * ```ts
   * MyScheduledService.unscheduleId('myHourlyMethod')
   * // => 'services/MyScheduledService:myHourlyMethod'
   * ```
   *
   * then check that string into a seed or migration and call `unschedule` with
   * it, which allows the class itself to be deleted in the same deploy.
   *
   * ```ts
   * await ApplicationScheduledService.unschedule('services/MyScheduledService:myHourlyMethod')
   * ```
   *
   * @param methodName - the name of the static method that was scheduled
   * @returns the id `schedule` registered this method under
   */
  public static unscheduleId<T, MethodName extends FunctionPropertyNames<Required<T>>>(
    this: T,
    methodName: MethodName,
  ): string {
    const safeThis: typeof BaseScheduledService = this as typeof BaseScheduledService

    return background.jobSchedulerId(safeThis.globalName, methodName)
  }

  /**
   * Removes a scheduled job, preventing it from being run again.
   *
   * ```ts
   * await MyScheduledService.unschedule(MyScheduledService.unscheduleId('myHourlyMethod'))
   * ```
   *
   * Since the id is just a string, it can also be checked into a seed or
   * migration, which allows the scheduled service class to be deleted in the
   * same deploy that stops its job:
   *
   * ```ts
   * await ApplicationScheduledService.unschedule('services/MyScheduledService:myHourlyMethod')
   * ```
   *
   * Every queue in your application is checked, so this finds the job whether
   * or not the service's workstream has changed since it was scheduled, and
   * whether it landed in a current or a transitional queue.
   *
   * NOTE: unscheduling stops future runs. It does not cancel a run that has
   * already been placed on a queue, so a final invocation may still happen.
   *
   * @param id - the id the job was scheduled under, from {@link BaseScheduledService.unscheduleId}
   * @returns true if a scheduled job was removed, false if none was found
   */
  public static async unschedule(id: string): Promise<boolean> {
    return await background.unschedule(id)
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
      'Must define psychicWorkerTypes getter in ApplicationScheduledService class within your application',
    )
  }
}

export type PsychicScheduledServiceStaticMethods<T extends typeof BaseScheduledService> = Exclude<
  FunctionPropertyNames<Required<T>>,
  FunctionPropertyNames<typeof BaseScheduledService>
>
