import { Redis } from 'ioredis'
import nameToRedisQueueName from '../../../src/background/helpers/nameToRedisQueueName.js'
import { Background, PsychicAppWorkers } from '../../../src/package-exports/index.js'
import { PsychicBackgroundOptions } from '../../../src/types/background.js'
import {
  fakeRedisConnection,
  installBullMQRecorders,
  nativeWorkerOptions,
} from '../../helpers/bullmqRecorders.js'

/**
 * Simple (workstream) mode always writes a `concurrency` onto every worker it
 * builds, defaulting to 10. Native BullMQ mode never writes one at all, so an
 * app that migrates from simple to native without supplying a concurrency
 * silently drops to BullMQ's own default of 1.
 */
describe('worker concurrency across the two background configuration modes', () => {
  const bullmq = installBullMQRecorders()

  let queueConnection: Redis
  let workerConnection: Redis

  function connectWorkers(backgroundOptions: PsychicBackgroundOptions) {
    PsychicAppWorkers.getOrFail().set('background', backgroundOptions)
    const backgroundInstance = new Background()
    backgroundInstance.connect({ activateWorkers: true })
    return backgroundInstance
  }

  function workersFor(queueName: string) {
    return bullmq.workers.filter(
      worker => worker.queueName === nameToRedisQueueName(queueName, queueConnection),
    )
  }

  beforeEach(() => {
    queueConnection = fakeRedisConnection('queue')
    workerConnection = fakeRedisConnection('worker')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  context('simple mode', () => {
    it('forces a concurrency of 10 onto default and named workstream workers when none is configured', () => {
      connectWorkers({
        defaultQueueConnection: queueConnection,
        defaultWorkerConnection: workerConnection,
        namedWorkstreams: [{ workerCount: 1, name: 'snazzy', rateLimit: { max: 1, duration: 1 } }],
      })

      expect(workersFor(Background.defaultQueueName)[0]!.workerOptions['concurrency']).toEqual(10)
      expect(workersFor('snazzy')[0]!.workerOptions['concurrency']).toEqual(10)
    })

    it('uses the configured concurrency when one is supplied', () => {
      connectWorkers({
        defaultQueueConnection: queueConnection,
        defaultWorkerConnection: workerConnection,
        defaultWorkstream: { concurrency: 25 },
        namedWorkstreams: [{ workerCount: 1, name: 'snazzy', concurrency: 5 }],
      })

      expect(workersFor(Background.defaultQueueName)[0]!.workerOptions['concurrency']).toEqual(25)
      expect(workersFor('snazzy')[0]!.workerOptions['concurrency']).toEqual(5)
    })

    it('coerces a configured concurrency of 0 back up to 10', () => {
      connectWorkers({
        defaultQueueConnection: queueConnection,
        defaultWorkerConnection: workerConnection,
        defaultWorkstream: { concurrency: 0 },
        namedWorkstreams: [{ workerCount: 1, name: 'snazzy', concurrency: 0 }],
      })

      // the fallback is written with `||` rather than `??`, so 0 is not an
      // expressible concurrency in simple mode
      expect(workersFor(Background.defaultQueueName)[0]!.workerOptions['concurrency']).toEqual(10)
      expect(workersFor('snazzy')[0]!.workerOptions['concurrency']).toEqual(10)
    })

    it('ignores concurrency, connection, and group supplied via defaultBullMQWorkerOptions', () => {
      const ignoredConnection = fakeRedisConnection('ignored')

      connectWorkers({
        defaultBullMQWorkerOptions: {
          concurrency: 99,
          connection: ignoredConnection,
          group: { id: 'ignoredGroup' },
        } as unknown as Record<string, never>,
        defaultQueueConnection: queueConnection,
        defaultWorkerConnection: workerConnection,
        namedWorkstreams: [{ workerCount: 1, name: 'snazzy', rateLimit: { max: 1, duration: 1 } }],
      })

      // the explicit writes come after the spread, so they always win
      const defaultWorker = workersFor(Background.defaultQueueName)[0]!
      expect(defaultWorker.workerOptions['concurrency']).toEqual(10)
      expect(defaultWorker.workerOptions['connection']).toBe(workerConnection)

      const namedWorker = workersFor('snazzy')[0]!
      expect(namedWorker.workerOptions['concurrency']).toEqual(10)
      expect(namedWorker.workerOptions['connection']).toBe(workerConnection)
      expect(namedWorker.workerOptions['group']).toEqual({
        id: 'snazzy',
        limit: { max: 1, duration: 1 },
      })
    })
  })

  context('native BullMQ mode', () => {
    it('writes no concurrency key at all onto the equivalent workers', () => {
      connectWorkers({
        defaultQueueConnection: queueConnection,
        defaultWorkerConnection: workerConnection,
        nativeBullMQ: {
          namedQueueOptions: { snazzy: {} },
          namedQueueWorkers: { snazzy: nativeWorkerOptions() },
        },
      })

      // `not.toHaveProperty` rather than `toBeUndefined`: BullMQ applies its own
      // default (1) only when the key is absent
      expect(workersFor(Background.defaultQueueName)[0]!.workerOptions).not.toHaveProperty('concurrency')
      expect(workersFor('snazzy')[0]!.workerOptions).not.toHaveProperty('concurrency')
    })

    it('passes through whatever concurrency the config supplies', () => {
      connectWorkers({
        defaultBullMQWorkerOptions: { concurrency: 99 },
        defaultQueueConnection: queueConnection,
        defaultWorkerConnection: workerConnection,
        nativeBullMQ: {
          defaultWorkerOptions: nativeWorkerOptions({ concurrency: 25 }),
          namedQueueOptions: { snazzy: {} },
          namedQueueWorkers: { snazzy: nativeWorkerOptions({ concurrency: 5 }) },
        },
      })

      expect(workersFor(Background.defaultQueueName)[0]!.workerOptions['concurrency']).toEqual(25)
      expect(workersFor('snazzy')[0]!.workerOptions['concurrency']).toEqual(5)
    })

    it('lets a configured concurrency of 0 survive, unlike simple mode', () => {
      connectWorkers({
        defaultQueueConnection: queueConnection,
        defaultWorkerConnection: workerConnection,
        nativeBullMQ: {
          defaultWorkerOptions: nativeWorkerOptions({ concurrency: 0 }),
          namedQueueOptions: { snazzy: {} },
          namedQueueWorkers: { snazzy: nativeWorkerOptions({ concurrency: 0 }) },
        },
      })

      expect(workersFor(Background.defaultQueueName)[0]!.workerOptions['concurrency']).toEqual(0)
      expect(workersFor('snazzy')[0]!.workerOptions['concurrency']).toEqual(0)
    })

    it('falls back to defaultBullMQWorkerOptions concurrency when the native options omit it', () => {
      connectWorkers({
        defaultBullMQWorkerOptions: { concurrency: 99 },
        defaultQueueConnection: queueConnection,
        defaultWorkerConnection: workerConnection,
        nativeBullMQ: {
          namedQueueOptions: { snazzy: {} },
          namedQueueWorkers: { snazzy: nativeWorkerOptions() },
        },
      })

      expect(workersFor(Background.defaultQueueName)[0]!.workerOptions['concurrency']).toEqual(99)
      expect(workersFor('snazzy')[0]!.workerOptions['concurrency']).toEqual(99)
    })
  })
})
