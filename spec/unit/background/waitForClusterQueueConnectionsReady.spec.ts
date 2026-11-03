import { Cluster } from 'ioredis'
import waitForClusterQueueConnectionsReady, {
  CLUSTER_READY_TIMEOUT_MS,
} from '../../../src/background/helpers/waitForClusterQueueConnectionsReady.js'
import { fakeRedisConnection } from '../../helpers/bullmqRecorders.js'
import { flushStatusEvents, lazyCluster, setClusterStatus } from '../../helpers/lazyCluster.js'

describe('waitForClusterQueueConnectionsReady', () => {
  let clusters: Cluster[]

  function track(cluster: Cluster) {
    clusters.push(cluster)
    return cluster
  }

  function settlement(promise: Promise<void>) {
    const state: { result: 'pending' | 'resolved' | 'rejected'; error?: unknown } = { result: 'pending' }
    promise.then(
      () => (state.result = 'resolved'),
      (error: unknown) => {
        state.result = 'rejected'
        state.error = error
      },
    )
    return state
  }

  function listenerCounts(cluster: Cluster) {
    return ['error', 'end', 'ready'].map(event => cluster.listenerCount(event))
  }

  beforeEach(() => {
    clusters = []
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    clusters.forEach(cluster => cluster.disconnect())
  })

  context('connections that need no wait', () => {
    it('returns at once for no connections, a standalone-style connection, and a ready Cluster', async () => {
      const ready = track(lazyCluster('ready'))
      const readyListeners = listenerCounts(ready)

      await waitForClusterQueueConnectionsReady([])
      await waitForClusterQueueConnectionsReady([fakeRedisConnection('standalone'), ready])

      expect(listenerCounts(ready)).toEqual(readyListeners)
    })

    it('skips a lazyConnect Cluster at wait, neither connecting nor changing its status', async () => {
      const waiting = track(lazyCluster('wait'))
      const connect = vi.spyOn(waiting, 'connect')

      await waitForClusterQueueConnectionsReady([waiting])

      expect(connect).not.toHaveBeenCalled()
      expect(waiting.status).toEqual('wait')
    })
  })

  context('a Cluster that is not ready yet', () => {
    it('resolves only once the Cluster is ready', async () => {
      const cluster = track(lazyCluster('connect'))

      const state = settlement(waitForClusterQueueConnectionsReady([cluster]))
      await flushStatusEvents()
      expect(state.result).toEqual('pending')

      setClusterStatus(cluster, 'ready')
      await flushStatusEvents()
      expect(state.result).toEqual('resolved')
    })

    it('waits for every Cluster, and not for the same Cluster twice', async () => {
      const first = track(lazyCluster('connecting'))
      const second = track(lazyCluster('connect'))

      const state = settlement(waitForClusterQueueConnectionsReady([first, second, first]))

      setClusterStatus(first, 'ready')
      await flushStatusEvents()
      expect(state.result).toEqual('pending')

      setClusterStatus(second, 'ready')
      await flushStatusEvents()
      expect(state.result).toEqual('resolved')
    })

    it('still resolves when an error is followed by ready', async () => {
      const cluster = track(lazyCluster('connecting'))

      const state = settlement(waitForClusterQueueConnectionsReady([cluster]))
      cluster.emit('error', new Error('Failed to refresh slots cache.'))
      await flushStatusEvents()
      expect(state.result).toEqual('pending')

      setClusterStatus(cluster, 'ready')
      await flushStatusEvents()
      expect(state.result).toEqual('resolved')
    })

    it('waits again for a Cluster that dropped after it was ready while another was still pending', async () => {
      const first = track(lazyCluster('connecting'))
      const second = track(lazyCluster('connecting'))

      const state = settlement(waitForClusterQueueConnectionsReady([first, second]))

      setClusterStatus(first, 'ready')
      await flushStatusEvents()
      setClusterStatus(first, 'reconnecting')
      await flushStatusEvents()

      setClusterStatus(second, 'ready')
      await flushStatusEvents()
      expect(state.result).toEqual('pending')

      setClusterStatus(first, 'ready')
      await flushStatusEvents()
      expect(state.result).toEqual('resolved')
    })

    it('removes its listeners once it resolves', async () => {
      const cluster = track(lazyCluster('connecting'))
      const before = listenerCounts(cluster)

      const promise = waitForClusterQueueConnectionsReady([cluster])
      expect(listenerCounts(cluster)).not.toEqual(before)

      setClusterStatus(cluster, 'ready')
      await promise

      expect(listenerCounts(cluster)).toEqual(before)
    })
  })

  context('a Cluster that cannot become ready', () => {
    it('rejects with the most recent error when the Cluster ends', async () => {
      const cluster = track(lazyCluster('connecting'))
      const before = listenerCounts(cluster)

      const state = settlement(waitForClusterQueueConnectionsReady([cluster]))
      cluster.emit('error', new Error('first'))
      cluster.emit('error', new Error('Failed to refresh slots cache.'))
      setClusterStatus(cluster, 'end')
      await flushStatusEvents()

      expect(state.result).toEqual('rejected')
      expect((state.error as Error).message).toEqual('Failed to refresh slots cache.')
      expect(listenerCounts(cluster)).toEqual(before)
    })

    it('rejects with a plain error when the Cluster ends having emitted none', async () => {
      const cluster = track(lazyCluster('connecting'))

      const promise = waitForClusterQueueConnectionsReady([cluster])
      setClusterStatus(cluster, 'end')

      await expect(promise).rejects.toThrow('ended before it was ready')
    })

    it('rejects at once for a Cluster that already ended, since ioredis never emits end again', async () => {
      const cluster = track(lazyCluster('end'))
      const before = listenerCounts(cluster)

      await expect(waitForClusterQueueConnectionsReady([cluster])).rejects.toThrow(
        'ended before it was ready',
      )
      expect(listenerCounts(cluster)).toEqual(before)
    })

    it('attaches nothing to a later Cluster once an earlier one that already ended has settled the wait', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const ended = track(lazyCluster('end'))
      const pending = track(lazyCluster('connecting'))
      const endedBefore = listenerCounts(ended)
      const before = listenerCounts(pending)

      await expect(waitForClusterQueueConnectionsReady([ended, pending])).rejects.toThrow(
        'ended before it was ready',
      )

      expect(listenerCounts(ended)).toEqual(endedBefore)
      expect(listenerCounts(pending)).toEqual(before)
      expect(vi.getTimerCount()).toEqual(0)
    })

    it('rejects when the bound passes, with the most recent emitted error', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const cluster = track(lazyCluster('connecting'))
      const before = listenerCounts(cluster)

      const rejection = expect(waitForClusterQueueConnectionsReady([cluster])).rejects.toThrow(
        'Failed to refresh slots cache.',
      )
      cluster.emit('error', new Error('Failed to refresh slots cache.'))

      await vi.advanceTimersByTimeAsync(CLUSTER_READY_TIMEOUT_MS)
      await rejection

      expect(listenerCounts(cluster)).toEqual(before)
      expect(vi.getTimerCount()).toEqual(0)
    })

    it('rejects when the bound passes with a plain timeout error if none was emitted', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const cluster = track(lazyCluster('connect'))

      const rejection = expect(waitForClusterQueueConnectionsReady([cluster])).rejects.toThrow(
        `Timed out after ${CLUSTER_READY_TIMEOUT_MS}ms`,
      )

      await vi.advanceTimersByTimeAsync(CLUSTER_READY_TIMEOUT_MS)
      await rejection
    })

    it('does not reject before the bound', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const cluster = track(lazyCluster('connect'))

      const state = settlement(waitForClusterQueueConnectionsReady([cluster]))
      await vi.advanceTimersByTimeAsync(CLUSTER_READY_TIMEOUT_MS - 1)

      expect(state.result).toEqual('pending')
    })

    it('disconnects every Cluster it waited on, however far each got, and leaves one ready at entry alone', async () => {
      const readyAtEntry = track(lazyCluster('ready'))
      const readyDuringWait = track(lazyCluster('connecting'))
      const neverReady = track(lazyCluster('connecting'))
      const standaloneDisconnect = vi.fn()
      const standalone = Object.assign(fakeRedisConnection('standalone'), {
        disconnect: standaloneDisconnect,
      })

      const disconnects = [readyAtEntry, readyDuringWait, neverReady].map(cluster =>
        vi.spyOn(cluster, 'disconnect').mockImplementation(() => undefined),
      )

      const promise = waitForClusterQueueConnectionsReady([
        readyAtEntry,
        readyDuringWait,
        neverReady,
        standalone,
      ])
      const rejection = expect(promise).rejects.toThrow('boom')
      setClusterStatus(readyDuringWait, 'ready')
      await flushStatusEvents()
      neverReady.emit('error', new Error('boom'))
      setClusterStatus(neverReady, 'end')
      await rejection

      expect(disconnects[0]).not.toHaveBeenCalled()
      expect(disconnects[1]).toHaveBeenCalledOnce()
      expect(disconnects[1]).toHaveBeenCalledWith()
      // 'end' is final, and disconnect() would rewrite it
      expect(disconnects[2]).not.toHaveBeenCalled()
      expect(standaloneDisconnect).not.toHaveBeenCalled()
    })

    it('cleans every wait up on the first rejection', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const ends = track(lazyCluster('connecting'))
      const pending = track(lazyCluster('connecting'))
      const before = listenerCounts(pending)

      const rejection = expect(waitForClusterQueueConnectionsReady([pending, ends])).rejects.toThrow()
      setClusterStatus(ends, 'end')
      await rejection

      expect(listenerCounts(pending)).toEqual(before)
      expect(vi.getTimerCount()).toEqual(0)
    })

    // a hand-set status holds no reconnect timer, so this one uses a real
    // non-lazy Cluster at a port nothing listens on. Only ioredis's timers are
    // faked: the refused connections are real I/O, hence the real waits
    it('leaves a real never-ready Cluster neither reconnecting nor logging an unhandled error per retry', async () => {
      const realSetTimeout = setTimeout
      const realDelay = (ms: number) => new Promise<void>(resolve => realSetTimeout(resolve, ms))
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

      const cluster = track(
        new Cluster([{ host: '127.0.0.1', port: 1 }], {
          enableOfflineQueue: false,
          slotsRefreshTimeout: 500,
          clusterRetryStrategy: () => 100,
        }),
      )
      // ioredis connects (and rejects, unhandled) on its own at construction; its own listeners are not ours
      const before = listenerCounts(cluster)

      const rejection = expect(waitForClusterQueueConnectionsReady([cluster])).rejects.toThrow(
        'Failed to refresh slots cache.',
      )
      for (let elapsed = 0; elapsed < CLUSTER_READY_TIMEOUT_MS; elapsed += 1000) {
        await vi.advanceTimersByTimeAsync(1000)
        await realDelay(5)
      }
      await rejection

      expect(['disconnecting', 'end']).toContain(cluster.status)
      expect(listenerCounts(cluster)).toEqual(before)

      // no retry timer survives: more time passing neither reconnects nor logs
      const statusAtRejection = cluster.status
      consoleError.mockClear()
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(1000)
        await realDelay(5)
      }

      expect(cluster.status).toEqual(statusAtRejection)
      expect(consoleError).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toEqual(0)
    }, 30_000)
  })
})
