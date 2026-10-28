import { Redis } from 'ioredis'
import {
  BackgroundJobConfig,
  BackgroundWithOpts,
  PsychicBackgroundOptions,
} from '../../../src/types/background.js'
import DummyService from '../../../test-app/src/app/services/DummyService.js'
import { fakeRedisConnection } from '../../helpers/bullmqRecorders.js'

/**
 * What this spec is for: it pins which background configuration shapes an app
 * can write and which it cannot. If a change to the option types starts rejecting
 * a config an app can write today, existing apps stop compiling. If it starts
 * accepting one that misbehaves at runtime, the mistake reaches production. In
 * either case, `pnpm build:test-app` fails here.
 *
 * `PsychicBackgroundOptions` and `BackgroundJobConfig` are `Either` unions: the
 * simple (workstream) keys and the native BullMQ keys are mutually exclusive,
 * enforced by typing each branch's foreign keys as `never`.
 *
 * Every check below is compile-time only. Each case passes its literal to a
 * function typed with the option type, through `expectTypeOf(...).toBeCallableWith`,
 * so the literal is contextually typed and excess-property checked as an app's
 * own config literal is. A rejected case carries `@ts-expect-error`, which fails
 * the build if the line stops being an error. `pnpm build:test-app` (which type
 * checks this directory, unlike `pnpm build`) is what actually runs them; CI's
 * check-build job runs it. Vitest strips types, so `pnpm uspec` passes this file
 * whatever the types say.
 */
const backgroundOptions = (options: PsychicBackgroundOptions) => options
const backgroundWithOpts = (opts: BackgroundWithOpts) => opts
const jobConfig = (config: BackgroundJobConfig<DummyService>) => config

