import { Env } from '@rvohealth/dream'

const EnvInternal = new Env<{
  string: 'NODE_ENV' | 'PSYCHIC_CORE_DEVELOPMENT'
  // integer: 'PORT'
  boolean: 'DEBUG' | 'PSYCHIC_CORE_DEVELOPMENT' | 'REALLY_TEST_BACKGROUND_QUEUE'
}>()

export default EnvInternal
