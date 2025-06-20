import { DreamApp } from '@rvoh/dream'
import { provideDreamViteMatchers, truncate } from '@rvoh/dream-spec-helpers'
import initializePsychicApp from '../../../test-app/src/cli/helpers/initializePsychicApp.js'
import { background } from '../../../src/index.js'
import rmTmpFile from '../../helpers/rmTmpFile.js'

provideDreamViteMatchers()

// define global context variable, setting it equal to describe
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
;(global as any).context = describe

// this is done so that the `@jest-mock/express` library can continue
// to function. Since jest and vi have near parity, this seems to work,
// though it is very hacky, and we should eventually back out of it.
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
;(global as any).jest = vi

beforeEach(async () => {
  try {
    await initializePsychicApp()
  } catch (error) {
    console.error(error)
    throw error
  }

  background.connect()

  try {
    await rmTmpFile()
  } catch {
    // noop
  }

  await truncate(DreamApp)
})
