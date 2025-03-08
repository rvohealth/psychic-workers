import { Job } from 'bullmq'
import { background, BackgroundQueuePriority } from '../../../src'
import User from '../../../test-app/src/app/models/User'
import createUser from '../../../test-app/spec/factories/UserFactory'

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
      expect(background.queues[0].add).toHaveBeenCalledWith(
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

    beforeEach(() => {
      process.env.REALLY_TEST_BACKGROUND_QUEUE = '1'
      background.connect()

      vi.spyOn(background.queues[0], 'add').mockResolvedValue({} as Job)
    })

    afterEach(() => {
      process.env.REALLY_TEST_BACKGROUND_QUEUE = undefined
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
      expect(background.queues[0].add).toHaveBeenCalledWith(
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

    beforeEach(() => {
      process.env.REALLY_TEST_BACKGROUND_QUEUE = '1'
      background.connect()

      vi.spyOn(background.queues[0], 'add').mockResolvedValue({} as Job)
    })

    afterEach(() => {
      process.env.REALLY_TEST_BACKGROUND_QUEUE = undefined
    })

    it('sets the delay in milliseconds', async () => {
      delaySeconds = 20
      await subject()
      expectAddedToQueueWithDelay('default', 20000)
    })
  })
})
