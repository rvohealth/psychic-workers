import { Dream } from '@rvohealth/dream'
import background, { BackgroundJobConfig } from './index.js'
import { BackgroundableMethodArgs } from './BaseBackgroundedService.js'
import { FunctionPropertyNames } from './types.js'

export default class BaseBackgroundedModel extends Dream {
  public static get backgroundJobConfig(): BackgroundJobConfig<BaseBackgroundedModel> {
    return {}
  }

  public get backgroundJobConfig(): BackgroundJobConfig<BaseBackgroundedModel> {
    const klass = this.constructor as typeof BaseBackgroundedModel
    return klass.backgroundJobConfig
  }

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

  public static async backgroundWithDelay<
    T,
    MethodName extends PsychicBackgroundedModelStaticMethods<T & typeof BaseBackgroundedModel>,
    MethodFunc extends T[MethodName & keyof T],
    MethodArgs extends BackgroundableMethodArgs<MethodFunc>,
  >(this: T, delaySeconds: number, methodName: MethodName, ...args: MethodArgs) {
    const safeThis: typeof BaseBackgroundedModel = this as typeof BaseBackgroundedModel

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

  public async backgroundWithDelay<
    T,
    MethodName extends PsychicBackgroundedServiceInstanceMethods<T & BaseBackgroundedModel>,
    MethodFunc extends T[MethodName & keyof T],
    MethodArgs extends BackgroundableMethodArgs<MethodFunc>,
  >(this: T, delaySeconds: number, methodName: MethodName, ...args: MethodArgs) {
    const safeThis: BaseBackgroundedModel = this as BaseBackgroundedModel

    return await background.modelInstanceMethod(safeThis, methodName, {
      args,
      delaySeconds,
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
