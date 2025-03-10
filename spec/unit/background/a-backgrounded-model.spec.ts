import { Job } from 'bullmq'
import { background } from '../../../src'
import User from '../../../test-app/src/app/models/User'

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
      beforeEach(() => {
        process.env.REALLY_TEST_BACKGROUND_QUEUE = '1'
        background.connect()
      })

      afterEach(() => {
        process.env.REALLY_TEST_BACKGROUND_QUEUE = undefined
      })

      it('adds the job to the queue corresponding to the workstream name with the workstream name as the group ID, and moves the priority into the group object', async () => {
        const spy = vi.spyOn(background.queues[1], 'add').mockResolvedValue({} as Job)
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
      beforeEach(() => {
        process.env.REALLY_TEST_BACKGROUND_QUEUE = '1'
        background.connect()
      })

      afterEach(() => {
        process.env.REALLY_TEST_BACKGROUND_QUEUE = undefined
      })

      it('adds the job to the queue corresponding to the workstream name with the workstream name as the group ID, and moves the priority into the group object', async () => {
        const user = await User.create({ email: 'a@b.com' })
        const spy = vi.spyOn(background.queues[1], 'add').mockResolvedValue({} as Job)
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
      await User.backgroundWithDelay(25, 'classRunInBG', 'bottlearum')
      expect(spy).toHaveBeenCalledWith('bottlearum', expect.any(Job))
    })

    context('priority and named workstream', () => {
      beforeEach(() => {
        process.env.REALLY_TEST_BACKGROUND_QUEUE = '1'
        background.connect()
      })

      afterEach(() => {
        process.env.REALLY_TEST_BACKGROUND_QUEUE = undefined
      })

      it('adds the job to the queue corresponding to the workstream name with the workstream name as the group ID, and moves the priority into the group object', async () => {
        const spy = vi.spyOn(background.queues[1], 'add').mockResolvedValue({} as Job)
        await User.backgroundWithDelay(15, 'classRunInBG', 'bottlearum')

        expect(spy).toHaveBeenCalledWith(
          'BackgroundJobQueueStaticJob',
          {
            globalName: User.globalName,
            args: ['bottlearum'],
            importKey: undefined,
            method: 'classRunInBG',
          },
          { delay: 15000, group: { id: 'snazzy', priority: 1 } },
        )
      })
    })
  })

  describe('#backgroundWithDelay', () => {
    it('calls the instance method, passing args', async () => {
      const user = await User.create({ email: 'a@b.com' })
      const spy = vi.spyOn(User.prototype, 'instanceMethodToTest').mockImplementation(async () => {})
      await user.backgroundWithDelay(15, 'instanceRunInBG', 'bottlearum')
      expect(spy).toHaveBeenCalledWith('bottlearum', expect.any(Job))
    })

    context('when the model is destroyed before the background job picks it up', () => {
      it('does not throw an error', async () => {
        const user = await User.create({ email: 'a@b.com' })
        await user.destroy()
        await expect(user.backgroundWithDelay(15, 'instanceRunInBG', 'bottlearum')).resolves.not.toThrow()
      })
    })

    context('priority and named workstream', () => {
      beforeEach(() => {
        process.env.REALLY_TEST_BACKGROUND_QUEUE = '1'
        background.connect()
      })

      afterEach(() => {
        process.env.REALLY_TEST_BACKGROUND_QUEUE = undefined
      })

      it('adds the job to the queue corresponding to the workstream name with the workstream name as the group ID, and moves the priority into the group object', async () => {
        const spy = vi.spyOn(background.queues[1], 'add').mockResolvedValue({} as Job)
        const user = await User.create({ email: 'a@b.com' })

        await user.backgroundWithDelay(7, 'instanceRunInBG', 'bottlearum')

        expect(spy).toHaveBeenCalledWith(
          'BackgroundJobQueueModelInstanceJob',
          {
            globalName: User.globalName,
            args: ['bottlearum'],
            id: user.id,
            method: 'instanceRunInBG',
          },
          { delay: 7000, group: { id: 'snazzy', priority: 1 } },
        )
      })
    })
  })
})
