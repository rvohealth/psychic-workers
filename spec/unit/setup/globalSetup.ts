import '../../../test-app/src/conf/loadEnv.js'

import initializePsychicApplication from '../../../test-app/src/cli/helpers/initializePsychicApplication.js'
import rmTmpFile from '../../helpers/rmTmpFile.js'

export async function setup() {
  await initializePsychicApplication()
}

export async function teardown() {
  await rmTmpFile()
}
