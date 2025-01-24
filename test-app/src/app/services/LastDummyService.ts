import fs from 'fs/promises'
import path from 'path'
import { BackgroundJobConfig, PsychicApplicationWorkers } from '../../../../src'
import ApplicationBackgroundedService from './ApplicationBackgroundedService'

export default class LastDummyService extends ApplicationBackgroundedService {
  public static get backgroundJobConfig(): BackgroundJobConfig<ApplicationBackgroundedService> {
    return { priority: 'last' }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public static async classRunInBG(arg: any) {
    const psychicWorkersApp = PsychicApplicationWorkers.getOrFail()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await fs.writeFile(path.join(psychicWorkersApp.psychicApp.apiRoot, 'spec/tmp.txt'), arg)
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
  public async instanceRunInBG(arg: any) {
    await this.instanceMethodToTest(this.constructorArg, arg)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async instanceMethodToTest(a: any, b: any) {
    const psychicWorkersApp = PsychicApplicationWorkers.getOrFail()
    await fs.writeFile(path.join(psychicWorkersApp.psychicApp.apiRoot, 'spec/tmp.txt'), `${a},${b}`)
  }
}
