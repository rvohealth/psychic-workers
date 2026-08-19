import { Queue, Worker } from 'bullmq'
import { Cluster, Redis } from 'ioredis'
import nameToRedisQueueName from '../../../src/background/helpers/nameToRedisQueueName.js'
import parallelTestSafeQueueName from '../../../src/background/helpers/parallelTestSafeQueueName.js'
import ActivatingBackgroundWorkersWithoutDefaultWorkerConnection from '../../../src/error/background/ActivatingBackgroundWorkersWithoutDefaultWorkerConnection.js'
import DefaultBullMQNativeOptionsMissingQueueConnectionAndDefaultQueueConnection from '../../../src/error/background/DefaultBullMQNativeOptionsMissingQueueConnectionAndDefaultQueueConnection.js'
import { Background, PsychicAppWorkers } from '../../../src/package-exports/index.js'
import { PsychicBackgroundOptions } from '../../../src/types/background.js'
import {
  fakeRedisConnection,
  nativeWorkerOptions,
  RecordingQueue,
  RecordingWorker,
} from '../../helpers/bullmqRecorders.js'

describe('Background#nativeBullMQConnect', () => {
  let queueConnection: Redis
  let workerConnection: Redis

  function connectNative(
    backgroundOptions: PsychicBackgroundOptions,
    { activateWorkers = false }: { activateWorkers?: boolean } = {},
  ) {
    PsychicAppWorkers.getOrFail().set('background', backgroundOptions)
    const backgroundInstance = new Background()
    backgroundInstance.connect({ activateWorkers })
    return backgroundInstance
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

  context('mode selection', () => {
    it('treats an empty nativeBullMQ object as a request for native mode', () => {
      // every key of `nativeBullMQ` is optional, so `nativeBullMQ: {}` is a legal
      // config, and the truthiness check in `connect` selects the native branch
      connectNative(
        {
          nativeBullMQ: {},
          defaultQueueConnection: queueConnection,
          defaultWorkerConnection: workerConnection,
        },
        { activateWorkers: true },
      )

      expect(RecordingQueue.constructed.length).toEqual(1)
      expect(RecordingQueue.constructed[0]!.queueName).toEqual(
        nameToRedisQueueName(Background.defaultQueueName, queueConnection),
      )

      // the queue above is identical in both modes, so the discriminator is the
      // worker: simple mode writes `concurrency: DEFAULT_CONCURRENCY` onto every
      // worker it builds, while the native branch writes no concurrency key at all
      expect(RecordingWorker.instances.length).toEqual(1)
      expect(RecordingWorker.instances[0]!.workerOptions).not.toHaveProperty('concurrency')
    })
  })

  context('the default queue', () => {
    it('names the queue after the app and passes the resolved queue connection', () => {
      const backgroundInstance = connectNative({
        nativeBullMQ: {},
        defaultQueueConnection: queueConnection,
      })

      expect(Background.defaultQueueName).toEqual('TestappBackgroundJobQueue')
      expect(backgroundInstance.queues.length).toEqual(1)

      const defaultQueue = RecordingQueue.constructed[0]!
      // asserted against the literal rather than against `nameToRedisQueueName`,
      // which is the function producing it. `parallelTestSafeQueueName` only
      // appends a suffix when the suite runs with DREAM_PARALLEL_TESTS > 1
      expect(defaultQueue.queueName).toEqual(parallelTestSafeQueueName('TestappBackgroundJobQueue'))
      expect(defaultQueue.queueOptions).toEqual({ connection: queueConnection })
    })

    it('lets nativeBullMQ.defaultQueueOptions override defaultBullMQQueueOptions', () => {
      connectNative({
        defaultBullMQQueueOptions: {
          prefix: 'fromDefaultBullMQQueueOptions',
          defaultJobOptions: { attempts: 20 },
        },
        nativeBullMQ: {
          defaultQueueOptions: { prefix: 'fromNativeDefaultQueueOptions' },
        },
        defaultQueueConnection: queueConnection,
      })

      const defaultQueue = RecordingQueue.constructed[0]!
      expect(defaultQueue.queueOptions['prefix']).toEqual('fromNativeDefaultQueueOptions')
      // a key only present in defaultBullMQQueueOptions survives
      expect(defaultQueue.queueOptions['defaultJobOptions']).toEqual({ attempts: 20 })
    })

    it('writes `connection` last, so it wins over anything spread in ahead of it', () => {
      const bogusConnection = fakeRedisConnection('bogus')

      connectNative({
        // `connection` is Omit-ed from the public types, but a JavaScript caller
        // can still supply it, and the explicit write always wins
        defaultBullMQQueueOptions: { connection: bogusConnection } as unknown as Record<string, never>,
        nativeBullMQ: {},
        defaultQueueConnection: queueConnection,
      })

      expect(RecordingQueue.constructed[0]!.queueOptions['connection']).toBe(queueConnection)
    })

    it('passes the queueConnection/workerConnection keys of defaultQueueOptions through to BullMQ', () => {
      // `defaultQueueOptions` is spread wholesale into the Queue options, so its
      // Psychic-only connection keys arrive at BullMQ alongside the real options
      connectNative({
        nativeBullMQ: {
          defaultQueueOptions: { queueConnection, workerConnection },
        },
      })

      const defaultQueue = RecordingQueue.constructed[0]!
      expect(defaultQueue.queueOptions['queueConnection']).toBe(queueConnection)
      expect(defaultQueue.queueOptions['workerConnection']).toBe(workerConnection)
    })
  })

  context('redis queue naming', () => {
    it('strips braces out of the configured queue name', () => {
      connectNative({
        nativeBullMQ: { namedQueueOptions: { '{alpha}': {} } },
        defaultQueueConnection: queueConnection,
      })

      expect(RecordingQueue.constructed.map(queue => queue.queueName)).toEqual([
        parallelTestSafeQueueName('TestappBackgroundJobQueue'),
        parallelTestSafeQueueName('alpha'),
      ])
    })

    it('wraps the queue name in a redis hash tag when the connection is a Cluster', () => {
      // this is the reason `QueueOptionsWithConnectionInstance` takes connection
      // instances rather than connection configs. The cluster is never connected:
      // `nameToRedisQueueName` only asks whether the connection is `instanceof Cluster`
      const clusterConnection = new Cluster([{ host: '127.0.0.1', port: 6379 }], { lazyConnect: true })

      try {
        connectNative({
          nativeBullMQ: { namedQueueOptions: { '{alpha}': {} } },
          defaultQueueConnection: clusterConnection,
        })

        // the hash tag keeps every key of a queue on a single cluster slot, and
        // the cluster branch skips the parallel-test suffix entirely
        expect(RecordingQueue.constructed.map(queue => queue.queueName)).toEqual([
          '{TestappBackgroundJobQueue}',
          '{alpha}',
        ])
      } finally {
        clusterConnection.disconnect()
      }
    })
  })

  context('the default workers', () => {
    it('builds no workers when activateWorkers is false', () => {
      connectNative({
        nativeBullMQ: { defaultWorkerCount: 3 },
        defaultQueueConnection: queueConnection,
        defaultWorkerConnection: workerConnection,
      })

      expect(RecordingWorker.instances.length).toEqual(0)
    })

    it('builds a single worker on the default queue when defaultWorkerCount is omitted', () => {
      connectNative(
        {
          nativeBullMQ: {},
          defaultQueueConnection: queueConnection,
          defaultWorkerConnection: workerConnection,
        },
        { activateWorkers: true },
      )

      expect(RecordingWorker.instances.length).toEqual(1)

      const worker = RecordingWorker.instances[0]!
      expect(worker.queueName).toEqual(nameToRedisQueueName(Background.defaultQueueName, queueConnection))
      expect(worker.workerOptions).toEqual({ autorun: false, connection: workerConnection })
    })

    it('builds defaultWorkerCount workers', () => {
      connectNative(
        {
          nativeBullMQ: { defaultWorkerCount: 3 },
          defaultQueueConnection: queueConnection,
          defaultWorkerConnection: workerConnection,
        },
        { activateWorkers: true },
      )

      expect(RecordingWorker.instances.length).toEqual(3)
    })

    it('lets nativeBullMQ.defaultWorkerOptions override defaultBullMQWorkerOptions', () => {
      connectNative(
        {
          defaultBullMQWorkerOptions: { lockDuration: 1111, maxStalledCount: 7 },
          nativeBullMQ: { defaultWorkerOptions: nativeWorkerOptions({ lockDuration: 2222 }) },
          defaultQueueConnection: queueConnection,
          defaultWorkerConnection: workerConnection,
        },
        { activateWorkers: true },
      )

      const worker = RecordingWorker.instances[0]!
      expect(worker.workerOptions['lockDuration']).toEqual(2222)
      expect(worker.workerOptions['maxStalledCount']).toEqual(7)
      expect(worker.workerOptions['connection']).toBe(workerConnection)
    })
  })

  context('connection resolution', () => {
    it('prefers nativeBullMQ.defaultQueueOptions.queueConnection over defaultQueueConnection', () => {
      const preferredConnection = fakeRedisConnection('preferred')

      connectNative({
        nativeBullMQ: { defaultQueueOptions: { queueConnection: preferredConnection } },
        defaultQueueConnection: queueConnection,
      })

      expect(RecordingQueue.constructed[0]!.queueOptions['connection']).toBe(preferredConnection)
    })

    it('reads the default worker connection off defaultQueueOptions, not off a worker options object', () => {
      // the worker-side override lives on the *queue's* options object; there is
      // no connection field anywhere on defaultWorkerOptions or namedQueueWorkers
      const preferredConnection = fakeRedisConnection('preferred')

      connectNative(
        {
          nativeBullMQ: {
            defaultQueueOptions: { queueConnection, workerConnection: preferredConnection },
          },
          defaultWorkerConnection: workerConnection,
        },
        { activateWorkers: true },
      )

      expect(RecordingWorker.instances[0]!.workerOptions['connection']).toBe(preferredConnection)
    })

    it('falls back to the app-level defaultQueueConnection/defaultWorkerConnection', () => {
      connectNative(
        {
          nativeBullMQ: {},
          defaultQueueConnection: queueConnection,
          defaultWorkerConnection: workerConnection,
        },
        { activateWorkers: true },
      )

      expect(RecordingQueue.constructed[0]!.queueOptions['connection']).toBe(queueConnection)
      expect(RecordingWorker.instances[0]!.workerOptions['connection']).toBe(workerConnection)
    })

    it('accumulates every connection it encounters so they can all be quit on shutdown', async () => {
      const namedQueueConnection = fakeRedisConnection('namedQueue')
      const namedWorkerConnection = fakeRedisConnection('namedWorker')

      const backgroundInstance = connectNative({
        nativeBullMQ: {
          namedQueueOptions: {
            alpha: { queueConnection: namedQueueConnection, workerConnection: namedWorkerConnection },
          },
        },
        defaultQueueConnection: queueConnection,
        defaultWorkerConnection: workerConnection,
      })

      const redisConnections = (backgroundInstance as unknown as { redisConnections: { __label: string }[] })
        .redisConnections
      expect(redisConnections.map(connection => connection.__label)).toEqual([
        'queue',
        'worker',
        'namedQueue',
        'namedWorker',
      ])

      const quitSpies = redisConnections.map(connection =>
        vi.spyOn(connection as unknown as Redis, 'quit').mockResolvedValue('OK'),
      )
      await backgroundInstance.closeAllRedisConnections()
      quitSpies.forEach(quitSpy => expect(quitSpy).toHaveBeenCalled())
    })

    it('never accumulates the app-level connections that defaultQueueOptions shadows', async () => {
      const preferredQueueConnection = fakeRedisConnection('preferredQueue')
      const preferredWorkerConnection = fakeRedisConnection('preferredWorker')

      const backgroundInstance = connectNative(
        {
          nativeBullMQ: {
            defaultQueueOptions: {
              queueConnection: preferredQueueConnection,
              workerConnection: preferredWorkerConnection,
            },
          },
          defaultQueueConnection: queueConnection,
          defaultWorkerConnection: workerConnection,
        },
        { activateWorkers: true },
      )

      // only the *resolved* connections are accumulated, so the shadowed
      // app-level connections are dropped on the floor
      const redisConnections = (backgroundInstance as unknown as { redisConnections: { __label: string }[] })
        .redisConnections
      expect(redisConnections.map(connection => connection.__label)).toEqual([
        'preferredQueue',
        'preferredWorker',
      ])

      // ...and are therefore never quit on shutdown
      const shadowedQuitSpies = [queueConnection, workerConnection].map(connection =>
        vi.spyOn(connection, 'quit').mockResolvedValue('OK'),
      )
      await backgroundInstance.closeAllRedisConnections()
      shadowedQuitSpies.forEach(quitSpy => expect(quitSpy).not.toHaveBeenCalled())
    })
  })

  context('failure modes', () => {
    context('when no queue connection can be resolved', () => {
      it('throws even when workers are not being activated', () => {
        expect(() => connectNative({ nativeBullMQ: {} })).toThrow(
          DefaultBullMQNativeOptionsMissingQueueConnectionAndDefaultQueueConnection,
        )
      })

      it('throws when workers are being activated', () => {
        expect(() =>
          connectNative(
            { nativeBullMQ: {}, defaultWorkerConnection: workerConnection },
            { activateWorkers: true },
          ),
        ).toThrow(DefaultBullMQNativeOptionsMissingQueueConnectionAndDefaultQueueConnection)
      })
    })

    context('when activating workers without a resolvable worker connection', () => {
      it('throws', () => {
        expect(() =>
          connectNative(
            { nativeBullMQ: {}, defaultQueueConnection: queueConnection },
            { activateWorkers: true },
          ),
        ).toThrow(ActivatingBackgroundWorkersWithoutDefaultWorkerConnection)
      })

      it('does not throw when workers are not being activated', () => {
        expect(() =>
          connectNative({ nativeBullMQ: {}, defaultQueueConnection: queueConnection }),
        ).not.toThrow()
      })
    })

    context('a named queue with no connections of its own', () => {
      it('inherits the default connections rather than raising', () => {
        // NamedBullMQNativeOptionsMissingQueueConnectionAndDefaultQueueConnection and
        // ActivatingNamedQueueBackgroundWorkersWithoutWorkerConnection can only be
        // reached when the corresponding default connection is missing -- but in that
        // case the default-queue/default-worker check has already thrown, so in native
        // mode neither named-queue error is reachable
        const backgroundInstance = connectNative(
          {
            nativeBullMQ: {
              namedQueueOptions: { alpha: {} },
              namedQueueWorkers: { alpha: nativeWorkerOptions() },
            },
            defaultQueueConnection: queueConnection,
            defaultWorkerConnection: workerConnection,
          },
          { activateWorkers: true },
        )

        expect(backgroundInstance.queues.length).toEqual(2)
        expect(RecordingQueue.constructed[1]!.queueOptions['connection']).toBe(queueConnection)
        expect(RecordingWorker.instances[1]!.workerOptions['connection']).toBe(workerConnection)
      })
    })
  })

  context('idempotence', () => {
    it('ignores config changes once a default queue has been built', () => {
      const backgroundInstance = connectNative({
        nativeBullMQ: {},
        defaultQueueConnection: queueConnection,
      })

      PsychicAppWorkers.getOrFail().set('background', {
        nativeBullMQ: { namedQueueOptions: { alpha: {} } },
        defaultQueueConnection: queueConnection,
      })
      backgroundInstance.connect()

      expect(backgroundInstance.queues.length).toEqual(1)
    })
  })
})
