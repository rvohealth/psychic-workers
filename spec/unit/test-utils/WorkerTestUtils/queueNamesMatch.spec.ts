import { Cluster } from 'ioredis'
import { Queue } from 'bullmq'
import parallelTestSafeQueueName from '../../../../src/background/helpers/parallelTestSafeQueueName.js'
import { queueNamesMatch } from '../../../../src/test-utils/WorkerTestUtils.js'
import { fakeRedisConnection } from '../../../helpers/bullmqRecorders.js'

/**
 * exercises the shared name-matching predicate directly against a duck-typed
 * queue object rather than through `work()`/`workScheduled()` or the shared
 * `background` singleton: those two methods only ever run against the
 * module-level `background` singleton, whose queue set is fixed to
 * non-cluster config by the global `beforeEach` before any test body runs
 * (`spec/unit/setup/hooks.ts:19-22`), so there is no route to a real
 * cluster-backed queue through them.
 *
 * a real `bullmq.Queue` bound even to a lazy, never-connected `Cluster` fires
 * background reconnect attempts (`Queue`'s constructor unconditionally calls
 * `waitUntilReady()` -> `client.connect()`), polluting test output with
 * `ClusterAllFailedError` traces. A duck-typed queue object paired with the
 * same real `Cluster` instance produces the identical, correct assertion with
 * zero connection activity, matching the existing `fakeRedisConnection` cast
 * convention.
 */
function duckTypedQueue(name: string, connection: unknown): Queue {
  return { name, opts: { connection } } as unknown as Queue
}

describe('queueNamesMatch', () => {
  context('when the queue was built with a Cluster connection', () => {
    it('matches a compare name wrapped in a redis hash tag', () => {
      const clusterConnection = new Cluster([{ host: '127.0.0.1', port: 6379 }], { lazyConnect: true })

      try {
        const queue = duckTypedQueue('{TestQueue}', clusterConnection)

        expect(queueNamesMatch(queue, 'TestQueue')).toBe(true)
      } finally {
        clusterConnection.disconnect()
      }
    })

    it('does not match a compare name whose hash tag was left unclosed', () => {
      const clusterConnection = new Cluster([{ host: '127.0.0.1', port: 6379 }], { lazyConnect: true })

      try {
        // this is the bug being fixed: the old comparison also accepted an
        // unclosed `{TestQueue` as a match, which is not a real cluster queue
        // name `nameToRedisQueueName` would ever produce
        const queue = duckTypedQueue('{TestQueue', clusterConnection)

        expect(queueNamesMatch(queue, 'TestQueue')).toBe(false)
      } finally {
        clusterConnection.disconnect()
      }
    })

    it('does not match a compare name left unwrapped', () => {
      const clusterConnection = new Cluster([{ host: '127.0.0.1', port: 6379 }], { lazyConnect: true })

      try {
        const queue = duckTypedQueue('TestQueue', clusterConnection)

        expect(queueNamesMatch(queue, 'TestQueue')).toBe(false)
      } finally {
        clusterConnection.disconnect()
      }
    })
  })

  context('when the queue was built with a non-cluster connection', () => {
    it('matches the parallel-test-safe queue name', () => {
      const connection = fakeRedisConnection('non-cluster')
      const queue = duckTypedQueue(parallelTestSafeQueueName('TestQueue'), connection)

      expect(queueNamesMatch(queue, 'TestQueue')).toBe(true)
    })

    it('does not match a name wrapped in a redis hash tag', () => {
      const connection = fakeRedisConnection('non-cluster')
      const queue = duckTypedQueue(`{${parallelTestSafeQueueName('TestQueue')}}`, connection)

      expect(queueNamesMatch(queue, 'TestQueue')).toBe(false)
    })

    it('does not match an unrelated queue name', () => {
      const connection = fakeRedisConnection('non-cluster')
      const queue = duckTypedQueue(parallelTestSafeQueueName('OtherQueue'), connection)

      expect(queueNamesMatch(queue, 'TestQueue')).toBe(false)
    })
  })
})
