import '../../conf/global.js'

import { PsychicApp, PsychicAppInitOptions } from '@rvoh/psychic'
import { PsychicAppWorkers } from '../../../../src/index.js'
import psychicConf from '../../conf/app.js'
import dreamConf from '../../conf/dream.js'
import workersConf from '../../conf/workers.js'

export default async function initializePsychicApp(opts: PsychicAppInitOptions = {}) {
  const psychicApp = await PsychicApp.init(psychicConf, dreamConf, opts)
  await PsychicAppWorkers.init(psychicApp, workersConf)
  return psychicApp
}
