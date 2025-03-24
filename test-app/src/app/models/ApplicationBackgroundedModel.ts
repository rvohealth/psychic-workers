import BaseBackgroundedModel from '../../../../src/background/BaseBackgroundedModel.js'
import { BackgroundJobConfig } from '../../../../src/index.js'
import { DBClass } from '../../types/db.js'
import { globalSchema, schema } from '../../types/dream.js'
import psychicTypes from '../../types/psychic.js'

export default class ApplicationBackgroundedModel extends BaseBackgroundedModel {
  public DB: DBClass

  public static get backgroundJobConfig(): BackgroundJobConfig<BaseBackgroundedModel> {
    return {}
  }

  public get schema() {
    return schema
  }

  public get globalSchema() {
    return globalSchema
  }

  public get psychicTypes() {
    return psychicTypes
  }
}
