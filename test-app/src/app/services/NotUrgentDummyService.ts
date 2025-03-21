import fs from 'fs/promises'
import path from 'path'
import { BackgroundJobConfig, PsychicApplicationWorkers } from '../../../../src'
import ApplicationBackgroundedService from './ApplicationBackgroundedService'

export default class NotUrgentDummyService extends ApplicationBackgroundedService {
  public static get backgroundJobConfig(): BackgroundJobConfig<ApplicationBackgroundedService> {
    return { priority: 'not_urgent' }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public static async classRunInBG(arg: any) {
    const psychicWorkersApp = PsychicApplicationWorkers.getOrFail()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await fs.writeFile(path.join(psychicWorkersApp.psychicApp.apiRoot, 'spec/tmp.txt'), arg)
  }
}
