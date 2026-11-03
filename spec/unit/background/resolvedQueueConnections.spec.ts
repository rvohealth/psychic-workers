import { Redis } from 'ioredis'
import resolvedQueueConnections from '../../../src/background/helpers/resolvedQueueConnections.js'
import { PsychicBackgroundOptions } from '../../../src/types/background.js'
import { fakeRedisConnection } from '../../helpers/bullmqRecorders.js'

describe('resolvedQueueConnections', () => {
  let defaultQueue: Redis
  let defaultWorker: Redis
  let namedQueue: Redis
  let namedWorker: Redis
  let transitionalDefaultQueue: Redis
  let transitionalNamedQueue: Redis

  beforeEach(() => {
    defaultQueue = fakeRedisConnection('defaultQueue')
    defaultWorker = fakeRedisConnection('defaultWorker')
    namedQueue = fakeRedisConnection('namedQueue')
    namedWorker = fakeRedisConnection('namedWorker')
    transitionalDefaultQueue = fakeRedisConnection('transitionalDefaultQueue')
    transitionalNamedQueue = fakeRedisConnection('transitionalNamedQueue')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function expectSame(actual: unknown[], expected: unknown[]) {
    expect(actual).toHaveLength(expected.length)
    expected.forEach((connection, index) => expect(actual[index]).toBe(connection))
  }

  function expectListed(backgroundOptions: PsychicBackgroundOptions, expected: unknown[]) {
    expectSame(resolvedQueueConnections(backgroundOptions), expected)
  }

  it('lists nothing when no background options were set', () => {
    expect(resolvedQueueConnections(undefined)).toEqual([])
  })

  context('simple mode', () => {
    it('lists the default connection once, for the default queue and for workstreams that inherit it', () => {
      expectListed(
        {
          defaultQueueConnection: defaultQueue,
          defaultWorkerConnection: defaultWorker,
          namedWorkstreams: [{ name: 'inherits' }, { name: 'alsoInherits' }],
        },
        [defaultQueue],
      )
    })

    it('lists a named workstream queueConnection but never a worker connection', () => {
      expectListed(
        {
          defaultQueueConnection: defaultQueue,
          defaultWorkerConnection: defaultWorker,
          namedWorkstreams: [{ name: 'own', queueConnection: namedQueue, workerConnection: namedWorker }],
        },
        [defaultQueue, namedQueue],
      )
    })

    it('lists transitional default and named queue connections', () => {
      expectListed(
        {
          defaultQueueConnection: defaultQueue,
          defaultWorkerConnection: undefined,
          namedWorkstreams: [{ name: 'own', queueConnection: namedQueue }],
          transitionalWorkstreams: {
            defaultQueueConnection: transitionalDefaultQueue,
            defaultWorkerConnection: undefined,
            namedWorkstreams: [
              { name: 'transitionalInherits' },
              { name: 'transitionalOwn', queueConnection: transitionalNamedQueue },
            ],
          },
        },
        [defaultQueue, namedQueue, transitionalDefaultQueue, transitionalNamedQueue],
      )
    })

    it('lists a connection shared between the current and transitional workstreams once', () => {
      expectListed(
        {
          defaultQueueConnection: defaultQueue,
          defaultWorkerConnection: undefined,
          transitionalWorkstreams: {
            defaultQueueConnection: defaultQueue,
            defaultWorkerConnection: undefined,
            namedWorkstreams: [{ name: 'shared', queueConnection: namedQueue }],
          },
          namedWorkstreams: [{ name: 'shared', queueConnection: namedQueue }],
        },
        [defaultQueue, namedQueue],
      )
    })
  })

  context('native mode', () => {
    it('lists the top-level default connection for the default queue and for inheriting named queues', () => {
      expectListed(
        {
          nativeBullMQ: { namedQueueOptions: { inherits: {}, alsoInherits: {} } },
          defaultQueueConnection: defaultQueue,
          defaultWorkerConnection: defaultWorker,
        },
        [defaultQueue],
      )
    })

    it('lists defaultQueueOptions.queueConnection instead of a top-level default it overrides', () => {
      expectListed(
        {
          nativeBullMQ: {
            defaultQueueOptions: { queueConnection: namedQueue, workerConnection: namedWorker },
            namedQueueOptions: { inherits: {} },
          },
          defaultQueueConnection: defaultQueue,
          defaultWorkerConnection: defaultWorker,
        },
        [namedQueue],
      )
    })

    it('lists named queues own queueConnection but never a worker connection', () => {
      expectListed(
        {
          nativeBullMQ: {
            namedQueueOptions: { own: { queueConnection: namedQueue, workerConnection: namedWorker } },
          },
          defaultQueueConnection: defaultQueue,
          defaultWorkerConnection: defaultWorker,
        },
        [defaultQueue, namedQueue],
      )
    })
  })
})
