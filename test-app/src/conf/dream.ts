import { DreamApplication } from '@rvohealth/dream'
import path from 'node:path'
import inflections from './inflections'

export default async function configureDream(app: DreamApplication) {
  app.set('primaryKeyType', 'bigserial')
  app.set('inflections', inflections)

  await app.load('models', path.join(__dirname, '..', 'app', 'models'))
  await app.load('serializers', path.join(__dirname, '..', 'app', 'serializers'))
  await app.load('services', path.join(__dirname, '..', 'app', 'services'))

  // provides a list of path overrides for your app. This is optional, and will default
  // to the paths expected for a typical psychic application.
  app.set('paths', {
    conf: 'test-app/src/conf',
    db: 'test-app/src/db',
    types: 'test-app/src/types',
    factories: 'test-app/spec/factories',
    models: 'test-app/src/app/models',
    modelSpecs: 'test-app/spec/unit/models',
    serializers: 'test-app/src/app/serializers',
  })

  app.set('db', {
    primary: {
      user: process.env.DB_USER!,
      password: process.env.DB_PASSWORD!,
      host: process.env.DB_HOST!,
      name: process.env.DB_NAME!,
      port: parseInt(process.env.DB_PORT!),
      useSsl: process.env.DB_USE_SSL === '1',
    },
  })
}
