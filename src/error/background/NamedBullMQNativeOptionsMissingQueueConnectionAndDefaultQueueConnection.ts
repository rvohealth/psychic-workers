export default class NamedBullMQNativeOptionsMissingQueueConnectionAndDefaultQueueConnection extends Error {
  constructor(private queueName: string) {
    super()
  }

  public override get message() {
    return `
Native BullMQ options don't include a default queue connection, and the
${this.queueName} queue does not include a queue connection
`
  }
}
