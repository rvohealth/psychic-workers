import { BackgroundJobConfig } from '../../../../src/types/background.js'
import ApplicationScheduledService from './ApplicationScheduledService.js'

export default class UrgentDummyScheduledService extends ApplicationScheduledService {
  public static override get backgroundJobConfig(): BackgroundJobConfig<ApplicationScheduledService> {
    return { priority: 'urgent' }
  }
}
