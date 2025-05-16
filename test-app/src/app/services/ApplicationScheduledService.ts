import BaseScheduledService from '../../../../src/background/BaseScheduledService.js'
import psychicTypes from '../../types/psychic.js'

export default class ApplicationScheduledService extends BaseScheduledService {
  public override get psychicTypes() {
    return psychicTypes
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public static classRunInBg(arg1: any) {
    if (arg1) {
      // noop
    }
  }
}
