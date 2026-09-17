import { Redis } from 'ioredis'
import {
  BackgroundJobConfig,
  BackgroundWithOpts,
  PsychicBackgroundOptions,
} from '../../../src/types/background.js'
import DummyService from '../../../test-app/src/app/services/DummyService.js'
import { fakeRedisConnection, nativeWorkerOptions } from '../../helpers/bullmqRecorders.js'

/**
 * `PsychicBackgroundOptions` and `BackgroundJobConfig` are `Either` unions: the
 * simple (workstream) keys and the native BullMQ keys are mutually exclusive,
 * enforced by typing each branch's foreign keys as `never`.
 *
 * The assertions below are compile-time only. Every `@ts-expect-error` fails the
 * build if the line it precedes stops being an error, so `pnpm build:test-app`
 * (which type checks this directory, unlike `pnpm build`) is what actually runs
 * them — that is the command CI runs in the check-build job.
 * The one runtime expectation exists so vitest has a test to report on.
 */
describe('PsychicBackgroundOptions and BackgroundJobConfig exclusivity', () => {
  const connection: Redis = fakeRedisConnection('connection')

  it('is enforced at compile time', () => {
    /////////////////////////////
    // simple (workstream) mode //
    /////////////////////////////
    const simple: PsychicBackgroundOptions = {
      defaultQueueConnection: connection,
      defaultWorkerConnection: connection,
      defaultWorkstream: { workerCount: 2, concurrency: 25 },
      namedWorkstreams: [{ name: 'snazzy', workerCount: 1 }],
      // legal in both branches
      providers: { Queue: class {}, Worker: class {} },
      defaultBullMQQueueOptions: { defaultJobOptions: { attempts: 3 } },
      defaultBullMQWorkerOptions: { lockDuration: 1000 },
    }

    // defaultWorkerConnection is only optional in value, not in presence: it may
    // be undefined (e.g. on a webserver), but the key must be there
    const simpleWithoutWorkers: PsychicBackgroundOptions = {
      defaultQueueConnection: connection,
      defaultWorkerConnection: undefined,
    }

    // @ts-expect-error simple mode requires defaultQueueConnection
    const simpleMissingQueueConnection: PsychicBackgroundOptions = {
      defaultWorkerConnection: connection,
    }

    // @ts-expect-error simple mode requires the defaultWorkerConnection key to be present
    const simpleMissingWorkerConnectionKey: PsychicBackgroundOptions = {
      defaultQueueConnection: connection,
    }

    // a named workstream's `rateLimit` is optional, but when present both
    // `max` and `duration` are required: open-source BullMQ passes them
    // unvalidated into its Lua scripts, where a missing `duration` breaks the
    // job fetch, so a partial rate limit is rejected at compile time instead
    const rateLimitedWorkstream: PsychicBackgroundOptions = {
      defaultQueueConnection: connection,
      defaultWorkerConnection: connection,
      namedWorkstreams: [{ name: 'snazzy', rateLimit: { max: 1, duration: 1000 } }],
    }

    const rateLimitMissingDuration: PsychicBackgroundOptions = {
      defaultQueueConnection: connection,
      defaultWorkerConnection: connection,
      // @ts-expect-error rateLimit requires duration alongside max
      namedWorkstreams: [{ name: 'snazzy', rateLimit: { max: 1 } }],
    }

    const rateLimitMissingMax: PsychicBackgroundOptions = {
      defaultQueueConnection: connection,
      defaultWorkerConnection: connection,
      // @ts-expect-error rateLimit requires max alongside duration
      namedWorkstreams: [{ name: 'snazzy', rateLimit: { duration: 1000 } }],
    }

    ///////////////////////
    // native BullMQ mode //
    ///////////////////////
    const native: PsychicBackgroundOptions = {
      // both connections are optional in native mode, since a connection may
      // arrive per named queue instead
      nativeBullMQ: {
        defaultQueueOptions: { queueConnection: connection, workerConnection: connection },
        defaultWorkerCount: 2,
        namedQueueOptions: { alpha: {} },
        namedQueueWorkers: { alpha: nativeWorkerOptions({ workerCount: 1 }) },
      },
      // legal in both branches
      providers: { Queue: class {}, Worker: class {} },
      defaultBullMQQueueOptions: { defaultJobOptions: { attempts: 3 } },
      defaultBullMQWorkerOptions: { lockDuration: 1000 },
    }

    // `BullMQNativeWorkerOptions extends WorkerOptions` without
    // `Omit<..., 'connection'>`, so the literal form an app would write does not
    // compile: every worker entry is required to carry a connection that Psychic
    // then overwrites. This pins that as current behavior; when `src/` adds the
    // `Omit`, the directive below goes unused and the build fails, forcing this
    // example to be updated. The behavioral specs route around it through the
    // `nativeWorkerOptions()` helper.
    const nativeWorkersWithoutConnection: PsychicBackgroundOptions = {
      nativeBullMQ: {
        // @ts-expect-error namedQueueWorkers entries are required to carry a connection
        namedQueueWorkers: { alpha: { workerCount: 1 } },
      },
    }

    ///////////////////
    // the exclusion //
    ///////////////////
    // @ts-expect-error namedWorkstreams is typed `never` in the native branch
    const nativePlusWorkstreams: PsychicBackgroundOptions = {
      nativeBullMQ: {},
      defaultQueueConnection: connection,
      namedWorkstreams: [{ name: 'snazzy' }],
    }

    // @ts-expect-error defaultWorkstream is typed `never` in the native branch
    const nativePlusDefaultWorkstream: PsychicBackgroundOptions = {
      nativeBullMQ: {},
      defaultQueueConnection: connection,
      defaultWorkstream: { workerCount: 1 },
    }

    // @ts-expect-error nativeBullMQ is typed `never` in the simple branch
    const simplePlusNative: PsychicBackgroundOptions = {
      defaultQueueConnection: connection,
      defaultWorkerConnection: connection,
      namedWorkstreams: [{ name: 'snazzy' }],
      nativeBullMQ: {},
    }

    //////////////////////////////
    // delay options (debounce) //
    //////////////////////////////
    // a delay object always needs a time component: a delay with no duration
    // delays nothing, and a `jobId` (the deduplication key) with no duration
    // debounces nothing. `DelayedJobOpts` is narrowed to require at least
    // one of `seconds`/`minutes`/`hours`/`days`, which makes both shapes
    // compile errors. The narrowing deliberately lands on `DelayedJobOpts`
    // rather than on `DelayedJobDuration`, which must stay all-optional
    // because `durationToSeconds` takes it.
    const delayWithDuration: BackgroundWithOpts = { delay: { seconds: 10, jobId: 'x' } }
    const delayWithDurationOnly: BackgroundWithOpts = { delay: { minutes: 1 } }

    const delayWithoutDuration: BackgroundWithOpts = {
      // @ts-expect-error a delay must carry at least one time component
      delay: {},
    }

    const delayWithJobIdOnly: BackgroundWithOpts = {
      // @ts-expect-error a jobId is not a time component; a delay still needs one
      delay: { jobId: 'x' },
    }

    // never invoked — declared only so the compiler checks the call signature
    // of `backgroundWithDelay`, which takes a `DelayedJobOpts` directly
    const backgroundWithDelayCallSignature = async () => {
      await DummyService.backgroundWithDelay({ seconds: 10, jobId: 'x' }, 'classRunInBG', 'bottlearum')
      // @ts-expect-error a delay must carry at least one time component
      await DummyService.backgroundWithDelay({}, 'classRunInBG', 'bottlearum')
      // @ts-expect-error a jobId is not a time component; a delay still needs one
      await DummyService.backgroundWithDelay({ jobId: 'x' }, 'classRunInBG', 'bottlearum')
    }

    ////////////////////////
    // BackgroundJobConfig //
    ////////////////////////
    const workstreamJobConfig: BackgroundJobConfig<DummyService> = {
      workstream: 'snazzy',
      priority: 'urgent',
    }

    const priorityOnlyJobConfig: BackgroundJobConfig<DummyService> = { priority: 'last' }

    const unknownWorkstreamJobConfig: BackgroundJobConfig<DummyService> = {
      // @ts-expect-error only synced workstream names are assignable
      workstream: 'ghost',
    }

    const mixedJobConfig: BackgroundJobConfig<DummyService> = {
      workstream: 'snazzy',
      // @ts-expect-error queue is typed `never` alongside workstream
      queue: 'snazzy',
    }

    expect([
      simple,
      simpleWithoutWorkers,
      simpleMissingQueueConnection,
      simpleMissingWorkerConnectionKey,
      rateLimitedWorkstream,
      rateLimitMissingDuration,
      rateLimitMissingMax,
      native,
      nativeWorkersWithoutConnection,
      nativePlusWorkstreams,
      nativePlusDefaultWorkstream,
      simplePlusNative,
      delayWithDuration,
      delayWithDurationOnly,
      delayWithoutDuration,
      delayWithJobIdOnly,
      backgroundWithDelayCallSignature,
      workstreamJobConfig,
      priorityOnlyJobConfig,
      unknownWorkstreamJobConfig,
      mixedJobConfig,
    ]).toHaveLength(21)
  })
})
