import fs from 'fs/promises'
import path from 'path'
import { PsychicApplicationWorkers } from '../../src'

export default async function rmTmpFile() {
  try {
    const psychicWorkersApp = PsychicApplicationWorkers.getOrFail()
    return await fs.rm(path.join(psychicWorkersApp.psychicApp.apiRoot, 'spec/tmp.txt'))
  } catch {
    //
  }
}
