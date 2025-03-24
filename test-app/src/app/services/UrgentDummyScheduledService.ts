import { BackgroundJobConfig } from '../../../../src/index.js'
import ApplicationScheduledService from './ApplicationScheduledService.js'

export default class UrgentDummyScheduledService extends ApplicationScheduledService {
  public static get backgroundJobConfig(): BackgroundJobConfig<ApplicationScheduledService> {
    return { priority: 'urgent' }
  }
}
