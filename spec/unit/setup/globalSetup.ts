import '../../../test-app/src/conf/loadEnv'

import initializePsychicApplication from '../../../test-app/src/cli/helpers/initializePsychicApplication'
import rmTmpFile from '../../helpers/rmTmpFile'

export async function setup() {
  await initializePsychicApplication()
}

export async function teardown() {
  await rmTmpFile()
}
