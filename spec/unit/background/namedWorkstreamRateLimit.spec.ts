import { Redis } from 'ioredis'
import nameToRedisQueueName from '../../../src/background/helpers/nameToRedisQueueName.js'
import { Background, PsychicAppWorkers } from '../../../src/package-exports/index.js'
import { PsychicBackgroundWorkstreamOptions } from '../../../src/psychic-app-workers/index.js'
import { PsychicBackgroundOptions } from '../../../src/types/background.js'
import { fakeRedisConnection, installBullMQRecorders } from '../../helpers/bullmqRecorders.js'

/** the typed shape, which an untyped config need not honor */
type RateLimit = NonNullable<PsychicBackgroundWorkstreamOptions['rateLimit']>

/**
 * A named workstream's `rateLimit: { max, duration }` is written onto each of
 * that workstream's workers twice: as BullMQ Pro's `group.limit` (as it always
 * was) and as open-source BullMQ's `limiter`, so the one field rate-limits the
 * workstream on either build. The `limiter` write lands after the
 * `defaultBullMQWorkerOptions` spread, so a workstream's own `rateLimit` wins
 * over a global limiter, and it is a conditional spread, so a workstream
 * without `rateLimit` adds no `limiter` key of its own.
 */
describe('rateLimit on a named workstream (simple mode)', () => {
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

  it('constructs every one of the workstream’s workerCount workers with limiter, alongside group.limit', () => {
    connectWorkers({
      defaultQueueConnection: queueConnection,
      defaultWorkerConnection: workerConnection,
      namedWorkstreams: [{ workerCount: 3, name: 'snazzy', rateLimit: { max: 5, duration: 1000 } }],
    })

    const workers = workersFor('snazzy')
    expect(workers).toHaveLength(3)

    for (const worker of workers) {
      expect(worker.workerOptions['limiter']).toEqual({ max: 5, duration: 1000 })
      expect(worker.workerOptions['group']).toEqual({ id: 'snazzy', limit: { max: 5, duration: 1000 } })
    }
  })

  it('adds no limiter key to the default workstream or to other named workstreams', () => {
    connectWorkers({
      defaultQueueConnection: queueConnection,
      defaultWorkerConnection: workerConnection,
      defaultWorkstream: { workerCount: 2 },
      namedWorkstreams: [
        { workerCount: 2, name: 'plain' },
        { workerCount: 1, name: 'snazzy', rateLimit: { max: 5, duration: 1000 } },
      ],
    })

    // `not.toHaveProperty` rather than `toBeUndefined`: under
    // exactOptionalPropertyTypes the key must be absent, not undefined
    const defaultWorkers = workersFor(Background.defaultQueueName)
    expect(defaultWorkers).toHaveLength(2)
    for (const worker of defaultWorkers) expect(worker.workerOptions).not.toHaveProperty('limiter')

    const plainWorkers = workersFor('plain')
    expect(plainWorkers).toHaveLength(2)
    for (const worker of plainWorkers) {
      expect(worker.workerOptions).not.toHaveProperty('limiter')
      expect(worker.workerOptions['group']).toEqual({ id: 'plain', limit: undefined })
    }

    expect(workersFor('snazzy')[0]!.workerOptions['limiter']).toEqual({ max: 5, duration: 1000 })
  })

  context('with a global defaultBullMQWorkerOptions.limiter', () => {
    it('is inherited unchanged by the default workstream and by named workstreams without rateLimit', () => {
      connectWorkers({
        defaultBullMQWorkerOptions: { limiter: { max: 50, duration: 60000 } },
        defaultQueueConnection: queueConnection,
        defaultWorkerConnection: workerConnection,
        namedWorkstreams: [{ workerCount: 1, name: 'plain' }],
      })

      expect(workersFor(Background.defaultQueueName)[0]!.workerOptions['limiter']).toEqual({
        max: 50,
        duration: 60000,
      })
      expect(workersFor('plain')[0]!.workerOptions['limiter']).toEqual({ max: 50, duration: 60000 })
    })

    it('is overridden on a named workstream that sets its own rateLimit', () => {
      connectWorkers({
        defaultBullMQWorkerOptions: { limiter: { max: 50, duration: 60000 } },
        defaultQueueConnection: queueConnection,
        defaultWorkerConnection: workerConnection,
        namedWorkstreams: [
          { workerCount: 2, name: 'snazzy', rateLimit: { max: 5, duration: 1000 } },
          { workerCount: 1, name: 'plain' },
        ],
      })

      // the workstream write comes after the global spread, so it always wins
      for (const worker of workersFor('snazzy')) {
        expect(worker.workerOptions['limiter']).toEqual({ max: 5, duration: 1000 })
      }

      // and only on that workstream
      expect(workersFor('plain')[0]!.workerOptions['limiter']).toEqual({ max: 50, duration: 60000 })
      expect(workersFor(Background.defaultQueueName)[0]!.workerOptions['limiter']).toEqual({
        max: 50,
        duration: 60000,
      })
    })
  })

  context('transitional workstreams', () => {
    it('writes each twin’s limiter from its own rateLimit', () => {
      connectWorkers({
        defaultQueueConnection: queueConnection,
        defaultWorkerConnection: workerConnection,
        namedWorkstreams: [{ workerCount: 1, name: 'snazzy' }],
        transitionalWorkstreams: {
          defaultQueueConnection: queueConnection,
          defaultWorkerConnection: workerConnection,
          namedWorkstreams: [{ workerCount: 2, name: 'snazzy', rateLimit: { max: 5, duration: 1000 } }],
        },
      })

      // a transitional workstream's queue has the same formatted name as its
      // current twin; the current workers are constructed first
      const [currentWorker, ...transitionalWorkers] = workersFor('snazzy')
      expect(transitionalWorkers).toHaveLength(2)

      expect(currentWorker!.workerOptions).not.toHaveProperty('limiter')
      for (const worker of transitionalWorkers) {
        expect(worker.workerOptions['limiter']).toEqual({ max: 5, duration: 1000 })
        expect(worker.workerOptions['group']).toEqual({ id: 'snazzy', limit: { max: 5, duration: 1000 } })
      }
    })
  })

  /**
   * The type requires both fields, but a JavaScript config, a cast, or parsed
   * JSON can still hand `connect()` a partial `rateLimit`, and the `number`
   * type admits a fraction or a value past Redis's integer range. Open-source
   * BullMQ forwards a worker `limiter` unvalidated: a missing field or an
   * oversize one answers every job fetch on that workstream with an error that
   * never names `rateLimit`, and a fractional `duration` is floored to 0ms and
   * rate limits nothing, so `connect()` refuses all of them up front, before
   * any queue or worker exists.
   */
  context('a rateLimit that reaches connect() without a positive integer max and duration', () => {
    it.each([
      [{ max: 1 }, 'duration', 'undefined'],
      [{ duration: 1000 }, 'max', 'undefined'],
      [{ max: 0, duration: 1000 }, 'max', '0'],
      [{ max: 1, duration: Infinity }, 'duration', 'Infinity'],
      [{ max: '1', duration: 1000 }, 'max', '"1"'],
      // typed-valid, but a fractional duration rate limits nothing (BullMQ
      // floors it to 0ms), and one past 2^63 fails every fetch in Redis
      [{ max: 1, duration: 0.5 }, 'duration', '0.5'],
      [{ max: 1, duration: 1e20 }, 'duration', '100000000000000000000'],
      [{ max: 1.5, duration: 1000 }, 'max', '1.5'],
    ])(
      'with rateLimit %o, throws naming the workstream and its `%s` field, having built nothing',
      (rateLimit, field, received) => {
        const connect = () =>
          connectWorkers({
            defaultQueueConnection: queueConnection,
            defaultWorkerConnection: workerConnection,
            namedWorkstreams: [
              { workerCount: 1, name: 'plain' },
              { workerCount: 1, name: 'snazzy', rateLimit: rateLimit as unknown as RateLimit },
            ],
          })

        expect(connect).toThrow(
          `\`rateLimit\` on the \`snazzy\` entry in \`namedWorkstreams\` is missing a usable \`${field}\` (got ${received})`,
        )
        expect(bullmq.queues).toHaveLength(0)
        expect(bullmq.workers).toHaveLength(0)
      },
    )

    it('names the transitionalWorkstreams entry when the partial rateLimit is on a transitional workstream', () => {
      const connect = () =>
        connectWorkers({
          defaultQueueConnection: queueConnection,
          defaultWorkerConnection: workerConnection,
          namedWorkstreams: [{ workerCount: 1, name: 'snazzy', rateLimit: { max: 5, duration: 1000 } }],
          transitionalWorkstreams: {
            defaultQueueConnection: queueConnection,
            defaultWorkerConnection: workerConnection,
            namedWorkstreams: [
              { workerCount: 1, name: 'snazzy', rateLimit: { max: 5 } as unknown as RateLimit },
            ],
          },
        })

      expect(connect).toThrow(
        '`rateLimit` on the `snazzy` entry in `transitionalWorkstreams.namedWorkstreams` is missing a usable `duration` (got undefined)',
      )
      expect(bullmq.queues).toHaveLength(0)
      expect(bullmq.workers).toHaveLength(0)
    })
  })
})
