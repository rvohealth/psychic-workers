import BaseScheduledService from '../../../../src/background/BaseScheduledService.js'
import psychicWorkerTypes from '../../types/workers.js'

export default class ApplicationScheduledService extends BaseScheduledService {
  public override get psychicWorkerTypes() {
    return psychicWorkerTypes
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public static classRunInBg(arg1: any) {
    if (arg1) {
      // noop
    }
  }
}
