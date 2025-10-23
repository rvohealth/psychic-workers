import { BackgroundJobConfig } from '../../../../src/types/background.js'
import ApplicationScheduledService from './ApplicationScheduledService.js'

export default class NotUrgentDummyScheduledService extends ApplicationScheduledService {
  public static override get backgroundJobConfig(): BackgroundJobConfig<ApplicationScheduledService> {
    return { priority: 'not_urgent' }
  }
}
