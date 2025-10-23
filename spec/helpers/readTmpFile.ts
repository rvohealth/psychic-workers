import fs from 'node:fs/promises'
import path from 'node:path'
import PsychicAppWorkers from '../../src/psychic-app-workers/index.js'

export default async function readTmpFile() {
  const psychicWorkersApp = PsychicAppWorkers.getOrFail()
  return (await fs.readFile(path.join(psychicWorkersApp.psychicApp.apiRoot, 'spec', 'tmp.txt'))).toString()
}
