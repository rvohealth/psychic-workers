import '../../conf/global.js'

import { PsychicApplication, PsychicApplicationInitOptions } from '@rvoh/psychic'
import { PsychicApplicationWorkers } from '../../../../src/index.js'
import psychicConf from '../../conf/app.js'
import dreamConf from '../../conf/dream.js'
import workersConf from '../../conf/workers.js'

export default async function initializePsychicApplication(opts: PsychicApplicationInitOptions = {}) {
  const psychicApp = await PsychicApplication.init(psychicConf, dreamConf, opts)
  await PsychicApplicationWorkers.init(psychicApp, workersConf)
  return psychicApp
}
