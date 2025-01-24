import { UpdateableProperties } from '@rvohealth/dream'
import User from '../../src/app/models/User'

let counter = 0

export default async function createUser(attrs: UpdateableProperties<User> = {}) {
  attrs.email ||= `User email ${++counter}`
  return await User.create(attrs)
}
