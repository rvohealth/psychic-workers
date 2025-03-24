import { BaseBackgroundedService } from '../../../../src/index.js'
import psychicTypes from '../../types/psychic.js'

export default class ApplicationBackgroundedService extends BaseBackgroundedService {
  public get psychicTypes() {
    return psychicTypes
  }
}
