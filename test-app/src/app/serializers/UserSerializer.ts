import { DreamSerializer } from '@rvoh/dream'
import User from '../models/User.js'

export const UserSummarySerializer = (user: User) => DreamSerializer(User, user).attribute('id')

const UserSerializer = (user: User) => UserSummarySerializer(user).attribute('email')

export default UserSerializer
