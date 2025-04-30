export default class DefaultBullMQNativeOptionsMissingQueueConnectionAndDefaultQueueConnection extends Error {
  public override get message() {
    return `
Native BullMQ options don't include a default queue connection, and the
default config does not include a queue connection
`
  }
}
