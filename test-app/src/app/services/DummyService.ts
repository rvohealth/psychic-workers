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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public constructorArg: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(arg: any) {
    super()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    this.constructorArg = arg
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async instanceRunInBG(arg: any, job: Job) {
    await this.instanceMethodToTest(this.constructorArg, arg, job)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async instanceMethodToTest(a: any, b: any, job: Job) {
    const psychicWorkersApp = PsychicApplicationWorkers.getOrFail()
    await fs.writeFile(
      path.join(psychicWorkersApp.psychicApp.apiRoot, 'spec/tmp.txt'),
      `${a},${b},${job.name}`,
    )
  }

  public static async classRunInBGWithJobArg(arg: 'bottlearum', job: Job) {
    const psychicWorkersApp = PsychicApplicationWorkers.getOrFail()
    await fs.writeFile(path.join(psychicWorkersApp.psychicApp.apiRoot, 'spec/tmp.txt'), `${arg},${job.name}`)
  }
}
