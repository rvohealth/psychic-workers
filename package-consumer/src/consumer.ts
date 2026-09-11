import { BaseScheduledService, type Background } from '@rvoh/psychic-workers'
import { DuplicateNamedWorkstream, InvalidJobSchedulerLocator } from '@rvoh/psychic-workers/errors'
import type {
  PsychicJobScheduler,
  PsychicJobSchedulerOrigin,
  PsychicJobSchedulerRoute,
} from '@rvoh/psychic-workers/types'

export const removedServiceLocator =
  'psychic-job-scheduler:v1:WyJzZXJ2aWNlcy9SZW1vdmVkU2NoZWR1bGVkU2VydmljZSIsImRlbGl2ZXIiLFsiZGVmYXVsdCJdXQ'

export function removeDeletedServiceSchedule(): Promise<boolean> {
  return BaseScheduledService.unschedule(removedServiceLocator)
}

export function routeName(route: PsychicJobSchedulerRoute): string {
  switch (route.kind) {
    case 'default':
      return 'default'
    case 'named':
      return route.name
    default: {
      const _never: never = route
      throw new Error(`Unhandled scheduler route: ${String(_never)}`)
    }
  }
}

const origin: PsychicJobSchedulerOrigin = {
  generation: 'package-consumer-generation',
  source: 'current',
  route: { kind: 'default' },
}

const scheduler: PsychicJobScheduler = {
  locator: removedServiceLocator,
  globalName: 'services/RemovedScheduledService',
  method: 'deliver',
  pattern: '0 10 1 1 *',
  origin,
}

export function removeInventoryRow(background: Background): Promise<boolean> {
  return background.removeJobScheduler(scheduler)
}

export const schedulerErrors = { DuplicateNamedWorkstream, InvalidJobSchedulerLocator }
