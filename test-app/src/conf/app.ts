import { PsychicApplication } from '@rvohealth/psychic'
import path from 'path'
import inflections from './inflections'
import routesCb from './routes'

export default async (psy: PsychicApplication) => {
  await psy.load('controllers', path.join(__dirname, '..', 'app', 'controllers'))

  psy.set('appName', 'testapp')
  psy.set('apiOnly', false)
  psy.set('apiRoot', path.join(__dirname, '..', '..', '..'))
  psy.set('clientRoot', path.join(__dirname, '..', '..', 'client'))
  psy.set('inflections', inflections)
  psy.set('routes', routesCb)

  psy.set('paths', {
    apiRoutes: 'test-app/src/conf/routes.ts',
    controllers: 'test-app/src/app/controllers',
    controllerSpecs: 'test-app/spec/unit/controllers',
  })

  // set options to pass to coors when middleware is booted
  psy.set('cors', {
    credentials: true,
    origin: [process.env.CLIENT_HOST || 'http://localhost:3000'],
  })

  // set options for cookie usage
  psy.set('cookie', {
    maxAge: {
      days: 4,
    },
  })
}
