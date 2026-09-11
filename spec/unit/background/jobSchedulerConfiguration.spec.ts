import { Redis } from 'ioredis'
import DuplicateNamedWorkstream from '../../../src/error/background/DuplicateNamedWorkstream.js'
import { Background, PsychicAppWorkers } from '../../../src/package-exports/index.js'
import { PsychicBackgroundOptions } from '../../../src/types/background.js'
import { fakeRedisConnection, installBullMQRecorders } from '../../helpers/bullmqRecorders.js'

describe('Background job scheduler topology configuration', () => {
  const bullmq = installBullMQRecorders()

  let currentConnection: Redis
  let transitionalConnection: Redis

  beforeEach(() => {
    currentConnection = fakeRedisConnection('current')
    transitionalConnection = fakeRedisConnection('transitional')
  })

  function connect(options: PsychicBackgroundOptions) {
    PsychicAppWorkers.getOrFail().set('background', options)
    const background = new Background()
    background.connect()
    return background
  }

  it('rejects duplicate current named workstreams before constructing any queue', () => {
    expect(() =>
      connect({
        defaultQueueConnection: currentConnection,
        defaultWorkerConnection: undefined,
        namedWorkstreams: [{ name: 'mailers' }, { name: 'mailers' }],
      }),
    ).toThrow(DuplicateNamedWorkstream)

    expect(bullmq.queues).toEqual([])
  })

  it('rejects duplicate transitional named workstreams before constructing any queue', () => {
    expect(() =>
      connect({
        defaultQueueConnection: currentConnection,
        defaultWorkerConnection: undefined,
        transitionalWorkstreams: {
          defaultQueueConnection: transitionalConnection,
          defaultWorkerConnection: undefined,
          namedWorkstreams: [{ name: 'mailers' }, { name: 'mailers' }],
        },
      }),
    ).toThrow(DuplicateNamedWorkstream)

    expect(bullmq.queues).toEqual([])
  })

  it('allows the same named route once in current and transitional topology', () => {
    const background = connect({
      defaultQueueConnection: currentConnection,
      defaultWorkerConnection: undefined,
      namedWorkstreams: [{ name: 'mailers' }],
      transitionalWorkstreams: {
        defaultQueueConnection: transitionalConnection,
        defaultWorkerConnection: undefined,
        namedWorkstreams: [{ name: 'mailers' }],
      },
    })

    expect(background.queues).toHaveLength(4)
    expect(bullmq.queues).toHaveLength(4)
  })
})
