import { Attribute, DreamColumn, DreamSerializer } from '@rvohealth/dream'
import User from '../models/User'

export class UserSummarySerializer<DataType extends User, Passthrough extends object> extends DreamSerializer<
  DataType,
  Passthrough
> {
  @Attribute(User)
  public id: DreamColumn<User, 'id'>
}

export default class UserSerializer<
  DataType extends User,
  Passthrough extends object,
> extends UserSummarySerializer<DataType, Passthrough> {
  @Attribute(User)
  public email: DreamColumn<User, 'email'>
}
