import fs from 'node:fs/promises'
import path from 'node:path'
import { PsychicApplicationWorkers } from '../../src/index.js'

export default async function readTmpFile() {
  const psychicWorkersApp = PsychicApplicationWorkers.getOrFail()
  return (await fs.readFile(path.join(psychicWorkersApp.psychicApp.apiRoot, 'spec/tmp.txt'))).toString()
}
