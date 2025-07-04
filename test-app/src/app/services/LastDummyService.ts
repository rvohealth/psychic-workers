import fs from 'node:fs/promises'
import path from 'node:path'
import { BackgroundJobConfig, PsychicAppWorkers } from '../../../../src/index.js'
import ApplicationBackgroundedService from './ApplicationBackgroundedService.js'

export default class LastDummyService extends ApplicationBackgroundedService {
  public static override get backgroundJobConfig(): BackgroundJobConfig<ApplicationBackgroundedService> {
    return { priority: 'last' }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public static async classRunInBG(arg: any) {
    const psychicWorkersApp = PsychicAppWorkers.getOrFail()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await fs.writeFile(path.join(psychicWorkersApp.psychicApp.apiRoot, 'spec', 'tmp.txt'), arg)
  }
}
