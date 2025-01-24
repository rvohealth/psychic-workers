import fs from 'fs/promises'
import path from 'path'
import { PsychicApplicationWorkers } from '../../src'

export default async function readTmpFile() {
  const psychicWorkersApp = PsychicApplicationWorkers.getOrFail()
  return (await fs.readFile(path.join(psychicWorkersApp.psychicApp.apiRoot, 'spec/tmp.txt'))).toString()
}
