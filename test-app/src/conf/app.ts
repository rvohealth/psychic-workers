import { PsychicApplication } from '@rvohealth/psychic'
import srcPath from '../app/helpers/srcPath'
import importControllers from './importers/importControllers'
import inflections from './inflections'
import routesCb from './routes'

export default async (psy: PsychicApplication) => {
  psy.load('controllers', srcPath('app', 'controllers'), await importControllers())

  psy.set('appName', 'testapp')
  psy.set('apiOnly', false)
  psy.set('apiRoot', srcPath('..', '..'))
  psy.set('clientRoot', srcPath('..', 'client'))
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
