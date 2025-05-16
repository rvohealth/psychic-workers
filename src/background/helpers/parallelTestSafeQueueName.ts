import EnvInternal from '../../helpers/EnvInternal.js'

export default function parallelTestSafeQueueName(queueName: string) {
  if (EnvInternal.isTest && (EnvInternal.integer('VITEST_POOL_ID', { optional: true }) || 0) > 1) {
    queueName = `${queueName}-${EnvInternal.integer('VITEST_POOL_ID')}`
  }

  return queueName
}
