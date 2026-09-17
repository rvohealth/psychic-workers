import { Queue } from 'bullmq'
import { Cluster } from 'ioredis'
import parallelTestSafeQueueName from '../../../../src/background/helpers/parallelTestSafeQueueName.js'
import { queueNamesMatch } from '../../../../src/test-utils/WorkerTestUtils.js'
import { fakeRedisConnection } from '../../../helpers/bullmqRecorders.js'

/**
 * a real `bullmq.Queue` bound even to a lazy, never-connected `Cluster` fires
 * background reconnect attempts, polluting test output with
 * `ClusterAllFailedError` traces. A duck-typed queue paired with the same real
 * `Cluster` instance gives the identical assertion with no connection activity.
 */
function duckTypedQueue(name: string, connection: unknown): Queue {
  return { name, opts: { connection } } as unknown as Queue
}

describe('queueNamesMatch', () => {
  function withCluster(callback: (connection: Cluster) => void) {
    const connection = new Cluster([{ host: '127.0.0.1', port: 6379 }], { lazyConnect: true })
    try {
      callback(connection)
    } finally {
      connection.disconnect()
    }
  }

  it('matches a cluster queue name whose hash tag is closed', () => {
    withCluster(connection => {
      expect(queueNamesMatch(duckTypedQueue('{TestQueue}', connection), 'TestQueue')).toBe(true)
    })
  })

  it('does not match a cluster queue name whose hash tag was left unclosed', () => {
    // this is the bug being fixed: the old comparison also accepted an unclosed
    // `{TestQueue`, which `nameToRedisQueueName` would never produce
    withCluster(connection => {
      expect(queueNamesMatch(duckTypedQueue('{TestQueue', connection), 'TestQueue')).toBe(false)
    })
  })

  it('does not match an unwrapped name on a cluster connection', () => {
    withCluster(connection => {
      expect(queueNamesMatch(duckTypedQueue('TestQueue', connection), 'TestQueue')).toBe(false)
    })
  })

  it('does not match a hash-tagged name on a non-cluster connection', () => {
    const connection = fakeRedisConnection('non-cluster')
    const queue = duckTypedQueue(`{${parallelTestSafeQueueName('TestQueue')}}`, connection)

    expect(queueNamesMatch(queue, 'TestQueue')).toBe(false)
  })
})
