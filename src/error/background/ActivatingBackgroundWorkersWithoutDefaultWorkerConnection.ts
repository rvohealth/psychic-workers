export default class ActivatingBackgroundWorkersWithoutDefaultWorkerConnection extends Error {
  public override get message() {
    return `
defaultWorkerConnection is required when activating workers. For example,
it may be omitted on webserver instances, but is required on worker instances.
`
  }
}
