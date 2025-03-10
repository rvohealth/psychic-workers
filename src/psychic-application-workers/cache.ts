import PsychicApplicationWorkers from './index.js'

let _psychicWorkersApp: PsychicApplicationWorkers | undefined = undefined

export function cachePsychicWorkersApplication(psychicWorkersApp: PsychicApplicationWorkers) {
  _psychicWorkersApp = psychicWorkersApp
}

export function getCachedPsychicWorkersApplication() {
  return _psychicWorkersApp
}

export function getCachedPsychicWorkersApplicationOrFail() {
  if (!_psychicWorkersApp)
    throw new Error(
      'must call `cachePsychicWorkersApplication` before loading cached psychic application workers',
    )
  return _psychicWorkersApp
}
