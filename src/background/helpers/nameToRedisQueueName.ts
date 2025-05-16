import { Cluster, Redis } from 'ioredis'
import parallelTestSafeQueueName from './parallelTestSafeQueueName.js'

export default function nameToRedisQueueName(queueName: string, redis: Redis | Cluster): string {
  queueName = queueName.replace(/\{|\}/g, '')

  if (redis instanceof Cluster) return `{${queueName}}`
  return parallelTestSafeQueueName(queueName)
}
