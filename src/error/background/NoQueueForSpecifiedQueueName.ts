export default class NoQueueForSpecifiedQueueName extends Error {
  constructor(private queue: string) {
    super()
  }

  public override get message() {
    return `Error enqueueing background job
No queue matches "${this.queue}"
`
  }
}
