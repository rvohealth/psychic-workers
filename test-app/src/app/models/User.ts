import { DreamColumn, DreamSerializers } from '@rvohealth/dream'
import ApplicationModel from './ApplicationModel'
import { Job } from 'bullmq'

export default class User extends ApplicationModel {
  public get table() {
    return 'users' as const
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
