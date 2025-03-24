import { BackgroundJobConfig } from '../../../../src/index.js'
import ApplicationScheduledService from './ApplicationScheduledService.js'

export default class LastDummyScheduledService extends ApplicationScheduledService {
  public static get backgroundJobConfig(): BackgroundJobConfig<ApplicationScheduledService> {
    return { priority: 'last' }
  }
}
