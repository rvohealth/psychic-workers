import { Job } from 'bullmq'
import { MockInstance } from 'vitest'
import DebouncedJobRequiresMinimumDelay from '../../../src/error/background/DebouncedJobRequiresMinimumDelay.js'
import { background } from '../../../src/package-exports/index.js'
import PsychicAppWorkers, {
  PsychicWorkersAppTestInvocationType,
} from '../../../src/psychic-app-workers/index.js'
import WorkerTestUtils from '../../../src/test-utils/WorkerTestUtils.js'
import User from '../../../test-app/src/app/models/User.js'

describe('a backgrounded model', () => {
  describe('.background', () => {
    it('calls the static method, passing args', async () => {
      const bgSpy = vi.spyOn(User, 'classRunInBG').mockImplementation(async () => {})
      const bgWithJobArgSpy = vi.spyOn(User, 'classRunInBGWithJobArg').mockImplementation(async () => {})

      await User.background('classRunInBG', 'bottlearum')
      expect(bgSpy).toHaveBeenCalledWith('bottlearum', expect.any(Job))

      await User.background('classRunInBGWithJobArg', 'bottlearum')
      expect(bgWithJobArgSpy).toHaveBeenCalledWith('bottlearum', expect.any(Job))
    })

    context('when the model is destroyed before the background job picks it up', () => {
      it('does not throw an error', async () => {
        const user = await User.create({ email: 'a@b.com' })
        await user.destroy()
        await expect(user.background('instanceRunInBG', 'bottlearum')).resolves.not.toThrow()
      })
    })

    context('priority and named workstream', () => {
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
        await User.background('classRunInBG', 'bottlearum')

        expect(spy).toHaveBeenCalledWith(
          'BackgroundJobQueueStaticJob',
          {
            globalName: User.globalName,
            args: ['bottlearum'],
            importKey: undefined,
            method: 'classRunInBG',
          },
          { priority: 1, group: { id: 'snazzy', priority: 1 } },
        )
      })
    })
  })

  describe('#background', () => {
    beforeEach(async () => {})

    it('calls the instance method, passing args', async () => {
      const spy = vi.spyOn(User.prototype, 'instanceMethodToTest').mockImplementation(async () => {})
      const user = await User.create({ email: 'a@b.com' })
      await user.background('instanceRunInBG', 'bottlearum')
      expect(spy).toHaveBeenCalledWith('bottlearum', expect.any(Job))
    })

    context('priority and named workstream', () => {
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
        const user = await User.create({ email: 'a@b.com' })
        const spy = vi.spyOn(background.queues[1]!, 'add').mockResolvedValue({} as Job)
        await user.background('instanceRunInBG', 'bottlearum')

        expect(spy).toHaveBeenCalledWith(
          'BackgroundJobQueueModelInstanceJob',
          {
            globalName: User.globalName,
            args: ['bottlearum'],
            id: user.id,
            method: 'instanceRunInBG',
          },
          { priority: 1, group: { id: 'snazzy', priority: 1 } },
        )
      })
    })
  })

  describe('.backgroundWithDelay', () => {
    it('calls the static method, passing args', async () => {
      const spy = vi.spyOn(User, 'classRunInBG').mockImplementation(async () => {})
      await User.backgroundWithDelay({ seconds: 25 }, 'classRunInBG', 'bottlearum')
      expect(spy).toHaveBeenCalledWith('bottlearum', expect.any(Job))
    })

    context('priority and named workstream', () => {
      let originalTestInvocation: PsychicWorkersAppTestInvocationType

      beforeEach(async () => {
        const workersApp = PsychicAppWorkers.getOrFail()
        originalTestInvocation = workersApp.testInvocation
        workersApp.set('testInvocation', 'manual')

        background.connect()

        for (const queue of background.queues) {
          await queue.drain()
          await queue.clean(5000, 10000, 'completed')
        }
      })

      afterEach(() => {
        const workersApp = PsychicAppWorkers.getOrFail()
        workersApp.set('testInvocation', originalTestInvocation)
      })

      it('adds the job to the queue corresponding to the workstream name with the workstream name as the group ID, and writes the priority both at the top level and into the group object', async () => {
        const spy = vi.spyOn(background.queues[1]!, 'add').mockResolvedValue({} as Job)
        await User.backgroundWithDelay({ seconds: 15, jobId: 'myjob' }, 'classRunInBG', 'bottlearum')

        expect(spy).toHaveBeenCalledWith(
          'BackgroundJobQueueStaticJob',
          {
            globalName: User.globalName,
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

  describe('#backgroundWithDelay', () => {
    it('calls the instance method, passing args', async () => {
      const user = await User.create({ email: 'a@b.com' })
      const spy = vi.spyOn(User.prototype, 'instanceMethodToTest').mockImplementation(async () => {})
      await user.backgroundWithDelay({ seconds: 15, jobId: 'myjob' }, 'instanceRunInBG', 'bottlearum')
      expect(spy).toHaveBeenCalledWith('bottlearum', expect.any(Job))
    })

    context('when the model is destroyed before the background job picks it up', () => {
      it('does not throw an error', async () => {
        const user = await User.create({ email: 'a@b.com' })
        await user.destroy()
        await expect(
          user.backgroundWithDelay({ seconds: 15, jobId: 'myjob' }, 'instanceRunInBG', 'bottlearum'),
        ).resolves.not.toThrow()
      })
    })

    context('priority and named workstream', () => {
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
        const user = await User.create({ email: 'a@b.com' })

        await user.backgroundWithDelay({ seconds: 15, jobId: 'myjob' }, 'instanceRunInBG', 'bottlearum')

        expect(spy).toHaveBeenCalledWith(
          'BackgroundJobQueueModelInstanceJob',
          {
            globalName: User.globalName,
            args: ['bottlearum'],
            id: user.id,
            method: 'instanceRunInBG',
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

  describe('.backgroundWith', () => {
    it('calls the static method, passing args', async () => {
      const spy = vi.spyOn(User, 'classRunInBG').mockImplementation(async () => {})
      await User.backgroundWith(
        { delay: { seconds: 25, jobId: 'myjob' }, priority: 'last' },
        'classRunInBG',
        'bottlearum',
      )
      expect(spy).toHaveBeenCalledWith('bottlearum', expect.any(Job))
    })

    context('priority and named workstream', () => {
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

      context('with no options', () => {
        it('uses the priority from backgroundJobConfig and does not delay', async () => {
          const spy = vi.spyOn(background.queues[1]!, 'add').mockResolvedValue({} as Job)
          await User.backgroundWith({}, 'classRunInBG', 'bottlearum')

          expect(spy).toHaveBeenCalledWith(
            'BackgroundJobQueueStaticJob',
            {
              globalName: User.globalName,
              args: ['bottlearum'],
              importKey: undefined,
              method: 'classRunInBG',
            },
            { priority: 1, group: { id: 'snazzy', priority: 1 } },
          )
        })
      })

      context('with a delay and a priority', () => {
        it('delays the job and overrides the priority within the group object', async () => {
          const spy = vi.spyOn(background.queues[1]!, 'add').mockResolvedValue({} as Job)
          await User.backgroundWith(
            { delay: { seconds: 15, jobId: 'myjob' }, priority: 'last' },
            'classRunInBG',
            'bottlearum',
          )

          expect(spy).toHaveBeenCalledWith(
            'BackgroundJobQueueStaticJob',
            {
              globalName: User.globalName,
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

        it('does not mutate the backgroundJobConfig of the model', async () => {
          vi.spyOn(background.queues[1]!, 'add').mockResolvedValue({} as Job)
          await User.backgroundWith({ priority: 'last' }, 'classRunInBG', 'bottlearum')
          expect(User.backgroundJobConfig.priority).toEqual('urgent')
        })
      })
    })
  })

  describe('#backgroundWith', () => {
    it('calls the instance method, passing args', async () => {
      const user = await User.create({ email: 'a@b.com' })
      const spy = vi.spyOn(User.prototype, 'instanceMethodToTest').mockImplementation(async () => {})
      await user.backgroundWith(
        { delay: { seconds: 15, jobId: 'myjob' }, priority: 'last' },
        'instanceRunInBG',
        'bottlearum',
      )
      expect(spy).toHaveBeenCalledWith('bottlearum', expect.any(Job))
    })

    context('when the model is destroyed before the background job picks it up', () => {
      it('does not throw an error', async () => {
        const user = await User.create({ email: 'a@b.com' })
        await user.destroy()
        await expect(
          user.backgroundWith({ priority: 'last' }, 'instanceRunInBG', 'bottlearum'),
        ).resolves.not.toThrow()
      })
    })

    context('priority and named workstream', () => {
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

      context('with only a priority', () => {
        it('overrides the priority within the group object and does not delay', async () => {
          const spy = vi.spyOn(background.queues[1]!, 'add').mockResolvedValue({} as Job)
          const user = await User.create({ email: 'a@b.com' })

          await user.backgroundWith({ priority: 'not_urgent' }, 'instanceRunInBG', 'bottlearum')

          expect(spy).toHaveBeenCalledWith(
            'BackgroundJobQueueModelInstanceJob',
            {
              globalName: User.globalName,
              args: ['bottlearum'],
              id: user.id,
              method: 'instanceRunInBG',
            },
            { priority: 3, group: { id: 'snazzy', priority: 3 } },
          )
        })
      })

      context('with a delay and a priority', () => {
        it('delays the job and overrides the priority within the group object', async () => {
          const spy = vi.spyOn(background.queues[1]!, 'add').mockResolvedValue({} as Job)
          const user = await User.create({ email: 'a@b.com' })

          await user.backgroundWith(
            { delay: { seconds: 15, jobId: 'myjob' }, priority: 'last' },
            'instanceRunInBG',
            'bottlearum',
          )

          expect(spy).toHaveBeenCalledWith(
            'BackgroundJobQueueModelInstanceJob',
            {
              globalName: User.globalName,
              args: ['bottlearum'],
              id: user.id,
              method: 'instanceRunInBG',
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
  })

  /**
   * The same debounce default, reached through the model-instance entry
   * point rather than the static one — a separate caller of `_addToQueue`. The
   * numbers themselves, the fractional clamp and the automatic-invocation
   * refusal are pinned in `a-backgrounded-service.spec.ts`.
   */
  describe('deduplication (debounce) options', () => {
    let spy: MockInstance
    let originalTestInvocation: PsychicWorkersAppTestInvocationType

    beforeEach(async () => {
      const workersApp = PsychicAppWorkers.getOrFail()
      originalTestInvocation = workersApp.testInvocation
      workersApp.set('testInvocation', 'manual')

      background.connect()
      spy = vi.spyOn(background.queues[1]!, 'add').mockResolvedValue({} as Job)

      await WorkerTestUtils.clean()
    })

    afterEach(() => {
      const workersApp = PsychicAppWorkers.getOrFail()
      workersApp.set('testInvocation', originalTestInvocation)
    })

    context('#backgroundWithDelay', () => {
      it('arms the deduplication key for the delay minus the one second margin', async () => {
        const user = await User.create({ email: 'a@b.com' })

        await user.backgroundWithDelay({ seconds: 10, jobId: 'myjob' }, 'instanceRunInBG', 'bottlearum')

        expect(spy).toHaveBeenCalledWith(
          'BackgroundJobQueueModelInstanceJob',
          {
            globalName: User.globalName,
            args: ['bottlearum'],
            id: user.id,
            method: 'instanceRunInBG',
          },
          {
            deduplication: { extend: true, id: 'myjob', replace: true, ttl: 9000 },
            delay: 10000,
            priority: 1,
            group: { id: 'snazzy', priority: 1 },
          },
        )
      })

      context('with a delay under three seconds', () => {
        it('throws when a jobId is present, enqueuing nothing', async () => {
          const user = await User.create({ email: 'a@b.com' })

          await expect(
            user.backgroundWithDelay({ seconds: 2, jobId: 'myjob' }, 'instanceRunInBG', 'bottlearum'),
          ).rejects.toThrow(DebouncedJobRequiresMinimumDelay)

          expect(spy).not.toHaveBeenCalled()
        })

        it('enqueues the same short delay when no jobId is present', async () => {
          const user = await User.create({ email: 'a@b.com' })

          await user.backgroundWithDelay({ seconds: 2 }, 'instanceRunInBG', 'bottlearum')

          expect(spy).toHaveBeenCalledWith(
            'BackgroundJobQueueModelInstanceJob',
            {
              globalName: User.globalName,
              args: ['bottlearum'],
              id: user.id,
              method: 'instanceRunInBG',
            },
            { delay: 2000, priority: 1, group: { id: 'snazzy', priority: 1 } },
          )
        })
      })
    })

    context('#backgroundWith', () => {
      it('arms the deduplication key for the delay minus the one second margin', async () => {
        const user = await User.create({ email: 'a@b.com' })

        await user.backgroundWith({ delay: { seconds: 10, jobId: 'myjob' } }, 'instanceRunInBG', 'bottlearum')

        expect(spy).toHaveBeenCalledWith(
          'BackgroundJobQueueModelInstanceJob',
          {
            globalName: User.globalName,
            args: ['bottlearum'],
            id: user.id,
            method: 'instanceRunInBG',
          },
          {
            deduplication: { extend: true, id: 'myjob', replace: true, ttl: 9000 },
            delay: 10000,
            priority: 1,
            group: { id: 'snazzy', priority: 1 },
          },
        )
      })

      context('with a delay under three seconds', () => {
        it('throws when a jobId is present, enqueuing nothing', async () => {
          const user = await User.create({ email: 'a@b.com' })

          await expect(
            user.backgroundWith({ delay: { seconds: 2, jobId: 'myjob' } }, 'instanceRunInBG', 'bottlearum'),
          ).rejects.toThrow(DebouncedJobRequiresMinimumDelay)

          expect(spy).not.toHaveBeenCalled()
        })

        it('enqueues the same short delay when no jobId is present', async () => {
          const user = await User.create({ email: 'a@b.com' })

          await user.backgroundWith({ delay: { seconds: 2 } }, 'instanceRunInBG', 'bottlearum')

          expect(spy).toHaveBeenCalledWith(
            'BackgroundJobQueueModelInstanceJob',
            {
              globalName: User.globalName,
              args: ['bottlearum'],
              id: user.id,
              method: 'instanceRunInBG',
            },
            { delay: 2000, priority: 1, group: { id: 'snazzy', priority: 1 } },
          )
        })
      })
    })
  })
})
