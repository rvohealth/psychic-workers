import { Cluster } from 'ioredis'

export type ClusterStatus = Cluster['status']

/**
 * A `lazyConnect` Cluster that never connects (nothing listens on port 1), for
 * driving ioredis's status machine by hand without a Redis Cluster server. It
 * starts at `'wait'`; `setClusterStatus` moves it and emits the matching event,
 * which ioredis does on the next tick. Callers must `disconnect()` it.
 */
export function lazyCluster(status: ClusterStatus = 'wait'): Cluster {
  const cluster = new Cluster([{ host: '127.0.0.1', port: 1 }], {
    lazyConnect: true,
    enableOfflineQueue: false,
  })
  if (status !== 'wait') setClusterStatus(cluster, status)
  return cluster
}

export function setClusterStatus(cluster: Cluster, status: ClusterStatus) {
  // `setStatus` is private in ioredis's types but is what its own machinery calls
  ;(cluster as unknown as { setStatus(status: ClusterStatus): void }).setStatus(status)
}

/** lets ioredis's next-tick status events fire */
export function flushStatusEvents() {
  return new Promise<void>(resolve => setImmediate(resolve))
}
