import { Job } from 'bullmq'
import { background } from '../../../src/index.js'
import User from '../../../test-app/src/app/models/User.js'
import PsychicAppWorkers, {
  PsychicWorkersAppTestInvocationType,
} from '../../../src/psychic-app-workers/index.js'
import WorkerTestUtils from '../../../src/test-utils/WorkerTestUtils.js'

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

      it('adds the job to the queue corresponding to the workstream name with the workstream name as the group ID, and moves the priority into the group object', async () => {
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
          { group: { id: 'snazzy', priority: 1 } },
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

      it('adds the job to the queue corresponding to the workstream name with the workstream name as the group ID, and moves the priority into the group object', async () => {
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
          { group: { id: 'snazzy', priority: 1 } },
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

      it('adds the job to the queue corresponding to the workstream name with the workstream name as the group ID, and moves the priority into the group object', async () => {
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
          { delay: 15000, jobId: 'myjob', group: { id: 'snazzy', priority: 1 } },
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

      it('adds the job to the queue corresponding to the workstream name with the workstream name as the group ID, and moves the priority into the group object', async () => {
        const spy = vi.spyOn(background.queues[1]!, 'add').mockResolvedValue({} as Job)
        const user = await User.create({ email: 'a@b.com' })

        await user.backgroundWithDelay({ seconds: 7, jobId: 'myjob' }, 'instanceRunInBG', 'bottlearum')

        expect(spy).toHaveBeenCalledWith(
          'BackgroundJobQueueModelInstanceJob',
          {
            globalName: User.globalName,
            args: ['bottlearum'],
            id: user.id,
            method: 'instanceRunInBG',
          },
          { delay: 7000, jobId: 'myjob', group: { id: 'snazzy', priority: 1 } },
        )
      })
    })
  })
})
