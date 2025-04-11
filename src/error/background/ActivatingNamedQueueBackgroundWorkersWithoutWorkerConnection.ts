export default class ActivatingNamedQueueBackgroundWorkersWithoutWorkerConnection extends Error {
  constructor(private queueName: string) {
    super()
  }

  public get message() {
    return `
defaultWorkerConnection is missing, and the ${this.queueName} queue does not
specify a workerConnection. A worker connection isrequired when activating workers.
For example, it may be omitted on webserver instances, but is required on worker instances.
`
  }
}
