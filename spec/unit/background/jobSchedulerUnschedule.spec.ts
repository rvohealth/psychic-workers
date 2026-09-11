import { Redis } from 'ioredis'
import InvalidJobSchedulerLocator from '../../../src/error/background/InvalidJobSchedulerLocator.js'
import NoQueueForSpecifiedQueueName from '../../../src/error/background/NoQueueForSpecifiedQueueName.js'
import NoQueueForSpecifiedWorkstream from '../../../src/error/background/NoQueueForSpecifiedWorkstream.js'
import { Background, PsychicAppWorkers } from '../../../src/package-exports/index.js'
import { PsychicBackgroundOptions } from '../../../src/types/background.js'
import { fakeRedisConnection, installBullMQRecorders } from '../../helpers/bullmqRecorders.js'

describe('Background#unscheduleByLocator', () => {
  const bullmq = installBullMQRecorders()

  let currentConnection: Redis
  let transitionalConnection: Redis

  beforeEach(() => {
    currentConnection = fakeRedisConnection('current')
    transitionalConnection = fakeRedisConnection('transitional')
  })

  function freshBackground(options: PsychicBackgroundOptions) {
    PsychicAppWorkers.getOrFail().set('background', options)
    return new Background()
  }

  function simpleOptions({
    currentNamed = true,
    transitionalNamed = true,
  }: {
    currentNamed?: boolean
    transitionalNamed?: boolean
  } = {}): PsychicBackgroundOptions {
    return {
      defaultQueueConnection: currentConnection,
      defaultWorkerConnection: undefined,
      namedWorkstreams: currentNamed ? [{ name: 'mailers' }] : [],
      transitionalWorkstreams: {
        defaultQueueConnection: transitionalConnection,
        defaultWorkerConnection: undefined,
        namedWorkstreams: transitionalNamed ? [{ name: 'mailers' }] : [],
      },
    }
  }

  it('connects on demand and idempotently checks every default-route origin', async () => {
    const background = freshBackground(simpleOptions({ currentNamed: false, transitionalNamed: false }))
    const locator = background.jobSchedulerIdentity('services/Digests', 'deliver').locator

    await expect(background.unscheduleByLocator(locator)).resolves.toBe(false)
    await expect(background.unscheduleByLocator(locator)).resolves.toBe(false)

    expect(bullmq.queues).toHaveLength(2)
    expect(bullmq.queues.map(queue => queue.removedJobSchedulerIds)).toEqual([
      ['services/Digests:deliver', 'services/Digests:deliver'],
      ['services/Digests:deliver', 'services/Digests:deliver'],
    ])
  })

  it('removes a named scheduler from every matching current and transitional origin', async () => {
    const background = freshBackground(simpleOptions())
    background.connect()
    const locator = background.jobSchedulerIdentity('services/Digests', 'deliver', {
      workstream: 'mailers',
    }).locator

    const currentRemove = vi.spyOn(bullmq.queues[1]!, 'removeJobScheduler').mockResolvedValue(true)

    await expect(background.unscheduleByLocator(locator)).resolves.toBe(true)

    expect(currentRemove).toHaveBeenCalledWith('services/Digests:deliver')
    expect(bullmq.queues[0]!.removedJobSchedulerIds).toEqual([])
    expect(bullmq.queues[2]!.removedJobSchedulerIds).toEqual([])
    expect(bullmq.queues[3]!.removedJobSchedulerIds).toEqual(['services/Digests:deliver'])
  })

  it('reaches a named route configured only in transitional topology', async () => {
    const background = freshBackground(simpleOptions({ currentNamed: false }))
    background.connect()
    const locator = background.jobSchedulerIdentity('services/Digests', 'deliver', {
      workstream: 'mailers',
    }).locator

    const remove = vi.spyOn(bullmq.queues[2]!, 'removeJobScheduler').mockResolvedValue(true)

    await expect(background.unscheduleByLocator(locator)).resolves.toBe(true)
    expect(remove).toHaveBeenCalledWith('services/Digests:deliver')
  })

  it('supports default and named native BullMQ routes', async () => {
    const background = freshBackground({
      defaultQueueConnection: currentConnection,
      nativeBullMQ: { namedQueueOptions: { mailers: {} } },
    })
    background.connect()
    const defaultLocator = background.jobSchedulerIdentity('services/Digests', 'deliver').locator
    const namedLocator = background.jobSchedulerIdentity('services/Digests', 'deliver', {
      queue: 'mailers',
    }).locator
    const defaultRemove = vi.spyOn(bullmq.queues[0]!, 'removeJobScheduler').mockResolvedValue(true)
    const namedRemove = vi.spyOn(bullmq.queues[1]!, 'removeJobScheduler').mockResolvedValue(true)

    await expect(background.unscheduleByLocator(defaultLocator)).resolves.toBe(true)
    await expect(background.unscheduleByLocator(namedLocator)).resolves.toBe(true)

    expect(defaultRemove).toHaveBeenCalledWith('services/Digests:deliver')
    expect(namedRemove).toHaveBeenCalledWith('services/Digests:deliver')
  })

  it('rejects a route missing from simple or native configuration', async () => {
    const simpleBackground = freshBackground(simpleOptions({ currentNamed: false, transitionalNamed: false }))
    const simpleLocator = simpleBackground.jobSchedulerIdentity('services/Digests', 'deliver', {
      workstream: 'ghost',
    }).locator

    await expect(simpleBackground.unscheduleByLocator(simpleLocator)).rejects.toThrow(
      NoQueueForSpecifiedWorkstream,
    )

    const nativeBackground = freshBackground({
      defaultQueueConnection: currentConnection,
      nativeBullMQ: {},
    })
    const nativeLocator = nativeBackground.jobSchedulerIdentity('services/Digests', 'deliver', {
      queue: 'ghost',
    }).locator

    await expect(nativeBackground.unscheduleByLocator(nativeLocator)).rejects.toThrow(
      NoQueueForSpecifiedQueueName,
    )
  })

  it('rejects malformed input without treating it as an absent scheduler', async () => {
    const background = freshBackground(simpleOptions())

    await expect(background.unscheduleByLocator('services/Digests:deliver')).rejects.toThrow(
      InvalidJobSchedulerLocator,
    )
    expect(bullmq.queues.every(queue => queue.removedJobSchedulerIds.length === 0)).toBe(true)
  })

  it('settles every origin before propagating a removal failure and remains retryable', async () => {
    const background = freshBackground(simpleOptions())
    background.connect()
    const locator = background.jobSchedulerIdentity('services/Digests', 'deliver', {
      workstream: 'mailers',
    }).locator
    const failure = new Error('redis unavailable')
    let settleTransitionalRemoval: (removed: boolean) => void = () => undefined
    const transitionalRemoval = new Promise<boolean>(resolve => {
      settleTransitionalRemoval = resolve
    })
    const currentRemove = vi
      .spyOn(bullmq.queues[1]!, 'removeJobScheduler')
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(false)
    const transitionalRemove = vi
      .spyOn(bullmq.queues[3]!, 'removeJobScheduler')
      .mockReturnValueOnce(transitionalRemoval)
      .mockResolvedValue(false)

    const firstAttempt = background.unscheduleByLocator(locator)
    let rejected = false
    void firstAttempt.catch(() => {
      rejected = true
    })
    await Promise.resolve()

    expect(rejected).toBe(false)
    settleTransitionalRemoval(true)
    await expect(firstAttempt).rejects.toBe(failure)
    expect(currentRemove).toHaveBeenCalledOnce()
    expect(transitionalRemove).toHaveBeenCalledOnce()

    await expect(background.unscheduleByLocator(locator)).resolves.toBe(false)
    expect(currentRemove).toHaveBeenCalledTimes(2)
    expect(transitionalRemove).toHaveBeenCalledTimes(2)
  })

  it('keeps scheduling current-only while unscheduling spans configured origins', async () => {
    const background = freshBackground(simpleOptions())
    background.connect()

    await background.scheduledMethod(class Digests {}, '* * * * *', 'deliver', {
      globalName: 'services/Digests',
      jobConfig: { workstream: 'mailers' },
    })

    expect(bullmq.queues[1]!.jobSchedulers).toHaveLength(1)
    expect(bullmq.queues[3]!.jobSchedulers).toHaveLength(0)
    expect(bullmq.queues[1]!.jobSchedulers[0]![0]).toBe('services/Digests:deliver')
  })
})
