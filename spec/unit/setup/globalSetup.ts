import '../../../test-app/src/conf/loadEnv.js'

import initializePsychicApp from '../../../test-app/src/cli/helpers/initializePsychicApp.js'
import rmTmpFile from '../../helpers/rmTmpFile.js'

export async function setup() {
  await initializePsychicApp()
}

export async function teardown() {
  await rmTmpFile()
}
