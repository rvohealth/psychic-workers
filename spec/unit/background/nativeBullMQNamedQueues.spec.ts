import { Queue, Worker } from 'bullmq'
import { Redis } from 'ioredis'
import nameToRedisQueueName from '../../../src/background/helpers/nameToRedisQueueName.js'
import { Background, PsychicAppWorkers } from '../../../src/package-exports/index.js'
import { PsychicBackgroundOptions } from '../../../src/types/background.js'
import {
  fakeRedisConnection,
  nativeWorkerOptions,
  RecordingQueue,
  RecordingWorker,
} from '../../helpers/bullmqRecorders.js'

describe('Background#nativeBullMQConnect named queues', () => {
  let queueConnection: Redis
  let workerConnection: Redis

  function connectNative(
    backgroundOptions: PsychicBackgroundOptions,
    { activateWorkers = true }: { activateWorkers?: boolean } = {},
  ) {
    PsychicAppWorkers.getOrFail().set('background', backgroundOptions)
    const backgroundInstance = new Background()
    backgroundInstance.connect({ activateWorkers })
    return backgroundInstance
  }

  function namedQueue(queueName: string) {
    return RecordingQueue.constructed.find(
      queue => queue.queueName === nameToRedisQueueName(queueName, queueConnection),
    )
  }

  function workersFor(queueName: string) {
    return RecordingWorker.instances.filter(
      worker => worker.queueName === nameToRedisQueueName(queueName, queueConnection),
    )
  }

  beforeEach(() => {
    RecordingQueue.reset()
    RecordingWorker.reset()

    vi.spyOn(Background, 'Queue', 'get').mockReturnValue(RecordingQueue as unknown as typeof Queue)
    vi.spyOn(Background, 'Worker', 'get').mockReturnValue(RecordingWorker as unknown as typeof Worker)

    queueConnection = fakeRedisConnection('queue')
    workerConnection = fakeRedisConnection('worker')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  context('worker counts', () => {
    function connectWithNamedQueueWorkers(
      namedQueueWorkers: NonNullable<
        Extract<PsychicBackgroundOptions, { nativeBullMQ: object }>['nativeBullMQ']['namedQueueWorkers']
      >,
    ) {
      return connectNative({
        nativeBullMQ: {
          namedQueueOptions: { alpha: {} },
          namedQueueWorkers,
        },
        defaultQueueConnection: queueConnection,
        defaultWorkerConnection: workerConnection,
      })
    }

    context('when namedQueueWorkers has no entry for the queue', () => {
      it('builds the queue but zero workers, so jobs added to it are never worked', () => {
        const backgroundInstance = connectWithNamedQueueWorkers({})

        expect(namedQueue('alpha')).toBeDefined()
        expect(backgroundInstance.queues.length).toEqual(2)
        expect(workersFor('alpha').length).toEqual(0)
      })
    })

    context('when namedQueueWorkers has an empty entry for the queue', () => {
      it('builds a single worker', () => {
        connectWithNamedQueueWorkers({ alpha: nativeWorkerOptions() })

        expect(workersFor('alpha').length).toEqual(1)
      })
    })

    context('when namedQueueWorkers explicitly sets workerCount to 0', () => {
      it('builds zero workers', () => {
        connectWithNamedQueueWorkers({ alpha: nativeWorkerOptions({ workerCount: 0 }) })

        expect(workersFor('alpha').length).toEqual(0)
      })
    })

    context('when namedQueueWorkers sets a workerCount', () => {
      it('builds that many workers', () => {
        connectWithNamedQueueWorkers({ alpha: nativeWorkerOptions({ workerCount: 4 }) })

        expect(workersFor('alpha').length).toEqual(4)
      })
    })
  })

  context('when namedQueueWorkers names a queue that namedQueueOptions does not', () => {
    it('silently ignores the entry', () => {
      const backgroundInstance = connectNative({
        nativeBullMQ: {
          namedQueueOptions: { alpha: {} },
          namedQueueWorkers: { alpha: nativeWorkerOptions(), ghost: nativeWorkerOptions({ workerCount: 5 }) },
        },
        defaultQueueConnection: queueConnection,
        defaultWorkerConnection: workerConnection,
      })

      // one default queue plus `alpha`; no queue for `ghost`
      expect(backgroundInstance.queues.length).toEqual(2)
      expect(namedQueue('ghost')).toBeUndefined()
      expect(RecordingWorker.instances.length).toEqual(2)
      expect(workersFor('alpha').length).toEqual(1)
      expect(workersFor('ghost').length).toEqual(0)
      expect(
        Object.keys((backgroundInstance as unknown as { groupNames: Record<string, string[]> }).groupNames),
      ).toEqual(['alpha'])
    })
  })

  context('groupNames', () => {
    it('registers every named queue, with an empty group list when no group id is configured', () => {
      const backgroundInstance = connectNative({
        nativeBullMQ: {
          namedQueueOptions: { alpha: {}, beta: {} },
          namedQueueWorkers: {
            alpha: nativeWorkerOptions({ group: { id: 'alphaGroup' } }),
            beta: nativeWorkerOptions(),
          },
        },
        defaultQueueConnection: queueConnection,
        defaultWorkerConnection: workerConnection,
      })

      expect((backgroundInstance as unknown as { groupNames: Record<string, string[]> }).groupNames).toEqual({
        alpha: ['alphaGroup'],
        beta: [],
      })
    })

    it('never registers the default queue, which is targeted by omitting `queue`', () => {
      const backgroundInstance = connectNative({
        nativeBullMQ: { namedQueueOptions: { alpha: {} } },
        defaultQueueConnection: queueConnection,
        defaultWorkerConnection: workerConnection,
      })

      const groupNames = (backgroundInstance as unknown as { groupNames: Record<string, string[]> })
        .groupNames
      expect(groupNames).not.toHaveProperty(Background.defaultQueueName)
    })

    it('leaves workstreamNames empty in native mode', () => {
      const backgroundInstance = connectNative({
        nativeBullMQ: { namedQueueOptions: { alpha: {} } },
        defaultQueueConnection: queueConnection,
        defaultWorkerConnection: workerConnection,
      })

      expect((backgroundInstance as unknown as { workstreamNames: string[] }).workstreamNames).toEqual([])
    })
  })

  context('defaultJobOptions on a named queue', () => {
    it('replaces the app-wide bag wholesale rather than merging into it', () => {
      const appWideDefaultJobOptions = {
        removeOnComplete: 1000,
        removeOnFail: 20000,
        attempts: 20,
        backoff: { type: 'exponential', delay: 1000 },
      }

      connectNative({
        defaultBullMQQueueOptions: { defaultJobOptions: appWideDefaultJobOptions },
        nativeBullMQ: {
          namedQueueOptions: { alpha: { defaultJobOptions: { attempts: 3 } } },
        },
        defaultQueueConnection: queueConnection,
        defaultWorkerConnection: workerConnection,
      })

      // the spread is shallow, so `defaultJobOptions` is overwritten as one key:
      // backoff, removeOnComplete, and removeOnFail are all lost for this queue
      expect(namedQueue('alpha')!.queueOptions['defaultJobOptions']).toEqual({ attempts: 3 })

      // ...while the default queue, which supplied no defaultJobOptions of its
      // own, still carries all four
      expect(RecordingQueue.constructed[0]!.queueOptions['defaultJobOptions']).toEqual(
        appWideDefaultJobOptions,
      )
    })
  })

  context('named queue worker options', () => {
    it('lets the namedQueueWorkers entry override defaultBullMQWorkerOptions, with connection written last', () => {
      const namedWorkerConnection = fakeRedisConnection('namedWorker')

      connectNative({
        defaultBullMQWorkerOptions: { lockDuration: 1111, maxStalledCount: 7 },
        nativeBullMQ: {
          namedQueueOptions: { alpha: { workerConnection: namedWorkerConnection } },
          namedQueueWorkers: {
            alpha: nativeWorkerOptions({ lockDuration: 2222, group: { id: 'alphaGroup' } }),
          },
        },
        defaultQueueConnection: queueConnection,
        defaultWorkerConnection: workerConnection,
      })

      const worker = workersFor('alpha')[0]!
      expect(worker.workerOptions['lockDuration']).toEqual(2222)
      expect(worker.workerOptions['maxStalledCount']).toEqual(7)
      expect(worker.workerOptions['group']).toEqual({ id: 'alphaGroup' })
      expect(worker.workerOptions['connection']).toBe(namedWorkerConnection)
      expect(worker.workerOptions['autorun']).toBe(false)
    })

    it('passes the Psychic-only workerCount key straight through to BullMQ', () => {
      connectNative({
        nativeBullMQ: {
          namedQueueOptions: { alpha: {} },
          namedQueueWorkers: { alpha: nativeWorkerOptions({ workerCount: 2 }) },
        },
        defaultQueueConnection: queueConnection,
        defaultWorkerConnection: workerConnection,
      })

      expect(workersFor('alpha').length).toEqual(2)
      expect(workersFor('alpha')[0]!.workerOptions['workerCount']).toEqual(2)
    })

    it('passes the Psychic-only queueConnection/workerConnection keys through to the named Queue', () => {
      const namedQueueConnection = fakeRedisConnection('namedQueue')
      const namedWorkerConnection = fakeRedisConnection('namedWorker')

      connectNative({
        nativeBullMQ: {
          namedQueueOptions: {
            alpha: { queueConnection: namedQueueConnection, workerConnection: namedWorkerConnection },
          },
        },
        defaultQueueConnection: queueConnection,
        defaultWorkerConnection: workerConnection,
      })

      const alpha = RecordingQueue.constructed.find(
        queue => queue.queueName === nameToRedisQueueName('alpha', namedQueueConnection),
      )!
      expect(alpha.queueOptions['queueConnection']).toBe(namedQueueConnection)
      expect(alpha.queueOptions['workerConnection']).toBe(namedWorkerConnection)
      expect(alpha.queueOptions['connection']).toBe(namedQueueConnection)
    })
  })
})
