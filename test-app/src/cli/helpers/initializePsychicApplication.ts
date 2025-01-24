import '../../conf/global'

import psychicConf from '../../conf/app'
import dreamConf from '../../conf/dream'
import workersConf from '../../conf/workers'
import { PsychicApplication, PsychicApplicationInitOptions } from '@rvohealth/psychic'
import { PsychicApplicationWorkers } from '../../../../src'

export default async function initializePsychicApplication(opts: PsychicApplicationInitOptions = {}) {
  const psychicApp = await PsychicApplication.init(psychicConf, dreamConf, opts)
  await PsychicApplicationWorkers.init(psychicApp, workersConf)
  return psychicApp
}
