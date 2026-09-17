import { Job } from 'bullmq'
import { MockInstance } from 'vitest'
import background from '../../../src/background/index.js'
import AttemtedToBackgroundEntireDreamModel from '../../../src/error/background/AttemtedToBackgroundEntireDreamModel.js'
import DeduplicatedJobRequiresMinimumDelay from '../../../src/error/background/DeduplicatedJobRequiresMinimumDelay.js'
import PsychicAppWorkers, {
  PsychicWorkersAppTestInvocationType,
} from '../../../src/psychic-app-workers/index.js'
import WorkerTestUtils from '../../../src/test-utils/WorkerTestUtils.js'
import { BackgroundQueuePriority } from '../../../src/types/background.js'
import createUser from '../../../test-app/spec/factories/UserFactory.js'
import DummyService from '../../../test-app/src/app/services/DummyService.js'
import LastDummyService from '../../../test-app/src/app/services/LastDummyService.js'
import LastDummyServiceInNamedWorkstream from '../../../test-app/src/app/services/LastDummyServiceInNamedWorkstream.js'
import NotUrgentDummyService from '../../../test-app/src/app/services/NotUrgentDummyService.js'
import UrgentDummyService from '../../../test-app/src/app/services/UrgentDummyService.js'

describe('a backgrounded service', () => {
  describe('.background', () => {
    it('calls the static method, passing args', async () => {
      const bgSpy = vi.spyOn(DummyService, 'classRunInBG').mockImplementation(async () => {})
      const bgWithJobArgSpy = vi
        .spyOn(DummyService, 'classRunInBGWithJobArg')
        .mockImplementation(async () => {})

      await DummyService.background('classRunInBG', 'bottlearum')
      expect(bgSpy).toHaveBeenCalledWith('bottlearum', expect.any(Job))

      await DummyService.background('classRunInBGWithJobArg', 'bottlearum')
      expect(bgWithJobArgSpy).toHaveBeenCalledWith('bottlearum', expect.any(Job))
    })

    context('attempting to background an entire Dream model', () => {
      it('throws AttemtedToBackgroundEntireDreamModel', async () => {
        const user = await createUser()
        await expect(DummyService.background('classRunInBG', user)).rejects.toThrow(
          AttemtedToBackgroundEntireDreamModel,
        )
      })
    })

    context('queue priority', () => {
      let spy: MockInstance
      let originalTestInvocation: PsychicWorkersAppTestInvocationType

      const subject = async () => {
        await serviceClass.background('classRunInBG', 'bottlearum')
      }

      beforeEach(async () => {
        const workersApp = PsychicAppWorkers.getOrFail()
        originalTestInvocation = workersApp.testInvocation
        workersApp.set('testInvocation', 'manual')

        background.connect()
        spy = vi.spyOn(background.queues[0]!, 'add').mockResolvedValue({} as Job)

        await WorkerTestUtils.clean()
      })

      afterEach(() => {
        const workersApp = PsychicAppWorkers.getOrFail()
        workersApp.set('testInvocation', originalTestInvocation)
      })

      let serviceClass:
        | typeof DummyService
        | typeof UrgentDummyService
        | typeof NotUrgentDummyService
        | typeof LastDummyService

      function expectAddedToQueueWithPriority(priority: BackgroundQueuePriority, priorityLevel: number) {
        expect(spy).toHaveBeenCalledWith(
          'BackgroundJobQueueStaticJob',
          {
            globalName: `services/${serviceClass.name}`,
            args: ['bottlearum'],
            importKey: undefined,
            method: 'classRunInBG',
          },
          { priority: priorityLevel },
        )
      }

      context('with a default priority', () => {
        beforeEach(() => {
          serviceClass = DummyService
        })

        it('uses priority 2', async () => {
          await subject()
          expectAddedToQueueWithPriority('default', 2)
        })
      })

      context('with an urgent priority', () => {
        beforeEach(() => {
          serviceClass = UrgentDummyService
        })

        it('uses priority 1', async () => {
          await subject()
          expectAddedToQueueWithPriority('urgent', 1)
        })
      })

      context('with a not_urgent priority', () => {
        beforeEach(() => {
          serviceClass = NotUrgentDummyService
        })

        it('uses priority 3', async () => {
          await subject()
          expectAddedToQueueWithPriority('not_urgent', 3)
        })
      })

      context('with a last priority', () => {
        beforeEach(() => {
          serviceClass = LastDummyService
        })

        it('uses priority 4', async () => {
          await subject()
          expectAddedToQueueWithPriority('last', 4)
        })
      })
    })

    context('named workstream', () => {
      let originalTestInvocation: PsychicWorkersAppTestInvocationType

      beforeEach(async () => {
        const workersApp = PsychicAppWorkers.getOrFail()
        originalTestInvocation = workersApp.testInvocation
        workersApp.set('testInvocation', 'manual')

        await WorkerTestUtils.clean()
      })

      afterEach(() => {
        const workersApp = PsychicAppWorkers.getOrFail()
        workersApp.set('testInvocation', originalTestInvocation)
      })

      it('adds the job to the queue corresponding to the workstream name with the workstream name as the group ID, and writes the priority both at the top level and into the group object', async () => {
        const spy = vi.spyOn(background.queues[1]!, 'add').mockResolvedValue({} as Job)
        await LastDummyServiceInNamedWorkstream.background('classRunInBG', 'bottlearum')

        expect(spy).toHaveBeenCalledWith(
          'BackgroundJobQueueStaticJob',
          {
            globalName: 'services/LastDummyServiceInNamedWorkstream',
            args: ['bottlearum'],
            importKey: undefined,
            method: 'classRunInBG',
          },
          { priority: 4, group: { id: 'snazzy', priority: 4 } },
        )
      })
    })
  })

  describe('.backgroundWithDelay', () => {
    it('calls the static method, passing args', async () => {
      const spy = vi.spyOn(DummyService, 'classRunInBG').mockImplementation(async () => {})
      await DummyService.backgroundWithDelay({ seconds: 25, jobId: 'myjob' }, 'classRunInBG', 'bottlearum')
      expect(spy).toHaveBeenCalledWith('bottlearum', expect.any(Job))
    })

    context('attempting to background an entire Dream model', () => {
      it('throws AttemtedToBackgroundEntireDreamModel', async () => {
        const user = await createUser()
        await expect(
          DummyService.backgroundWithDelay({ seconds: 25, jobId: 'myjob' }, 'classRunInBG', user),
        ).rejects.toThrow(AttemtedToBackgroundEntireDreamModel)
      })
    })

    context('queue priority', () => {
      let spy: MockInstance

      const subject = async () => {
        await serviceClass.backgroundWithDelay({ seconds: 15, jobId: 'myjob' }, 'classRunInBG', 'bottlearum')
      }

      let originalTestInvocation: PsychicWorkersAppTestInvocationType
      beforeEach(async () => {
        const workersApp = PsychicAppWorkers.getOrFail()
        originalTestInvocation = workersApp.testInvocation
        workersApp.set('testInvocation', 'manual')

        background.connect()
        spy = vi.spyOn(background.queues[0]!, 'add').mockResolvedValue({} as Job)

        await WorkerTestUtils.clean()
      })

      afterEach(() => {
        const workersApp = PsychicAppWorkers.getOrFail()
        workersApp.set('testInvocation', originalTestInvocation)
      })

      let serviceClass:
        | typeof DummyService
        | typeof UrgentDummyService
        | typeof NotUrgentDummyService
        | typeof LastDummyService

      function expectAddedToQueueWithPriority(priority: BackgroundQueuePriority, priorityLevel: number) {
        expect(spy).toHaveBeenCalledWith(
          'BackgroundJobQueueStaticJob',
          {
            globalName: `services/${serviceClass.name}`,
            args: ['bottlearum'],
            method: 'classRunInBG',
          },
          {
            deduplication: {
              extend: true,
              id: 'myjob',
              replace: true,
              ttl: 14000,
            },
            delay: 15000,
            priority: priorityLevel,
          },
        )
      }

      context('with a default priority', () => {
        beforeEach(() => {
          serviceClass = DummyService
        })

        it('uses priority 2', async () => {
          await subject()
          expectAddedToQueueWithPriority('default', 2)
        })
      })

      context('with an urgent priority', () => {
        beforeEach(() => {
          serviceClass = UrgentDummyService
        })

        it('uses priority 1', async () => {
          await subject()
          expectAddedToQueueWithPriority('urgent', 1)
        })
      })

      context('with a not_urgent priority', () => {
        beforeEach(() => {
          serviceClass = NotUrgentDummyService
        })

        it('uses priority 3', async () => {
          await subject()
          expectAddedToQueueWithPriority('not_urgent', 3)
        })
      })

      context('with a last priority', () => {
        beforeEach(() => {
          serviceClass = LastDummyService
        })

        it('uses priority 4', async () => {
          await subject()
          expectAddedToQueueWithPriority('last', 4)
        })
      })
    })

    context('named workstream', () => {
      let originalTestInvocation: PsychicWorkersAppTestInvocationType
      beforeEach(async () => {
        const workersApp = PsychicAppWorkers.getOrFail()
        originalTestInvocation = workersApp.testInvocation
        workersApp.set('testInvocation', 'manual')

        await WorkerTestUtils.clean()
      })

      afterEach(() => {
        const workersApp = PsychicAppWorkers.getOrFail()
        workersApp.set('testInvocation', originalTestInvocation)
      })

      it('adds the job to the queue corresponding to the workstream name with the workstream name as the group ID, and writes the priority both at the top level and into the group object', async () => {
        const spy = vi.spyOn(background.queues[1]!, 'add').mockResolvedValue({} as Job)
        await LastDummyServiceInNamedWorkstream.backgroundWithDelay(
          { seconds: 15, jobId: 'myjob' },
          'classRunInBG',
          'bottlearum',
        )

        expect(spy).toHaveBeenCalledWith(
          'BackgroundJobQueueStaticJob',
          {
            globalName: 'services/LastDummyServiceInNamedWorkstream',
            args: ['bottlearum'],
            importKey: undefined,
            method: 'classRunInBG',
          },
          {
            deduplication: {
              extend: true,
              id: 'myjob',
              replace: true,
              ttl: 14000,
            },
            delay: 15000,
            priority: 4,
            group: { id: 'snazzy', priority: 4 },
          },
        )
      })
    })
  })

  describe('.backgroundWith', () => {
    it('calls the static method, passing args', async () => {
      const spy = vi.spyOn(DummyService, 'classRunInBG').mockImplementation(async () => {})
      await DummyService.backgroundWith({}, 'classRunInBG', 'bottlearum')
      expect(spy).toHaveBeenCalledWith('bottlearum', expect.any(Job))
    })

    context('attempting to background an entire Dream model', () => {
      it('throws AttemtedToBackgroundEntireDreamModel', async () => {
        const user = await createUser()
        await expect(
          DummyService.backgroundWith({ priority: 'urgent' }, 'classRunInBG', user),
        ).rejects.toThrow(AttemtedToBackgroundEntireDreamModel)
      })
    })

    context('queue options', () => {
      let spy: MockInstance
      let originalTestInvocation: PsychicWorkersAppTestInvocationType

      beforeEach(async () => {
        const workersApp = PsychicAppWorkers.getOrFail()
        originalTestInvocation = workersApp.testInvocation
        workersApp.set('testInvocation', 'manual')

        background.connect()
        spy = vi.spyOn(background.queues[0]!, 'add').mockResolvedValue({} as Job)

        await WorkerTestUtils.clean()
      })

      afterEach(() => {
        const workersApp = PsychicAppWorkers.getOrFail()
        workersApp.set('testInvocation', originalTestInvocation)
      })

      function expectAddedToQueue(
        serviceClass: typeof DummyService | typeof UrgentDummyService | typeof LastDummyService,
        bullmqOpts: object,
      ) {
        expect(spy).toHaveBeenCalledWith(
          'BackgroundJobQueueStaticJob',
          {
            globalName: `services/${serviceClass.name}`,
            args: ['bottlearum'],
            importKey: undefined,
            method: 'classRunInBG',
          },
          bullmqOpts,
        )
      }

      context('with no options', () => {
        it('uses the priority from backgroundJobConfig and does not delay', async () => {
          await UrgentDummyService.backgroundWith({}, 'classRunInBG', 'bottlearum')
          expectAddedToQueue(UrgentDummyService, { priority: 1 })
        })
      })

      context('with a priority', () => {
        it('overrides the priority from backgroundJobConfig', async () => {
          await UrgentDummyService.backgroundWith({ priority: 'last' }, 'classRunInBG', 'bottlearum')
          expectAddedToQueue(UrgentDummyService, { priority: 4 })
        })

        it('overrides the default priority when backgroundJobConfig does not specify one', async () => {
          await DummyService.backgroundWith({ priority: 'urgent' }, 'classRunInBG', 'bottlearum')
          expectAddedToQueue(DummyService, { priority: 1 })
        })

        it('does not mutate the backgroundJobConfig of the service', async () => {
          await UrgentDummyService.backgroundWith({ priority: 'last' }, 'classRunInBG', 'bottlearum')
          expect(UrgentDummyService.backgroundJobConfig.priority).toEqual('urgent')
        })
      })

      context('with a delay', () => {
        it('delays and deduplicates the job, preserving the priority from backgroundJobConfig', async () => {
          await LastDummyService.backgroundWith(
            { delay: { seconds: 15, jobId: 'myjob' } },
            'classRunInBG',
            'bottlearum',
          )
          expectAddedToQueue(LastDummyService, {
            deduplication: {
              extend: true,
              id: 'myjob',
              replace: true,
              ttl: 14000,
            },
            delay: 15000,
            priority: 4,
          })
        })
      })

      context('with both a delay and a priority', () => {
        it('delays the job and overrides the priority', async () => {
          await LastDummyService.backgroundWith(
            { delay: { minutes: 1, jobId: 'myjob' }, priority: 'urgent' },
            'classRunInBG',
            'bottlearum',
          )
          expectAddedToQueue(LastDummyService, {
            deduplication: {
              extend: true,
              id: 'myjob',
              replace: true,
              ttl: 59000,
            },
            delay: 60000,
            priority: 1,
          })
        })
      })
    })

    context('named workstream', () => {
      let originalTestInvocation: PsychicWorkersAppTestInvocationType
      beforeEach(async () => {
        const workersApp = PsychicAppWorkers.getOrFail()
        originalTestInvocation = workersApp.testInvocation
        workersApp.set('testInvocation', 'manual')

        await WorkerTestUtils.clean()
      })

      afterEach(() => {
        const workersApp = PsychicAppWorkers.getOrFail()
        workersApp.set('testInvocation', originalTestInvocation)
      })

      it('preserves the workstream and writes the overridden priority both at the top level and into the group object', async () => {
        const spy = vi.spyOn(background.queues[1]!, 'add').mockResolvedValue({} as Job)
        await LastDummyServiceInNamedWorkstream.backgroundWith(
          { delay: { seconds: 15, jobId: 'myjob' }, priority: 'urgent' },
          'classRunInBG',
          'bottlearum',
        )

        expect(spy).toHaveBeenCalledWith(
          'BackgroundJobQueueStaticJob',
          {
            globalName: 'services/LastDummyServiceInNamedWorkstream',
            args: ['bottlearum'],
            importKey: undefined,
            method: 'classRunInBG',
          },
          {
            deduplication: {
              extend: true,
              id: 'myjob',
              replace: true,
              ttl: 14000,
            },
            delay: 15000,
            priority: 1,
            group: { id: 'snazzy', priority: 1 },
          },
        )
      })
    })
  })

  /**
   * The deduplication default itself: the key is armed for the delay minus a
   * flat one second margin, so that it dies before the job fires and a late
   * call starts a new timer instead of being swallowed. The margin is clamped
   * to a positive integer because BullMQ hands `ttl` straight to Redis
   * `SET ... PX`, which rejects a fractional argument.
   *
   * These pin the numbers against the recorder. What the shorter key actually
   * buys against a real Redis is pinned in `deduplicationKeyMargin.spec.ts`.
   */
  describe('deduplication (debounce) options', () => {
    context('with testInvocation manual, so the job is really enqueued', () => {
      let spy: MockInstance
      let originalTestInvocation: PsychicWorkersAppTestInvocationType

      beforeEach(async () => {
        const workersApp = PsychicAppWorkers.getOrFail()
        originalTestInvocation = workersApp.testInvocation
        workersApp.set('testInvocation', 'manual')

        background.connect()
        spy = vi.spyOn(background.queues[0]!, 'add').mockResolvedValue({} as Job)

        await WorkerTestUtils.clean()
      })

      afterEach(() => {
        const workersApp = PsychicAppWorkers.getOrFail()
        workersApp.set('testInvocation', originalTestInvocation)
      })

      function expectAddedToQueue(bullmqOpts: object) {
        expect(spy).toHaveBeenCalledWith(
          'BackgroundJobQueueStaticJob',
          {
            globalName: 'services/DummyService',
            args: ['bottlearum'],
            importKey: undefined,
            method: 'classRunInBG',
          },
          bullmqOpts,
        )
      }

      context('.backgroundWithDelay', () => {
        it('arms the deduplication key for the delay minus the one second margin', async () => {
          await DummyService.backgroundWithDelay(
            { seconds: 10, jobId: 'myjob' },
            'classRunInBG',
            'bottlearum',
          )

          expectAddedToQueue({
            deduplication: { extend: true, id: 'myjob', replace: true, ttl: 9000 },
            delay: 10000,
            priority: 2,
          })
        })

        it('clamps a fractional delay to an integral ttl', async () => {
          // `durationToSeconds` sums raw numbers, so this delay really is
          // fractional; only `ttl` is floored, and 9000 rather than 9000.5 is
          // what proves it
          await DummyService.backgroundWithDelay(
            { seconds: 10.0005, jobId: 'myjob' },
            'classRunInBG',
            'bottlearum',
          )

          expectAddedToQueue({
            deduplication: { extend: true, id: 'myjob', replace: true, ttl: 9000 },
            delay: 10000.5,
            priority: 2,
          })
        })

        /**
         * The floor itself, from both sides. Every other spec in this file
         * sits comfortably above or below it, so this is the only thing
         * pinning where the boundary actually falls and that it is inclusive
         * — the guard is `requestedDelay < MINIMUM_DEDUPLICATION_DELAY_MS`,
         * so exactly the floor is accepted. The `ttl` matters as much as the
         * throw: at the floor the flat one-second margin leaves 4000, which
         * is what keeps the `Math.max(1, …)` clamp in `_addToQueue`
         * unreachable. If the floor is ever lowered again, this is the
         * assertion that says how much room is left.
         */
        context('at the five-second floor exactly', () => {
          it('accepts the delay and arms the key for the floor minus the margin', async () => {
            await DummyService.backgroundWithDelay(
              { seconds: 5, jobId: 'myjob' },
              'classRunInBG',
              'bottlearum',
            )

            expectAddedToQueue({
              deduplication: { extend: true, id: 'myjob', replace: true, ttl: 4000 },
              delay: 5000,
              priority: 2,
            })
          })

          it('refuses a delay a hair under it', async () => {
            await expect(
              DummyService.backgroundWithDelay(
                { seconds: 4.999, jobId: 'myjob' },
                'classRunInBG',
                'bottlearum',
              ),
            ).rejects.toThrow(DeduplicatedJobRequiresMinimumDelay)

            expect(spy).not.toHaveBeenCalled()
          })
        })

        context('with a delay under five seconds', () => {
          it('throws when a jobId is present, enqueuing nothing', async () => {
            await expect(
              DummyService.backgroundWithDelay({ seconds: 4 }, 'classRunInBG', 'bottlearum'),
            ).resolves.not.toThrow()

            await expect(
              DummyService.backgroundWithDelay({ seconds: 4, jobId: 'myjob' }, 'classRunInBG', 'bottlearum'),
            ).rejects.toThrow(DeduplicatedJobRequiresMinimumDelay)

            // the legal call above is the only one that reached the queue
            expect(spy).toHaveBeenCalledTimes(1)
          })

          it('enqueues the same short delay when no jobId is present', async () => {
            await DummyService.backgroundWithDelay({ seconds: 4 }, 'classRunInBG', 'bottlearum')

            expectAddedToQueue({ delay: 4000, priority: 2 })
          })
        })
      })

      context('.backgroundWith', () => {
        it('arms the deduplication key for the delay minus the one second margin', async () => {
          await DummyService.backgroundWith(
            { delay: { seconds: 10, jobId: 'myjob' } },
            'classRunInBG',
            'bottlearum',
          )

          expectAddedToQueue({
            deduplication: { extend: true, id: 'myjob', replace: true, ttl: 9000 },
            delay: 10000,
            priority: 2,
          })
        })

        it('clamps a fractional delay to an integral ttl', async () => {
          await DummyService.backgroundWith(
            { delay: { seconds: 10.0005, jobId: 'myjob' } },
            'classRunInBG',
            'bottlearum',
          )

          expectAddedToQueue({
            deduplication: { extend: true, id: 'myjob', replace: true, ttl: 9000 },
            delay: 10000.5,
            priority: 2,
          })
        })

        context('with a delay under five seconds', () => {
          it('throws when a jobId is present, enqueuing nothing', async () => {
            await expect(
              DummyService.backgroundWith(
                { delay: { seconds: 4, jobId: 'myjob' } },
                'classRunInBG',
                'bottlearum',
              ),
            ).rejects.toThrow(DeduplicatedJobRequiresMinimumDelay)

            expect(spy).not.toHaveBeenCalled()
          })

          it('enqueues the same short delay when no jobId is present', async () => {
            await DummyService.backgroundWith({ delay: { seconds: 4 } }, 'classRunInBG', 'bottlearum')

            expectAddedToQueue({ delay: 4000, priority: 2 })
          })
        })
      })

      /**
       * The guard reads the raw `delaySeconds`, above the truthiness coercion
       * that collapses 0, -0 and `NaN` into `undefined`, which is what makes
       * these reachable at all: below that line `NaN` and zero would be a
       * delay-less enqueue carrying a `jobId` that deduplicates nothing, and
       * those two are what goes red if the check ever moves down.
       *
       * The clauses divide the values up: `Infinity` is the only one that
       * reaches the guard non-finite (`durationToSeconds` sums `NaN` away to
       * zero, so `NaN` arrives as zero and lands on the floor), the oversize
       * case is the only one `Math.abs(…) > Number.MAX_SAFE_INTEGER` catches,
       * and the rest fall to the floor. The non-finite and oversize clauses are
       * otherwise unasserted anywhere.
       */
      context('with a jobId behind a delay that is not a usable number of seconds', () => {
        async function expectRefused(seconds: number) {
          await expect(
            DummyService.backgroundWithDelay({ seconds, jobId: 'myjob' }, 'classRunInBG', 'bottlearum'),
          ).rejects.toThrow(DeduplicatedJobRequiresMinimumDelay)

          // nothing was enqueued, and nothing was enqueued undeduplicated
          expect(spy).not.toHaveBeenCalled()
        }

        it('refuses NaN', async () => {
          // reaches the guard as zero, because `durationToSeconds` drops it
          await expectRefused(NaN)
        })

        it('refuses Infinity', async () => {
          await expectRefused(Infinity)
        })

        it('refuses -Infinity', async () => {
          await expectRefused(-Infinity)
        })

        it('refuses a finite delay of unsafe magnitude', async () => {
          // finite, so it passes the clause above; MAX_SAFE_INTEGER seconds is
          // 9.007e18 milliseconds, which is the clause that catches it
          await expectRefused(Number.MAX_SAFE_INTEGER)
        })

        it('refuses zero', async () => {
          await expectRefused(0)
        })

        it('refuses a negative delay', async () => {
          await expectRefused(-10)
        })
      })

      /**
       * `jobId?: string` admits the empty string, and it is what a key built
       * from a missing value looks like. It is not a usable deduplication key
       * (BullMQ refuses it), so it is refused here rather than falling through
       * the deduplication block's truthiness check and enqueuing a delayed job
       * with no key and no signal.
       */
      context('with an empty jobId', () => {
        it('refuses it behind a legal delay, rather than enqueuing with no deduplication', async () => {
          await expect(
            DummyService.backgroundWithDelay({ seconds: 60, jobId: '' }, 'classRunInBG', 'bottlearum'),
          ).rejects.toThrow(DeduplicatedJobRequiresMinimumDelay)

          await expect(
            DummyService.backgroundWith({ delay: { seconds: 60, jobId: '' } }, 'classRunInBG', 'bottlearum'),
          ).rejects.toThrow('was given an empty `jobId`')

          expect(spy).not.toHaveBeenCalled()
        })

        it('enqueues the same delay when the jobId is omitted', async () => {
          await DummyService.backgroundWithDelay({ seconds: 60 }, 'classRunInBG', 'bottlearum')

          expectAddedToQueue({ delay: 60000, priority: 2 })
        })
      })
    })

    /**
     * The floor is validated above the test short-circuit in `_addToQueue`, so
     * it raises in a consumer's default test environment exactly as it does in
     * production. Written without a `testInvocation` override on purpose: if
     * the check ever moves down beside the deduplication block, these are the
     * assertions that go red while every `manual` one above stays green.
     */
    context('with testInvocation automatic, which is the default', () => {
      beforeEach(() => {
        expect(PsychicAppWorkers.getOrFail().testInvocation).toEqual('automatic')
      })

      it('refuses a jobId behind a delay under five seconds from backgroundWithDelay', async () => {
        const spy = vi.spyOn(DummyService, 'classRunInBG').mockImplementation(async () => {})

        await expect(
          DummyService.backgroundWithDelay({ seconds: 4, jobId: 'myjob' }, 'classRunInBG', 'bottlearum'),
        ).rejects.toThrow(DeduplicatedJobRequiresMinimumDelay)

        // the job did not run in-line either: nothing happened at all
        expect(spy).not.toHaveBeenCalled()
      })

      it('refuses a jobId behind a delay under five seconds from backgroundWith', async () => {
        const spy = vi.spyOn(DummyService, 'classRunInBG').mockImplementation(async () => {})

        await expect(
          DummyService.backgroundWith(
            { delay: { seconds: 4, jobId: 'myjob' } },
            'classRunInBG',
            'bottlearum',
          ),
        ).rejects.toThrow(DeduplicatedJobRequiresMinimumDelay)

        expect(spy).not.toHaveBeenCalled()
      })

      it('still runs a short delay that carries no jobId', async () => {
        const spy = vi.spyOn(DummyService, 'classRunInBG').mockImplementation(async () => {})

        await DummyService.backgroundWithDelay({ seconds: 4 }, 'classRunInBG', 'bottlearum')

        expect(spy).toHaveBeenCalledWith('bottlearum', expect.any(Job))
      })
    })
  })
})
