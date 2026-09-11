import type {
  PsychicJobScheduler,
  PsychicJobSchedulerOrigin,
  PsychicJobSchedulerRoute,
} from '../../../src/package-exports/types.js'
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
