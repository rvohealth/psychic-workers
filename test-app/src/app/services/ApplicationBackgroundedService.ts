import { BaseBackgroundedService } from '../../../../src/package-exports/index.js'
import psychicTypes from '../../types/psychic.js'

export default class ApplicationBackgroundedService extends BaseBackgroundedService {
  public override get psychicTypes() {
    return psychicTypes
  }
}
