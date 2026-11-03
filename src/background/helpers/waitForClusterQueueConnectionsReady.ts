import { Cluster } from 'ioredis'
import type { RedisOrRedisClusterConnection } from '../../psychic-app-workers/index.js'

/**
 * @internal
 *
 * How long the wait may take before the boot fails. It has to outlast one
 * failed slot refresh plus a retry under the create-psychic scaffold's settings
 * (10s `slotsRefreshTimeout`, 1-20s retry delay) with room for the next
 * attempt to succeed. Deliberately not a public option.
 */
export const CLUSTER_READY_TIMEOUT_MS = 60_000

/**
 * @internal
 *
 * Resolves once every ioredis `Cluster` among `connections` is `'ready'`.
 *
 * A `Cluster` built with `enableOfflineQueue: false` reaches `'connect'` before
 * `'ready'`, and BullMQ treats `'connect'` as ready, so a `Queue` built then
 * rejects its first command. Standalone `Redis` connections are not waited on,
 * nor is a `Cluster` already `'ready'`, nor a `lazyConnect` one still at
 * `'wait'`: BullMQ connects that one on first use and holds the first command
 * until it is `'ready'`, and it is never connected here.
 *
 * Rejects if a waited-on Cluster ends, or when `timeoutMs` passes. The error is
 * the most recent one ioredis emitted for that Cluster (any Cluster, on a
 * timeout), or a plain `Error` when it emitted none. A failed wait calls
 * `disconnect()` on every Cluster it was waiting on whose status is not
 * `'end'`, so ioredis stops reconnecting and stops logging an unhandled error
 * on every retry now that no `'error'` listener remains. (Never `disconnect(true)`,
 * which keeps reconnecting.)
 *
 * Every listener and the timer are removed when the wait settles. A Cluster
 * that drops after reaching `'ready'` while a sibling is still pending is waited
 * on again, under the same bound.
 */
export default async function waitForClusterQueueConnectionsReady(
  connections: RedisOrRedisClusterConnection[],
  { timeoutMs = CLUSTER_READY_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<void> {
  const clusters = connections.filter(
    (connection): connection is Cluster =>
      connection instanceof Cluster && connection.status !== 'ready' && connection.status !== 'wait',
  )
  if (!clusters.length) return

  await new Promise<void>((resolve, reject) => {
    let settled = false
    let lastError: Error | undefined
    const lastErrors = new Map<Cluster, Error>()
    const cleanups: (() => void)[] = []

    function settle() {
      settled = true
      clearTimeout(timer)
      cleanups.forEach(cleanup => cleanup())
    }

    function fail(error: Error) {
      if (settled) return
      settle()

      for (const cluster of clusters) {
        // 'end' is final; disconnect() on it would rewrite the status
        if (cluster.status === 'end') continue
        try {
          cluster.disconnect()
        } catch {
          // nothing more to do for a connection that cannot be closed
        }
      }

      reject(error)
    }

    // reads each status at the moment it is called, so a Cluster that reached
    // 'ready' and dropped again before its siblings were ready is still waited on
    function resolveIfAllReady() {
      if (settled) return
      if (clusters.some(cluster => cluster.status !== 'ready')) return

      settle()
      resolve()
    }

    const timer = setTimeout(() => {
      fail(
        lastError ??
          new Error(
            `Timed out after ${timeoutMs}ms waiting for the Redis Cluster queue connection to be ready`,
          ),
      )
    }, timeoutMs)

    for (const cluster of clusters) {
      const onError = (error: Error) => {
        lastError = error
        lastErrors.set(cluster, error)
      }
      const onEnd = () => {
        fail(
          lastErrors.get(cluster) ?? new Error('A Redis Cluster queue connection ended before it was ready'),
        )
      }

      cluster.on('error', onError)
      cluster.on('end', onEnd)
      cluster.on('ready', resolveIfAllReady)
      cleanups.push(() => {
        cluster.off('error', onError)
        cluster.off('end', onEnd)
        cluster.off('ready', resolveIfAllReady)
      })

      // ioredis never re-emits 'end', so a Cluster already there would hang until the bound
      if (cluster.status === 'end') onEnd()
    }

    resolveIfAllReady()
  })
}
