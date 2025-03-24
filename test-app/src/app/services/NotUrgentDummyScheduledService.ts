import { BackgroundJobConfig } from '../../../../src/index.js'
import ApplicationScheduledService from './ApplicationScheduledService.js'

export default class NotUrgentDummyScheduledService extends ApplicationScheduledService {
  public static get backgroundJobConfig(): BackgroundJobConfig<ApplicationScheduledService> {
    return { priority: 'not_urgent' }
  }
}
