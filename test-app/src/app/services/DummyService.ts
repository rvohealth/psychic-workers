import { Job } from 'bullmq'
import fs from 'fs/promises'
import path from 'path'
import { PsychicApplicationWorkers } from '../../../../src'
import ApplicationBackgroundedService from './ApplicationBackgroundedService'

export default class DummyService extends ApplicationBackgroundedService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public static async classRunInBG(arg: any) {
    const psychicWorkersApp = PsychicApplicationWorkers.getOrFail()
    await fs.writeFile(path.join(psychicWorkersApp.psychicApp.apiRoot, 'spec/tmp.txt'), `${arg}`)
  }

  public static async classRunInBGWithJobArg(arg: 'bottlearum', job: Job) {
    const psychicWorkersApp = PsychicApplicationWorkers.getOrFail()
    await fs.writeFile(path.join(psychicWorkersApp.psychicApp.apiRoot, 'spec/tmp.txt'), `${arg},${job.name}`)
  }
}
