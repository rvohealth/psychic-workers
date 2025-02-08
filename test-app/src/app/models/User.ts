import { DreamColumn, DreamSerializers } from '@rvohealth/dream'
import { Job } from 'bullmq'
import fs from 'fs/promises'
import path from 'path'
import { BackgroundJobConfig, PsychicApplicationWorkers } from '../../../../src'
import ApplicationBackgroundedModel from './ApplicationBackgroundedModel'

export default class User extends ApplicationBackgroundedModel {
  public get table() {
    return 'users' as const
  }

  public static get backgroundJobConfig(): BackgroundJobConfig<ApplicationBackgroundedModel> {
    return { priority: 'urgent', workstream: 'snazzy' }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async instanceRunInBG(arg: any, job: Job) {
    await this.instanceMethodToTest(arg, job)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async instanceMethodToTest(b: any, job: Job) {
    const psychicWorkersApp = PsychicApplicationWorkers.getOrFail()
    await fs.writeFile(path.join(psychicWorkersApp.psychicApp.apiRoot, 'spec/tmp.txt'), `${b},${job.name}`)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public static async classRunInBG(arg: any) {
    const psychicWorkersApp = PsychicApplicationWorkers.getOrFail()
    await fs.writeFile(path.join(psychicWorkersApp.psychicApp.apiRoot, 'spec/tmp.txt'), `${arg}`)
  }

  public static async classRunInBGWithJobArg(arg: 'bottlearum', job: Job) {
    const psychicWorkersApp = PsychicApplicationWorkers.getOrFail()
    await fs.writeFile(path.join(psychicWorkersApp.psychicApp.apiRoot, 'spec/tmp.txt'), `${arg},${job.name}`)
  }

  public get serializers(): DreamSerializers<User> {
    return {
      default: 'UserSerializer',
      summary: 'UserSummarySerializer',
    }
  }

  public id: DreamColumn<User, 'id'>
  public email: DreamColumn<User, 'email'>
  public createdAt: DreamColumn<User, 'createdAt'>
  public updatedAt: DreamColumn<User, 'updatedAt'>

  public async testBackground(arg: string, job: Job) {
    return await this._testBackground(this.id, arg, job)
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
  public async _testBackground(userId: any, arg: string, job: Job) {}
}
