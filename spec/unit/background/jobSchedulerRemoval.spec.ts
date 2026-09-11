import { JobSchedulerJson } from 'bullmq'
import { Redis } from 'ioredis'
import InvalidJobSchedulerLocator from '../../../src/error/background/InvalidJobSchedulerLocator.js'
import { Background, PsychicAppWorkers } from '../../../src/package-exports/index.js'
import {
  PsychicBackgroundOptions,
  PsychicJobScheduler,
  PsychicJobSchedulerRoute,
} from '../../../src/types/background.js'
import { fakeRedisConnection, installBullMQRecorders, RecordingQueue } from '../../helpers/bullmqRecorders.js'

describe('Background#removeJobScheduler', () => {
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

  function scheduler(globalName: string, method: string, pattern = '* * * * *'): JobSchedulerJson<unknown> {
    return {
      key: `${globalName}:${method}`,
      name: 'BackgroundJobQueueStaticJob',
      pattern,
      next: 123,
      template: { data: { globalName, method, args: [] } },
    }
  }

  function simpleOptions({ transitional = true }: { transitional?: boolean } = {}): PsychicBackgroundOptions {
    return {
      defaultQueueConnection: currentConnection,
      defaultWorkerConnection: undefined,
      namedWorkstreams: [{ name: 'mailers' }],
      ...(transitional
        ? {
            transitionalWorkstreams: {
              defaultQueueConnection: transitionalConnection,
              defaultWorkerConnection: undefined,
              namedWorkstreams: [{ name: 'mailers' }],
            },
          }
        : {}),
    }
  }

  async function rowsFor(
    background: Background,
    queues: RecordingQueue[],
    globalName: string,
    method: string,
  ) {
    queues.forEach(queue => {
      queue.returnedJobSchedulers = [scheduler(globalName, method)]
    })
    return await background.getJobSchedulers()
  }

  function rowFor(
    rows: PsychicJobScheduler[],
    source: 'current' | 'transitional',
    route: PsychicJobSchedulerRoute,
  ) {
    return rows.find(
      row =>
        row.origin.source === source &&
        row.origin.route.kind === route.kind &&
        (row.origin.route.kind === 'default' ||
          (route.kind === 'named' && row.origin.route.name === route.name)),
    )!
  }

  it('removes cloned current and transitional rows independently despite stale cadence metadata', async () => {
    const background = freshBackground(simpleOptions())
    background.connect()
    const rows = await rowsFor(
      background,
      [bullmq.queues[1]!, bullmq.queues[3]!],
      'services/Mailers',
      'deliver',
    )
    const route = { kind: 'named', name: 'mailers' } as const
    const currentRow = rowFor(rows, 'current', route)
    const transitionalRow = rowFor(rows, 'transitional', route)
    const currentRemove = vi.spyOn(bullmq.queues[1]!, 'removeJobScheduler').mockResolvedValue(true)
    const transitionalRemove = vi.spyOn(bullmq.queues[3]!, 'removeJobScheduler').mockResolvedValue(true)
    const expectedId = background.jobSchedulerIdentity('services/Mailers', 'deliver', {
      workstream: 'mailers',
    }).jobSchedulerId

    await expect(
      background.removeJobScheduler({
        ...currentRow,
        pattern: 'stale pattern',
        nextRunAt: 999,
        origin: { ...currentRow.origin, route: { ...currentRow.origin.route } },
      }),
    ).resolves.toBe(true)
    expect(currentRemove).toHaveBeenCalledWith(expectedId)
    expect(transitionalRemove).not.toHaveBeenCalled()

    await expect(
      background.removeJobScheduler({
        ...transitionalRow,
        origin: { ...transitionalRow.origin, route: { ...transitionalRow.origin.route } },
      }),
    ).resolves.toBe(true)
    expect(transitionalRemove).toHaveBeenCalledWith(expectedId)
    expect(bullmq.queues.map(queue => queue.removedJobSchedulerIds)).toEqual([[], [], [], []])
  })

  it('selects native default and named origins independently', async () => {
    const background = freshBackground({
      defaultQueueConnection: currentConnection,
      nativeBullMQ: { namedQueueOptions: { mailers: {} } },
    })
    background.connect()
    bullmq.queues[0]!.returnedJobSchedulers = [scheduler('services/Default', 'run')]
    bullmq.queues[1]!.returnedJobSchedulers = [scheduler('services/Mailers', 'run')]
    const rows = await background.getJobSchedulers()
    const defaultRemove = vi.spyOn(bullmq.queues[0]!, 'removeJobScheduler').mockResolvedValue(true)
    const namedRemove = vi.spyOn(bullmq.queues[1]!, 'removeJobScheduler').mockResolvedValue(true)

    await expect(background.removeJobScheduler(rowFor(rows, 'current', { kind: 'default' }))).resolves.toBe(
      true,
    )
    expect(defaultRemove).toHaveBeenCalledOnce()
    expect(namedRemove).not.toHaveBeenCalled()

    await expect(
      background.removeJobScheduler(rowFor(rows, 'current', { kind: 'named', name: 'mailers' })),
    ).resolves.toBe(true)
    expect(namedRemove).toHaveBeenCalledOnce()
  })

  it('returns false for an already-absent scheduler and propagates operational failures', async () => {
    const background = freshBackground(simpleOptions({ transitional: false }))
    background.connect()
    const [row] = await rowsFor(background, [bullmq.queues[0]!], 'services/Digests', 'run')
    const failure = new Error('redis unavailable')
    const remove = vi
      .spyOn(bullmq.queues[0]!, 'removeJobScheduler')
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(failure)

    await expect(background.removeJobScheduler(row!)).resolves.toBe(false)
    await expect(background.removeJobScheduler(row!)).rejects.toBe(failure)
    expect(remove).toHaveBeenCalledTimes(2)
  })

  it('returns true then false when two origins alias the same scheduler state', async () => {
    const background = freshBackground({
      defaultQueueConnection: currentConnection,
      defaultWorkerConnection: undefined,
      transitionalWorkstreams: {
        defaultQueueConnection: currentConnection,
        defaultWorkerConnection: undefined,
      },
    })
    background.connect()
    const rows = await rowsFor(background, [bullmq.queues[0]!, bullmq.queues[1]!], 'services/Aliased', 'run')
    let schedulerExists = true
    const removeSharedScheduler = () => {
      const removed = schedulerExists
      schedulerExists = false
      return Promise.resolve(removed)
    }
    const currentRemove = vi
      .spyOn(bullmq.queues[0]!, 'removeJobScheduler')
      .mockImplementation(removeSharedScheduler)
    const transitionalRemove = vi
      .spyOn(bullmq.queues[1]!, 'removeJobScheduler')
      .mockImplementation(removeSharedScheduler)

    await expect(background.removeJobScheduler(rowFor(rows, 'current', { kind: 'default' }))).resolves.toBe(
      true,
    )
    expect(currentRemove).toHaveBeenCalledOnce()
    expect(transitionalRemove).not.toHaveBeenCalled()
    await expect(
      background.removeJobScheduler(rowFor(rows, 'transitional', { kind: 'default' })),
    ).resolves.toBe(false)
    expect(transitionalRemove).toHaveBeenCalledOnce()
  })

  it('returns true then false when default and named origins alias the same queue keyspace', async () => {
    PsychicAppWorkers.getOrFail().set('background', {
      defaultQueueConnection: currentConnection,
      defaultWorkerConnection: undefined,
      namedWorkstreams: [{ name: Background.defaultQueueName }],
    })
    const background = new Background()
    background.connect()
    const rows = await rowsFor(background, [bullmq.queues[0]!, bullmq.queues[1]!], 'services/Aliased', 'run')
    let schedulerExists = true
    const removeSharedScheduler = () => {
      const removed = schedulerExists
      schedulerExists = false
      return Promise.resolve(removed)
    }
    vi.spyOn(bullmq.queues[0]!, 'removeJobScheduler').mockImplementation(removeSharedScheduler)
    vi.spyOn(bullmq.queues[1]!, 'removeJobScheduler').mockImplementation(removeSharedScheduler)

    await expect(background.removeJobScheduler(rowFor(rows, 'current', { kind: 'default' }))).resolves.toBe(
      true,
    )
    await expect(
      background.removeJobScheduler(
        rowFor(rows, 'current', { kind: 'named', name: Background.defaultQueueName }),
      ),
    ).resolves.toBe(false)
  })

  it('keeps an old-route scheduler discoverable and exactly removable after a service route changes', async () => {
    PsychicAppWorkers.getOrFail().set('background', {
      defaultQueueConnection: currentConnection,
      defaultWorkerConnection: undefined,
      namedWorkstreams: [{ name: 'old-mailers' }, { name: 'new-mailers' }],
    })
    const background = new Background()
    background.connect()
    bullmq.queues[1]!.returnedJobSchedulers = [scheduler('services/Mailers', 'deliver')]
    const [oldRouteRow] = await background.getJobSchedulers()
    const newRouteLocator = background.jobSchedulerIdentity('services/Mailers', 'deliver', {
      workstream: 'new-mailers',
    }).locator
    const removeOldRoute = vi.spyOn(bullmq.queues[1]!, 'removeJobScheduler').mockResolvedValue(true)

    await expect(background.unscheduleByLocator(newRouteLocator)).resolves.toBe(false)
    expect(removeOldRoute).not.toHaveBeenCalled()
    await expect(background.removeJobScheduler(oldRouteRow!)).resolves.toBe(true)
    expect(removeOldRoute).toHaveBeenCalledWith('services/Mailers:deliver')
  })

  it('rejects contradictory identity metadata before any BullMQ mutation', async () => {
    const background = freshBackground(simpleOptions({ transitional: false }))
    background.connect()
    const rows = await rowsFor(background, [bullmq.queues[1]!], 'services/Mailers', 'deliver')
    const row = rows[0]!
    const contradictions: PsychicJobScheduler[] = [
      { ...row, globalName: 'services/Other' },
      { ...row, method: 'otherMethod' },
      { ...row, origin: { ...row.origin, route: { kind: 'default' } } },
    ]

    for (const contradiction of contradictions) {
      await expect(background.removeJobScheduler(contradiction)).rejects.toThrow(
        'Job scheduler metadata does not match its locator',
      )
    }
    await expect(background.removeJobScheduler({ ...row, locator: 'not-a-locator' })).rejects.toThrow(
      InvalidJobSchedulerLocator,
    )
    expect(bullmq.queues.every(queue => queue.removedJobSchedulerIds.length === 0)).toBe(true)
  })

  it('connects on demand and rejects cross-generation or unconfigured origins before mutation', async () => {
    const sourceBackground = freshBackground(simpleOptions({ transitional: false }))
    sourceBackground.connect()
    const sourceRows = await rowsFor(sourceBackground, [bullmq.queues[1]!], 'services/Mailers', 'deliver')
    const sourceRow = sourceRows[0]!

    const background = freshBackground(simpleOptions({ transitional: false }))
    const queueCountBeforeRemoval = bullmq.queues.length
    await expect(background.removeJobScheduler(sourceRow)).rejects.toThrow(
      'Job scheduler origin belongs to a different Background generation',
    )
    expect(bullmq.queues).toHaveLength(queueCountBeforeRemoval + 2)

    const ownRows = await rowsFor(
      background,
      [bullmq.queues[queueCountBeforeRemoval + 1]!],
      'services/Mailers',
      'deliver',
    )
    const ownRow = ownRows.find(row => row.globalName === 'services/Mailers')!
    await expect(
      background.removeJobScheduler({
        ...ownRow,
        origin: { ...ownRow.origin, source: 'transitional' },
      }),
    ).rejects.toThrow('No configured queue matches this job scheduler origin')

    expect(bullmq.queues.every(queue => queue.removedJobSchedulerIds.length === 0)).toBe(true)
  })
})
