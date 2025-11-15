import fs from 'node:fs/promises'
import path from 'node:path'
import PsychicAppWorkers from '../../../../src/psychic-app-workers/index.js'
import { BackgroundJobConfig } from '../../../../src/types/background.js'
import ApplicationBackgroundedService from './ApplicationBackgroundedService.js'

export default class LastDummyServiceInNamedWorkstream extends ApplicationBackgroundedService {
  public static override get backgroundJobConfig(): BackgroundJobConfig<ApplicationBackgroundedService> {
    return { priority: 'last', workstream: 'snazzy' }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public static async classRunInBG(arg: any) {
    const psychicWorkersApp = PsychicAppWorkers.getOrFail()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await fs.writeFile(path.join(psychicWorkersApp.psychicApp.apiRoot, 'spec', 'tmp.txt'), arg)
  }
}
