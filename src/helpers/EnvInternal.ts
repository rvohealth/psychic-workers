import { Env } from '@rvoh/dream'

const EnvInternal = new Env<{
  string: 'NODE_ENV' | 'PSYCHIC_CORE_DEVELOPMENT'
  integer: 'VITEST_POOL_ID'
  boolean: 'REALLY_TEST_BACKGROUND_QUEUE'
}>()

export default EnvInternal
