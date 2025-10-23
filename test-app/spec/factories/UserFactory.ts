import { UpdateableProperties } from '@rvoh/dream/types'
import User from '../../src/app/models/User.js'

let counter = 0

export default async function createUser(attrs: UpdateableProperties<User> = {}) {
  attrs.email ||= `User email ${++counter}`
  return await User.create(attrs)
}
