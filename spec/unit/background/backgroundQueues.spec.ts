import { Redis } from 'ioredis'
import backgroundQueues, {
  distinctQueueConnections,
} from '../../../src/background/helpers/backgroundQueues.js'
import { PsychicBackgroundOptions } from '../../../src/types/background.js'
import { fakeRedisConnection } from '../../helpers/bullmqRecorders.js'

describe('distinctQueueConnections', () => {
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
    expectSame(distinctQueueConnections(backgroundOptions), expected)
  }

  it('lists nothing when no background options were set', () => {
    expect(distinctQueueConnections(undefined)).toEqual([])
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

describe('backgroundQueues', () => {
  const topLevelQueue = fakeRedisConnection('topLevelQueue')
  const topLevelWorker = fakeRedisConnection('topLevelWorker')
  const nativeQueue = fakeRedisConnection('nativeQueue')
  const nativeWorker = fakeRedisConnection('nativeWorker')
  const ownQueue = fakeRedisConnection('ownQueue')
  const ownWorker = fakeRedisConnection('ownWorker')

  const label = (connection: unknown) => (connection as { __label?: string } | undefined)?.__label

  // [name, transitional, queue connection, worker connection, connections to close]
  const summary = (backgroundOptions: PsychicBackgroundOptions | undefined) =>
    backgroundQueues(backgroundOptions).map(queue => [
      queue.name,
      queue.transitional,
      label(queue.queueConnection),
      label(queue.workerConnection),
      queue.ownConnections.map(label),
    ])

  it('lists nothing when no background options were set', () => {
    expect(backgroundQueues(undefined)).toEqual([])
  })

  it('simple mode: a named workstream falls back to the defaults, and transitional queues come last', () => {
    expect(
      summary({
        defaultQueueConnection: topLevelQueue,
        defaultWorkerConnection: topLevelWorker,
        namedWorkstreams: [
          { name: 'inherits' },
          { name: 'own', queueConnection: ownQueue, workerConnection: ownWorker },
        ],
        transitionalWorkstreams: {
          defaultQueueConnection: nativeQueue,
          defaultWorkerConnection: undefined,
          namedWorkstreams: [{ name: 'inherits' }],
        },
      }),
    ).toEqual([
      [undefined, false, 'topLevelQueue', 'topLevelWorker', ['topLevelQueue', 'topLevelWorker']],
      ['inherits', false, 'topLevelQueue', 'topLevelWorker', []],
      ['own', false, 'ownQueue', 'ownWorker', ['ownQueue', 'ownWorker']],
      [undefined, true, 'nativeQueue', undefined, ['nativeQueue']],
      ['inherits', true, 'nativeQueue', undefined, []],
    ])
  })

  it('native mode: defaultQueueOptions beat the top-level defaults, and named queues fall back to them', () => {
    expect(
      summary({
        nativeBullMQ: {
          defaultQueueOptions: { queueConnection: nativeQueue, workerConnection: nativeWorker },
          namedQueueOptions: {
            inherits: {},
            own: { queueConnection: ownQueue, workerConnection: ownWorker },
          },
        },
        defaultQueueConnection: topLevelQueue,
        defaultWorkerConnection: topLevelWorker,
      }),
    ).toEqual([
      [undefined, false, 'nativeQueue', 'nativeWorker', ['nativeQueue', 'nativeWorker']],
      ['inherits', false, 'nativeQueue', 'nativeWorker', []],
      ['own', false, 'ownQueue', 'ownWorker', ['ownQueue', 'ownWorker']],
    ])
  })

  it('native mode: the default falls back to the top-level defaults, and a missing connection stays undefined', () => {
    expect(
      summary({
        nativeBullMQ: {},
        defaultQueueConnection: topLevelQueue,
        defaultWorkerConnection: undefined,
      }),
    ).toEqual([[undefined, false, 'topLevelQueue', undefined, ['topLevelQueue']]])
    expect(
      summary({ nativeBullMQ: { namedQueueOptions: { orphan: {} } }, defaultWorkerConnection: undefined }),
    ).toEqual([
      [undefined, false, undefined, undefined, []],
      ['orphan', false, undefined, undefined, []],
    ])
  })
})
