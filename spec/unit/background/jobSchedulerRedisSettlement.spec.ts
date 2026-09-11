import { Redis } from 'ioredis'
import { Background, PsychicAppWorkers } from '../../../src/package-exports/index.js'

describe('job scheduler Redis settlement', () => {
  function isolatedBackground(connection: Redis) {
    PsychicAppWorkers.getOrFail().set('background', {
      defaultQueueConnection: connection,
      defaultWorkerConnection: undefined,
    })
    const background = new Background()
    const locator = background.jobSchedulerIdentity('services/Digests', 'deliver').locator
    return { background, locator }
  }

  function redisConnection({ enableOfflineQueue }: { enableOfflineQueue: boolean }) {
    return new Redis({
      ...(process.env.REDIS_USER ? { username: process.env.REDIS_USER } : {}),
      ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379,
      enableOfflineQueue,
      maxRetriesPerRequest: enableOfflineQueue ? null : 0,
      retryStrategy: () => 1_000,
    })
  }

  it('rejects through a fail-fast client when Redis disconnects', async () => {
    const connection = redisConnection({ enableOfflineQueue: false })
    connection.on('error', () => undefined)
    const { background, locator } = isolatedBackground(connection)
    background.connect()
    background.queues[0]!.on('error', () => undefined)
    await background.queues[0]!.waitUntilReady()
    connection.disconnect(false)

    await expect(background.unscheduleByLocator(locator)).rejects.toThrow()
    await Promise.all(background.queues.map(async queue => await queue.close()))
  })

  it('keeps an offline-queue removal pending until explicit disconnect settles it', async () => {
    const connection = redisConnection({ enableOfflineQueue: true })
    connection.on('error', () => undefined)
    const { background, locator } = isolatedBackground(connection)
    background.connect()
    background.queues[0]!.on('error', () => undefined)
    await background.queues[0]!.waitUntilReady()
    connection.disconnect(true)
    let state: 'pending' | 'fulfilled' | 'rejected' = 'pending'
    const removal = background.unscheduleByLocator(locator).then(
      result => {
        state = 'fulfilled'
        return result
      },
      error => {
        state = 'rejected'
        throw error
      },
    )

    await Promise.resolve()
    expect(state).toBe('pending')

    connection.disconnect(false)
    await expect(removal).rejects.toThrow()
    expect(state).toBe('rejected')
    await Promise.all(background.queues.map(async queue => await queue.close()))
  })
})
