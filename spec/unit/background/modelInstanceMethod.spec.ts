import { Job } from 'bullmq'
import { background, BackgroundQueuePriority } from '../../../src/index.js'
import createUser from '../../../test-app/spec/factories/UserFactory.js'
import User from '../../../test-app/src/app/models/User.js'
import PsychicAppWorkers, {
  PsychicWorkersAppTestInvocationType,
} from '../../../src/psychic-app-workers/index.js'
import WorkerTestUtils from '../../../src/test-utils/WorkerTestUtils.js'

describe('background (app singleton)', () => {
  describe('.modelInstanceMethod', () => {
    it('instantiates the model and calls the specified method with the specified args', async () => {
      const user = await createUser()
      vi.spyOn(User.prototype, '_testBackground')

      await background.modelInstanceMethod(user, 'testBackground', {
        args: ['howyadoin'],
      })

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(User.prototype._testBackground).toHaveBeenCalledWith(user.id, 'howyadoin', expect.any(Job))
    })
  })

  context('priority', () => {
    let user: User
    const subject = async () => {
      await background.modelInstanceMethod(user, 'testBackground', {
        args: ['howyadoin'],
        jobConfig: { priority },
      })
    }
    let priority: BackgroundQueuePriority

    beforeEach(async () => {
      user = await createUser()
    })

    function expectAddedToQueueWithPriority(priority: BackgroundQueuePriority, priorityLevel: number) {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(background.queues[0]!.add).toHaveBeenCalledWith(
        'BackgroundJobQueueModelInstanceJob',
        {
          globalName: 'User',
          id: user.id,
          args: ['howyadoin'],
          method: 'testBackground',
        },
        { priority: priorityLevel },
      )
    }

    let originalTestInvocation: PsychicWorkersAppTestInvocationType

    beforeEach(async () => {
      const workersApp = PsychicAppWorkers.getOrFail()
      originalTestInvocation = workersApp.testInvocation
      workersApp.set('testInvocation', 'manual')

      background.connect()
      vi.spyOn(background.queues[0]!, 'add').mockResolvedValue({} as Job)

      await WorkerTestUtils.clean()
    })

    afterEach(() => {
      const workersApp = PsychicAppWorkers.getOrFail()
      workersApp.set('testInvocation', originalTestInvocation)
    })

    context('default priority', () => {
      beforeEach(() => {
        priority = 'default'
      })

      it('sends the default priority to the queue', async () => {
        await subject()
        expectAddedToQueueWithPriority('default', 2)
      })
    })

    context('urgent priority', () => {
      beforeEach(() => {
        priority = 'urgent'
      })

      it('sends the urgent priority to the queue', async () => {
        await subject()
        expectAddedToQueueWithPriority('urgent', 1)
      })
    })

    context('not_urgent priority', () => {
      beforeEach(() => {
        priority = 'not_urgent'
      })

      it('sends the not_urgent priority to the queue', async () => {
        await subject()
        expectAddedToQueueWithPriority('not_urgent', 3)
      })
    })

    context('last priority', () => {
      beforeEach(() => {
        priority = 'last'
      })

      it('sends the last priority to the queue', async () => {
        await subject()
        expectAddedToQueueWithPriority('last', 4)
      })
    })
  })

  context('delaySeconds', () => {
    let user: User
    const subject = async () => {
      await background.modelInstanceMethod(user, 'testBackground', {
        args: ['howyadoin'],
        delaySeconds,
      })
    }
    let delaySeconds: number

    beforeEach(async () => {
      user = await createUser()
    })

    function expectAddedToQueueWithDelay(priority: BackgroundQueuePriority, delay: number) {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(background.queues[0]!.add).toHaveBeenCalledWith(
        'BackgroundJobQueueModelInstanceJob',
        {
          globalName: 'User',
          id: user.id,
          args: ['howyadoin'],
          method: 'testBackground',
        },
        { delay, priority: 2 },
      )
    }

    let originalTestInvocation: PsychicWorkersAppTestInvocationType

    beforeEach(async () => {
      const workersApp = PsychicAppWorkers.getOrFail()
      originalTestInvocation = workersApp.testInvocation
      workersApp.set('testInvocation', 'manual')

      background.connect()
      vi.spyOn(background.queues[0]!, 'add').mockResolvedValue({} as Job)

      await WorkerTestUtils.clean()
    })

    afterEach(() => {
      const workersApp = PsychicAppWorkers.getOrFail()
      workersApp.set('testInvocation', originalTestInvocation)
    })

    it('sets the delay in milliseconds', async () => {
      delaySeconds = 20
      await subject()
      expectAddedToQueueWithDelay('default', 20000)
    })
  })
})
