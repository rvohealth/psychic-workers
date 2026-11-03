import { PsychicApp } from '@rvoh/psychic'
import { Cluster } from 'ioredis'
import { PsychicAppWorkers } from '../../../src/package-exports/index.js'
import { PsychicBackgroundOptions } from '../../../src/types/background.js'
import { fakeRedisConnection } from '../../helpers/bullmqRecorders.js'
import { flushStatusEvents, lazyCluster, setClusterStatus } from '../../helpers/lazyCluster.js'

describe('PsychicAppWorkers.init waiting for Cluster queue connections', () => {
  let clusters: Cluster[]

  function track(cluster: Cluster) {
    clusters.push(cluster)
    return cluster
  }

  function initWith(backgroundOptions: PsychicBackgroundOptions | undefined) {
    return PsychicAppWorkers.init(PsychicApp.getOrFail(), app => {
      if (backgroundOptions) app.set('background', backgroundOptions)
    })
  }

  function settlement(promise: Promise<unknown>) {
    const state: { result: 'pending' | 'resolved' | 'rejected' } = { result: 'pending' }
    promise.then(
      () => (state.result = 'resolved'),
      () => (state.result = 'rejected'),
    )
    return state
  }

  beforeEach(() => {
    clusters = []
  })

  afterEach(() => {
    vi.restoreAllMocks()
    clusters.forEach(cluster => cluster.disconnect())
  })

  // every source of a queue connection, with the Cluster in the position that source resolves to
  const sources: [string, (cluster: Cluster) => PsychicBackgroundOptions][] = [
    [
      'the simple default',
      cluster => ({ defaultQueueConnection: cluster, defaultWorkerConnection: undefined }),
    ],
    [
      'a simple named workstream',
      cluster => ({
        defaultQueueConnection: fakeRedisConnection('default'),
        defaultWorkerConnection: undefined,
        namedWorkstreams: [{ name: 'own', queueConnection: cluster }],
      }),
    ],
    [
      'the transitional default',
      cluster => ({
        defaultQueueConnection: fakeRedisConnection('default'),
        defaultWorkerConnection: undefined,
        transitionalWorkstreams: { defaultQueueConnection: cluster, defaultWorkerConnection: undefined },
      }),
    ],
    [
      'a transitional named workstream',
      cluster => ({
        defaultQueueConnection: fakeRedisConnection('default'),
        defaultWorkerConnection: undefined,
        transitionalWorkstreams: {
          defaultQueueConnection: fakeRedisConnection('transitionalDefault'),
          defaultWorkerConnection: undefined,
          namedWorkstreams: [{ name: 'own', queueConnection: cluster }],
        },
      }),
    ],
    ['the native default', cluster => ({ nativeBullMQ: {}, defaultQueueConnection: cluster })],
    [
      'the native default from defaultQueueOptions, overriding a top-level default',
      cluster => ({
        nativeBullMQ: { defaultQueueOptions: { queueConnection: cluster } },
        defaultQueueConnection: fakeRedisConnection('overridden'),
      }),
    ],
    [
      'a native named queue',
      cluster => ({
        nativeBullMQ: { namedQueueOptions: { own: { queueConnection: cluster } } },
        defaultQueueConnection: fakeRedisConnection('default'),
      }),
    ],
  ]

  sources.forEach(([source, build]) => {
    it(`does not resolve while ${source} is a Cluster that is not ready, and resolves once it is`, async () => {
      const cluster = track(lazyCluster('connect'))

      const state = settlement(initWith(build(cluster)))
      await flushStatusEvents()
      expect(state.result).toEqual('pending')

      setClusterStatus(cluster, 'ready')
      await flushStatusEvents()
      expect(state.result).toEqual('resolved')
    })
  })

  it('waits for a Cluster shared by the default and a named workstream once', async () => {
    const shared = track(lazyCluster('connect'))

    const state = settlement(
      initWith({
        defaultQueueConnection: shared,
        defaultWorkerConnection: undefined,
        namedWorkstreams: [{ name: 'inherits' }, { name: 'own', queueConnection: shared }],
      }),
    )
    setClusterStatus(shared, 'ready')
    await flushStatusEvents()

    expect(state.result).toEqual('resolved')
  })

  context('when there is nothing to wait for', () => {
    it('returns without background options', async () => {
      await expect(initWith(undefined)).resolves.toBeInstanceOf(PsychicAppWorkers)
    })

    it('returns for a standalone-style connection and a Cluster already ready', async () => {
      const ready = track(lazyCluster('ready'))

      await initWith({
        defaultQueueConnection: fakeRedisConnection('standalone'),
        defaultWorkerConnection: undefined,
        namedWorkstreams: [{ name: 'ready', queueConnection: ready }],
      })
    })

    it('returns without connecting a lazyConnect Cluster at wait', async () => {
      const waiting = track(lazyCluster('wait'))
      const connect = vi.spyOn(waiting, 'connect')

      await initWith({ defaultQueueConnection: waiting, defaultWorkerConnection: undefined })

      expect(connect).not.toHaveBeenCalled()
      expect(waiting.status).toEqual('wait')
    })

    it('does not wait on a worker connection', async () => {
      const notReady = track(lazyCluster('connect'))

      await initWith({
        defaultQueueConnection: fakeRedisConnection('queue'),
        defaultWorkerConnection: notReady,
      })
    })
  })

  context('when a Cluster cannot become ready', () => {
    it('rejects init, disconnects the Clusters it was still waiting on, and registers nothing', async () => {
      const cached = PsychicAppWorkers.getOrFail()
      const ends = track(lazyCluster('connecting'))
      const stillConnecting = track(lazyCluster('connecting'))
      const disconnect = vi.spyOn(stillConnecting, 'disconnect').mockImplementation(() => undefined)

      const rejection = expect(
        initWith({
          defaultQueueConnection: ends,
          defaultWorkerConnection: undefined,
          namedWorkstreams: [{ name: 'other', queueConnection: stillConnecting }],
        }),
      ).rejects.toThrow('Failed to refresh slots cache.')
      // init awaits the callback before it starts listening
      await flushStatusEvents()
      ends.emit('error', new Error('Failed to refresh slots cache.'))
      setClusterStatus(ends, 'end')
      await rejection

      expect(disconnect).toHaveBeenCalledOnce()
      // a failed boot leaves the previous cached app in place
      expect(PsychicAppWorkers.getOrFail()).toBe(cached)
    })
  })
})
