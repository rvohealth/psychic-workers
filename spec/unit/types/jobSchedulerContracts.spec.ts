import type {
  PsychicJobScheduler,
  PsychicJobSchedulerOrigin,
  PsychicJobSchedulerRoute,
} from '../../../src/package-exports/types.js'
import BaseBackgroundedModel from '../../../src/background/BaseBackgroundedModel.js'
import BaseBackgroundedService from '../../../src/background/BaseBackgroundedService.js'
import BaseScheduledService from '../../../src/background/BaseScheduledService.js'

describe('Psychic job scheduler public contracts', () => {
  it('represent default and named logical routes without infrastructure details', () => {
    const defaultRoute: PsychicJobSchedulerRoute = { kind: 'default' }
    const namedRoute: PsychicJobSchedulerRoute = { kind: 'named', name: 'mailers' }

    expect(routeName(defaultRoute)).toEqual('default')
    expect(routeName(namedRoute)).toEqual('mailers')
  })

  it('represent generation-bound origins and framework-owned scheduler metadata', () => {
    const origin: PsychicJobSchedulerOrigin = {
      generation: 'generation-token',
      source: 'current',
      route: { kind: 'named', name: 'mailers' },
    }
    const scheduler: PsychicJobScheduler = {
      locator: 'opaque-locator',
      globalName: 'services/Mailers',
      method: 'deliverDigest',
      pattern: '0 9 * * *',
      nextRunAt: 1_789_000_000_000,
      origin,
    }

    expect(scheduler).toEqual({
      locator: 'opaque-locator',
      globalName: 'services/Mailers',
      method: 'deliverDigest',
      pattern: '0 9 * * *',
      nextRunAt: 1_789_000_000_000,
      origin,
    })
  })

  it('types locators as child methods while preserving the existing schedule signature', () => {
    class DigestService extends BaseScheduledService {
      public static deliver(subject: string) {
        return subject
      }
    }

    const compileContract = () => {
      const locator: string = DigestService.jobSchedulerLocator('deliver')
      const removal: Promise<boolean> = BaseScheduledService.unschedule(locator)

      // @ts-expect-error inherited base utilities are not eligible scheduled methods for locators
      DigestService.jobSchedulerLocator('schedule')

      // Existing schedule deliberately retains its broader FunctionPropertyNames signature.
      void DigestService.schedule('* * * * *', 'deliver', 'hello')
      void DigestService.schedule('* * * * *', 'unschedule', locator)

      // @ts-expect-error inherited base utilities are not eligible scheduled methods for locators
      DigestService.jobSchedulerLocator('unschedule')

      // @ts-expect-error backgrounded services do not expose scheduled-job APIs
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      BaseBackgroundedService.schedule('* * * * *', 'background')
      // @ts-expect-error backgrounded services do not expose scheduler locators
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      BaseBackgroundedService.jobSchedulerLocator('background')
      // @ts-expect-error backgrounded models do not expose scheduled-job APIs
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      BaseBackgroundedModel.schedule('* * * * *', 'background')
      // @ts-expect-error backgrounded models do not expose unscheduling
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      BaseBackgroundedModel.unschedule(locator)

      const schedulerWithoutBullMQInternals: PsychicJobScheduler = {
        locator,
        globalName: 'services/DigestService',
        method: 'deliver',
        pattern: '* * * * *',
        origin: {
          generation: 'generation-token',
          source: 'current',
          route: { kind: 'default' },
        },
        // @ts-expect-error raw BullMQ queues are not public scheduler metadata
        queue: {},
      }
      void schedulerWithoutBullMQInternals

      const schedulerWithoutSerializedArgs: PsychicJobScheduler = {
        locator,
        globalName: 'services/DigestService',
        method: 'deliver',
        pattern: '* * * * *',
        origin: {
          generation: 'generation-token',
          source: 'current',
          route: { kind: 'default' },
        },
        // @ts-expect-error serialized job arguments are not public scheduler metadata
        args: [],
      }
      void schedulerWithoutSerializedArgs

      const originWithoutRedis: PsychicJobSchedulerOrigin = {
        generation: 'generation-token',
        source: 'current',
        route: { kind: 'default' },
        // @ts-expect-error Redis connections are not part of public origins
        connection: {},
      }
      void originWithoutRedis
      void removal
    }

    expect(compileContract).toBeTypeOf('function')
  })
})

function routeName(route: PsychicJobSchedulerRoute): string {
  switch (route.kind) {
    case 'default':
      return 'default'
    case 'named':
      return route.name
    default: {
      const _never: never = route
      throw new Error(`Unhandled PsychicJobSchedulerRoute: ${String(_never)}`)
    }
  }
}
