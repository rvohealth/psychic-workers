import '../../../test-app/src/conf/loadEnv.js'

import rmTmpFile from '../../helpers/rmTmpFile.js'

export async function setup() {}

export async function teardown() {
  await rmTmpFile()
}
