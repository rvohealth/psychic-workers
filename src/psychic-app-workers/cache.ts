import PsychicAppWorkers from './index.js'

let _psychicWorkersApp: PsychicAppWorkers | undefined = undefined

export function cachePsychicWorkersApp(psychicWorkersApp: PsychicAppWorkers) {
  _psychicWorkersApp = psychicWorkersApp
}

export function getCachedPsychicWorkersApp() {
  return _psychicWorkersApp
}

export function getCachedPsychicWorkersAppOrFail() {
  if (!_psychicWorkersApp)
    throw new Error('must call `cachePsychicWorkersApp` before loading cached psychic application workers')
  return _psychicWorkersApp
}
