import fs from 'node:fs/promises'
import path from 'node:path'
import { PsychicApplicationWorkers } from '../../src/index.js'

export default async function rmTmpFile() {
  try {
    const psychicWorkersApp = PsychicApplicationWorkers.getOrFail()
    return await fs.rm(path.join(psychicWorkersApp.psychicApp.apiRoot, 'spec', 'tmp.txt'))
  } catch {
    //
  }
}
