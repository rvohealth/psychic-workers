import { Job } from 'bullmq'
import fs from 'node:fs/promises'
import path from 'node:path'
import PsychicAppWorkers from '../../../../src/psychic-app-workers/index.js'
import ApplicationBackgroundedService from './ApplicationBackgroundedService.js'

export default class DummyService extends ApplicationBackgroundedService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public static async classRunInBG(arg: any) {
    const psychicWorkersApp = PsychicAppWorkers.getOrFail()
    await fs.writeFile(path.join(psychicWorkersApp.psychicApp.apiRoot, 'spec', 'tmp.txt'), `${arg}`)
  }

  public static async classRunInBGWithJobArg(arg: 'bottlearum', job: Job) {
    const psychicWorkersApp = PsychicAppWorkers.getOrFail()
    await fs.writeFile(
      path.join(psychicWorkersApp.psychicApp.apiRoot, 'spec', 'tmp.txt'),
      `${arg},${job.name}`,
    )
  }
}
