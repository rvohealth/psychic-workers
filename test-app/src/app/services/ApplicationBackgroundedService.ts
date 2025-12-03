import { BaseBackgroundedService } from '../../../../src/package-exports/index.js'
import psychicWorkerTypes from '../../types/workers.js'

export default class ApplicationBackgroundedService extends BaseBackgroundedService {
  public override get psychicWorkerTypes() {
    return psychicWorkerTypes
  }
}
