import { GlobalNameNotSet } from '@rvohealth/dream'
import { Job } from 'bullmq'
import background, { BackgroundJobConfig } from './index.js'
import { FunctionPropertyNames } from './types.js'

export default class BaseBackgroundedService {
  public static get backgroundJobConfig(): BackgroundJobConfig<BaseBackgroundedService> {
    return {}
  }

  public static get globalName(): string {
    if (!this._globalName) throw new GlobalNameNotSet(this)
    return this._globalName
  }

  public static setGlobalName(globalName: string) {
    this._globalName = globalName
  }
  private static _globalName: string | undefined

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

  public static async backgroundWithDelay<
    T,
    MethodName extends PsychicBackgroundedServiceStaticMethods<T & typeof BaseBackgroundedService>,
    MethodFunc extends T[MethodName & keyof T],
    MethodArgs extends BackgroundableMethodArgs<MethodFunc>,
  >(this: T, delaySeconds: number, methodName: MethodName, ...args: MethodArgs) {
    const safeThis: typeof BaseBackgroundedService = this as typeof BaseBackgroundedService

    return await background.staticMethod(safeThis, methodName, {
      globalName: safeThis.globalName,
      delaySeconds,
      args,
      jobConfig: safeThis.backgroundJobConfig,
    })
  }

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
