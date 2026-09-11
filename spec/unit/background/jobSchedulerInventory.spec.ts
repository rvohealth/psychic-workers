import { JobSchedulerJson } from 'bullmq'
import { Redis } from 'ioredis'
import { Background, PsychicAppWorkers } from '../../../src/package-exports/index.js'
import { PsychicBackgroundOptions, PsychicJobSchedulerRoute } from '../../../src/types/background.js'
import { fakeRedisConnection, installBullMQRecorders } from '../../helpers/bullmqRecorders.js'

describe('Background#getJobSchedulers', () => {
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

  function scheduler(
    globalName: string,
    method: string,
    pattern: string,
    { next }: { next?: number } = {},
  ): JobSchedulerJson<unknown> {
    return {
      key: `${globalName}:${method}`,
      name: 'BackgroundJobQueueStaticJob',
      pattern,
      ...(next === undefined ? {} : { next }),
      template: { data: { globalName, method, args: [] } },
    }
  }

  function locatorFor(
    background: Background,
    globalName: string,
    method: string,
    route: PsychicJobSchedulerRoute,
  ) {
    return background.jobSchedulerIdentity(
      globalName,
      method,
      route.kind === 'named' ? { workstream: route.name } : {},
    ).locator
  }

  it('connects on demand and observes simple current and transitional default and named origins', async () => {
    const background = freshBackground({
      defaultQueueConnection: currentConnection,
      defaultWorkerConnection: undefined,
      namedWorkstreams: [{ name: 'mailers' }],
      transitionalWorkstreams: {
        defaultQueueConnection: transitionalConnection,
        defaultWorkerConnection: undefined,
        namedWorkstreams: [{ name: 'mailers' }],
      },
    })

    const observations = [
      { globalName: 'services/CurrentDefault', method: 'run', pattern: '* * * * *', next: 101 },
      { globalName: 'services/CurrentNamed', method: 'run', pattern: '*/2 * * * *', next: 202 },
      { globalName: 'services/TransitionalDefault', method: 'run', pattern: '*/3 * * * *', next: 303 },
      { globalName: 'services/TransitionalNamed', method: 'run', pattern: '*/4 * * * *', next: 404 },
    ]
    const routes: PsychicJobSchedulerRoute[] = [
      { kind: 'default' },
      { kind: 'named', name: 'mailers' },
      { kind: 'default' },
      { kind: 'named', name: 'mailers' },
    ]
    const sources = ['current', 'current', 'transitional', 'transitional'] as const

    await expect(background.getJobSchedulers()).resolves.toEqual([])
    observations.forEach((observation, index) => {
      bullmq.queues[index]!.returnedJobSchedulers = [
        scheduler(observation.globalName, observation.method, observation.pattern, {
          next: observation.next,
        }),
      ]
    })
    const inventory = await background.getJobSchedulers()

    expect(inventory).toHaveLength(4)
    const generation = inventory[0]!.origin.generation
    expect(generation).not.toEqual('')
    observations.forEach((observation, index) => {
      expect(inventory).toContainEqual({
        locator: locatorFor(background, observation.globalName, observation.method, routes[index]!),
        globalName: observation.globalName,
        method: observation.method,
        pattern: observation.pattern,
        nextRunAt: observation.next,
        origin: {
          generation,
          source: sources[index],
          route: routes[index],
        },
      })
    })
    expect(bullmq.queues.map(queue => queue.jobSchedulerReads)).toEqual([2, 2, 2, 2])

    await background.getJobSchedulers()
    expect(bullmq.queues).toHaveLength(4)
    expect(bullmq.queues.map(queue => queue.jobSchedulerReads)).toEqual([3, 3, 3, 3])
  })

  it('observes native current default and named origins', async () => {
    const background = freshBackground({
      defaultQueueConnection: currentConnection,
      nativeBullMQ: { namedQueueOptions: { mailers: {} } },
    })
    background.connect()
    bullmq.queues[0]!.returnedJobSchedulers = [scheduler('services/Default', 'run', '0 * * * *')]
    bullmq.queues[1]!.returnedJobSchedulers = [scheduler('services/Mailers', 'run', '5 * * * *')]

    const inventory = await background.getJobSchedulers()

    expect(inventory).toHaveLength(2)
    const generation = inventory[0]!.origin.generation
    expect(inventory.every(row => !Object.hasOwn(row, 'nextRunAt'))).toBe(true)
    expect(
      inventory
        .map(({ globalName, origin }) => ({ globalName, origin }))
        .sort((left, right) => left.globalName.localeCompare(right.globalName)),
    ).toEqual([
      {
        globalName: 'services/Default',
        origin: { generation, source: 'current', route: { kind: 'default' } },
      },
      {
        globalName: 'services/Mailers',
        origin: {
          generation,
          source: 'current',
          route: { kind: 'named', name: 'mailers' },
        },
      },
    ])
  })

  it('excludes foreign and malformed scheduler entries instead of interpreting their keys', async () => {
    const background = freshBackground({
      defaultQueueConnection: currentConnection,
      defaultWorkerConnection: undefined,
    })
    background.connect()
    bullmq.queues[0]!.returnedJobSchedulers = [
      scheduler('services/Valid', 'run', '* * * * *'),
      { ...scheduler('services/Foreign', 'run', '* * * * *'), name: 'foreign-job' },
      { ...scheduler('services/WrongKey', 'run', '* * * * *'), key: 'parse:me:instead' },
      {
        ...scheduler('services/NoPattern', 'run', '* * * * *'),
        pattern: undefined,
      } as unknown as JobSchedulerJson<unknown>,
      { ...scheduler('services/InvalidNext', 'run', '* * * * *'), next: Number.POSITIVE_INFINITY },
      {
        key: 'services/NoArgs:run',
        name: 'BackgroundJobQueueStaticJob',
        pattern: '* * * * *',
        template: { data: { globalName: 'services/NoArgs', method: 'run' } },
      },
      {
        key: 'services/NoMethod:run',
        name: 'BackgroundJobQueueStaticJob',
        pattern: '* * * * *',
        template: { data: { globalName: 'services/NoMethod', args: [] } },
      },
    ]

    await expect(background.getJobSchedulers()).resolves.toEqual([
      expect.objectContaining({ globalName: 'services/Valid', method: 'run' }),
    ])
  })

  it('returns separate observations when configured origins alias shared scheduler state', async () => {
    const background = freshBackground({
      defaultQueueConnection: currentConnection,
      defaultWorkerConnection: undefined,
      transitionalWorkstreams: {
        defaultQueueConnection: currentConnection,
        defaultWorkerConnection: undefined,
      },
    })
    background.connect()
    const sharedScheduler = scheduler('services/Aliased', 'run', '* * * * *')
    bullmq.queues.forEach(queue => {
      queue.returnedJobSchedulers = [sharedScheduler]
    })

    const inventory = await background.getJobSchedulers()

    expect(inventory).toHaveLength(2)
    expect(new Set(inventory.map(row => row.locator))).toHaveLength(1)
    expect(new Set(inventory.map(row => row.origin.source))).toEqual(new Set(['current', 'transitional']))
    expect(new Set(inventory.map(row => row.origin.generation))).toHaveLength(1)
  })

  it('returns the per-origin observations that completed even when aliased state changes between reads', async () => {
    const background = freshBackground({
      defaultQueueConnection: currentConnection,
      defaultWorkerConnection: undefined,
      transitionalWorkstreams: {
        defaultQueueConnection: currentConnection,
        defaultWorkerConnection: undefined,
      },
    })
    background.connect()
    const sharedScheduler = scheduler('services/Aliased', 'run', '* * * * *')
    vi.spyOn(bullmq.queues[0]!, 'getJobSchedulers').mockResolvedValue([sharedScheduler])
    vi.spyOn(bullmq.queues[1]!, 'getJobSchedulers').mockResolvedValue([])

    const inventory = await background.getJobSchedulers()

    expect(inventory).toHaveLength(1)
    expect(inventory[0]!.globalName).toBe('services/Aliased')
    expect(inventory[0]!.origin.source).toBe('current')
  })

  it('returns an empty array when every configured origin is empty', async () => {
    const background = freshBackground({
      defaultQueueConnection: currentConnection,
      defaultWorkerConnection: undefined,
    })

    await expect(background.getJobSchedulers()).resolves.toEqual([])
  })

  it('rejects the whole inventory when any configured queue read fails', async () => {
    const background = freshBackground({
      defaultQueueConnection: currentConnection,
      defaultWorkerConnection: undefined,
      namedWorkstreams: [{ name: 'mailers' }],
      transitionalWorkstreams: {
        defaultQueueConnection: transitionalConnection,
        defaultWorkerConnection: undefined,
      },
    })
    background.connect()
    const failure = new Error('redis unavailable')
    const failedRead = vi.spyOn(bullmq.queues[1]!, 'getJobSchedulers').mockRejectedValue(failure)

    await expect(background.getJobSchedulers()).rejects.toBe(failure)
    expect(failedRead).toHaveBeenCalledOnce()
    expect(bullmq.queues.map(queue => queue.jobSchedulerReads)).toEqual([1, 0, 1])
  })
})
