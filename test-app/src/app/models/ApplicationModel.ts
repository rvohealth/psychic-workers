import { Dream } from '@rvoh/dream'
import { DBClass } from '../../types/db.js'
import { globalSchema, schema } from '../../types/dream.js'

export default class ApplicationModel extends Dream {
  declare public DB: DBClass

  public get schema() {
    return schema
  }

  public get globalSchema() {
    return globalSchema
  }
}
