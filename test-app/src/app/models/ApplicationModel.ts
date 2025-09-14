import { Dream } from '@rvoh/dream'
import { DBClass } from '../../types/db.js'
import { globalTypeConfig } from '../../types/dream.globals.js'
import { connectionTypeConfig, schema } from '../../types/dream.js'

export default class ApplicationModel extends Dream {
  declare public DB: DBClass

  public override get schema() {
    return schema
  }

  public override get connectionTypeConfig() {
    return connectionTypeConfig
  }

  public override get globalTypeConfig() {
    return globalTypeConfig
  }
}
