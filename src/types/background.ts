import { IdType } from '@rvoh/dream'
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
  id?: IdType

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

export type JobTypes =
  | 'BackgroundJobQueueFunctionJob'
  | 'BackgroundJobQueueStaticJob'
  | 'BackgroundJobQueueModelInstanceJob'

export type BackgroundQueuePriority = 'default' | 'urgent' | 'not_urgent' | 'last'

interface BaseBackgroundJobConfig {
  priority?: BackgroundQueuePriority
}

export interface WorkstreamBackgroundJobConfig<T extends BaseScheduledService | BaseBackgroundedService>
  extends BaseBackgroundJobConfig {
  workstream?: T['psychicTypes']['workstreamNames'][number]
}

export interface QueueBackgroundJobConfig<
  T extends BaseScheduledService | BaseBackgroundedService,
  PsyTypes extends T['psychicTypes'] = T['psychicTypes'],
  QueueGroupMap = PsyTypes['queueGroupMap'],
  Queue extends keyof QueueGroupMap = keyof QueueGroupMap,
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