describe('PsychicBackgroundOptions and BackgroundJobConfig exclusivity', () => {
  const connection: Redis = fakeRedisConnection('connection')

  it('is enforced at compile time', () => {
    /////////////////////////////
    // simple (workstream) mode //
    /////////////////////////////
    expectTypeOf(backgroundOptions).toBeCallableWith({
      defaultQueueConnection: connection,
      defaultWorkerConnection: connection,
      defaultWorkstream: { workerCount: 2, concurrency: 25 },
      namedWorkstreams: [{ name: 'snazzy', workerCount: 1 }],
      // legal in both branches
      providers: { Queue: class {}, Worker: class {} },
      defaultBullMQQueueOptions: { defaultJobOptions: { attempts: 3 } },
      defaultBullMQWorkerOptions: { lockDuration: 1000 },
    })

    // defaultWorkerConnection is only optional in value, not in presence: it may
    // be undefined (e.g. on a webserver), but the key must be there
    expectTypeOf(backgroundOptions).toBeCallableWith({
      defaultQueueConnection: connection,
      defaultWorkerConnection: undefined,
    })

    expectTypeOf(backgroundOptions).toBeCallableWith(
      // @ts-expect-error simple mode requires defaultQueueConnection
      { defaultWorkerConnection: connection },
    )

    expectTypeOf(backgroundOptions).toBeCallableWith(
      // @ts-expect-error simple mode requires the defaultWorkerConnection key to be present
      { defaultQueueConnection: connection },
    )

    // a named workstream's `rateLimit` is optional, but when present both
    // `max` and `duration` are required: open-source BullMQ passes them
    // unvalidated into its Lua scripts, where a missing `duration` breaks the
    // job fetch, so a partial rate limit is rejected at compile time instead
    expectTypeOf(backgroundOptions).toBeCallableWith({
      defaultQueueConnection: connection,
      defaultWorkerConnection: connection,
      namedWorkstreams: [{ name: 'snazzy', rateLimit: { max: 1, duration: 1000 } }],
    })

    expectTypeOf(backgroundOptions).toBeCallableWith({
      defaultQueueConnection: connection,
      defaultWorkerConnection: connection,
      // @ts-expect-error rateLimit requires duration alongside max
      namedWorkstreams: [{ name: 'snazzy', rateLimit: { max: 1 } }],
    })

    expectTypeOf(backgroundOptions).toBeCallableWith({
      defaultQueueConnection: connection,
      defaultWorkerConnection: connection,
      // @ts-expect-error rateLimit requires max alongside duration
      namedWorkstreams: [{ name: 'snazzy', rateLimit: { duration: 1000 } }],
    })

    ///////////////////////
    // native BullMQ mode //
    ///////////////////////
    expectTypeOf(backgroundOptions).toBeCallableWith({
      // both connections are optional in native mode, since a connection may
      // arrive per named queue instead
      nativeBullMQ: {
        defaultQueueOptions: { queueConnection: connection, workerConnection: connection },
        defaultWorkerCount: 2,
        namedQueueOptions: { alpha: {} },
        namedQueueWorkers: { alpha: { workerCount: 1 } },
      },
      // legal in both branches
      providers: { Queue: class {}, Worker: class {} },
      defaultBullMQQueueOptions: { defaultJobOptions: { attempts: 3 } },
      defaultBullMQWorkerOptions: { lockDuration: 1000 },
    })

    // Worker options omit connection: Psychic resolves it from queue-side or
    // app-wide Redis/Cluster instances. Both native placements accept ordinary
    // literals, including an empty named entry that creates one worker.
    expectTypeOf(backgroundOptions).toBeCallableWith({
      defaultWorkerConnection: connection,
      nativeBullMQ: {
        defaultWorkerOptions: { concurrency: 10, limiter: { max: 1, duration: 1000 } },
        namedQueueWorkers: {
          alpha: {},
          beta: { workerCount: 2, concurrency: 0, group: { id: 'betaGroup' } },
        },
      },
    })

    expectTypeOf(backgroundOptions).toBeCallableWith({
      nativeBullMQ: {
        defaultWorkerOptions: {
          // @ts-expect-error configure workerConnection on queue options, not this literal
          connection,
        },
      },
    })

    expectTypeOf(backgroundOptions).toBeCallableWith({
      nativeBullMQ: {
        namedQueueWorkers: {
          alpha: {
            // @ts-expect-error configure workerConnection on queue options, not this literal
            connection,
          },
        },
      },
    })

    // a process that only enqueues jobs (a webserver) passes an explicit
    // undefined worker connection, as simple mode allows; under
    // exactOptionalPropertyTypes that needs `| undefined` on the native keys
    expectTypeOf(backgroundOptions).toBeCallableWith({
      defaultQueueConnection: connection,
      defaultWorkerConnection: undefined,
      nativeBullMQ: {},
    })

    // every native connection key accepts an explicit undefined, so a
    // conditionally supplied connection reads the same at each level
    expectTypeOf(backgroundOptions).toBeCallableWith({
      defaultQueueConnection: undefined,
      defaultWorkerConnection: undefined,
      nativeBullMQ: {
        defaultQueueOptions: { queueConnection: undefined, workerConnection: undefined },
      },
    })

    ///////////////////
    // the exclusion //
    ///////////////////
    expectTypeOf(backgroundOptions).toBeCallableWith(
      // @ts-expect-error namedWorkstreams is typed `never` in the native branch
      {
        nativeBullMQ: {},
        defaultQueueConnection: connection,
        namedWorkstreams: [{ name: 'snazzy' }],
      },
    )

    expectTypeOf(backgroundOptions).toBeCallableWith(
      // @ts-expect-error defaultWorkstream is typed `never` in the native branch
      {
        nativeBullMQ: {},
        defaultQueueConnection: connection,
        defaultWorkstream: { workerCount: 1 },
      },
    )

    expectTypeOf(backgroundOptions).toBeCallableWith(
      // @ts-expect-error nativeBullMQ is typed `never` in the simple branch
      {
        defaultQueueConnection: connection,
        defaultWorkerConnection: connection,
        namedWorkstreams: [{ name: 'snazzy' }],
        nativeBullMQ: {},
      },
    )

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
    expectTypeOf(backgroundWithOpts).toBeCallableWith({ delay: { seconds: 10, jobId: 'x' } })
    expectTypeOf(backgroundWithOpts).toBeCallableWith({ delay: { minutes: 1 } })

    expectTypeOf(backgroundWithOpts).toBeCallableWith({
      // @ts-expect-error a delay must carry at least one time component
      delay: {},
    })

    expectTypeOf(backgroundWithOpts).toBeCallableWith({
      // @ts-expect-error a jobId is not a time component; a delay still needs one
      delay: { jobId: 'x' },
    })

    // `backgroundWithDelay` takes a `DelayedJobOpts` directly, so the same
    // narrowing applies to its first argument. It is generic over `this`, which
    // `expectTypeOf` cannot see through, so these are real calls in a function
    // that is type checked but never invoked.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async function backgroundWithDelayCalls() {
      await DummyService.backgroundWithDelay({ seconds: 10, jobId: 'x' }, 'classRunInBG', 'bottlearum')
      // @ts-expect-error a delay must carry at least one time component
      await DummyService.backgroundWithDelay({}, 'classRunInBG', 'bottlearum')
      // @ts-expect-error a jobId is not a time component; a delay still needs one
      await DummyService.backgroundWithDelay({ jobId: 'x' }, 'classRunInBG', 'bottlearum')
    }

    ////////////////////////
    // BackgroundJobConfig //
    ////////////////////////
    expectTypeOf(jobConfig).toBeCallableWith({ workstream: 'snazzy', priority: 'urgent' })
    expectTypeOf(jobConfig).toBeCallableWith({ priority: 'last' })

    expectTypeOf(jobConfig).toBeCallableWith({
      // @ts-expect-error only synced workstream names are assignable
      workstream: 'ghost',
    })

    expectTypeOf(jobConfig).toBeCallableWith({
      workstream: 'snazzy',
      // @ts-expect-error queue is typed `never` alongside workstream
      queue: 'snazzy',
    })
  })
})
