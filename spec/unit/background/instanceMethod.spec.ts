import { describe as context } from '@jest/globals'
import { Job } from 'bullmq'
import { background, BackgroundQueuePriority } from '../../../src'
import DummyService from '../../../test-app/src/app/services/DummyService'
import readTmpFile from '../../helpers/readTmpFile'

describe('background (app singleton)', () => {
  describe('#instanceMethod', () => {
    it('calls the instance method, passing constructor args to the constructor and args to the instance method', async () => {
      await background.instanceMethod(DummyService, 'instanceRunInBG', {
        args: ['bottlearum'],
        constructorArgs: ['bottleawhiskey'],
        globalName: 'services/DummyService',
      })
      expect(await readTmpFile()).toEqual('bottleawhiskey,bottlearum,BackgroundJobQueueInstanceJob')
    })

    context('priority', () => {
      const subject = async () => {
        await background.instanceMethod(DummyService, 'instanceRunInBG', {
          args: ['bottlearum'],
          constructorArgs: ['bottleawhiskey'],
          globalName: 'services/DummyService',
          jobConfig: { priority },
        })
      }
      let priority: BackgroundQueuePriority

      function expectAddedToQueueWithPriority(priority: BackgroundQueuePriority, priorityLevel: number) {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        expect(background.queues[0].add).toHaveBeenCalledWith(
          'BackgroundJobQueueInstanceJob',
          {
            globalName: 'services/DummyService',
            args: ['bottlearum'],
            constructorArgs: ['bottleawhiskey'],
            importKey: undefined,
            method: 'instanceRunInBG',
          },
          { priority: priorityLevel },
        )
      }

      beforeEach(() => {
        process.env.REALLY_TEST_BACKGROUND_QUEUE = '1'
        background.connect()

        jest.spyOn(background.queues[0], 'add').mockResolvedValue({} as Job)
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

    context('named workstream', () => {
      beforeEach(() => {
        process.env.REALLY_TEST_BACKGROUND_QUEUE = '1'
        background.connect()
        jest.spyOn(background.queues[1], 'add').mockResolvedValue({} as Job)
      })

      afterEach(() => {
        process.env.REALLY_TEST_BACKGROUND_QUEUE = undefined
      })

      it('adds the job to the queue corresponding to the workstream name with the workstream name as the group ID, and moves the priority into the group object', async () => {
        await background.instanceMethod(DummyService, 'instanceRunInBG', {
          args: ['bottlearum'],
          constructorArgs: ['bottleawhiskey'],
          globalName: 'services/DummyService',
          jobConfig: { priority: 'last', workstream: 'snazzy' },
        })

        // eslint-disable-next-line @typescript-eslint/unbound-method
        expect(background.queues[1].add).toHaveBeenCalledWith(
          'BackgroundJobQueueInstanceJob',
          {
            globalName: 'services/DummyService',
            args: ['bottlearum'],
            constructorArgs: ['bottleawhiskey'],
            importKey: undefined,
            method: 'instanceRunInBG',
          },
          { group: { id: 'snazzy', priority: 4 } },
        )
      })
    })

    context('delaySeconds', () => {
      const subject = async () => {
        await background.instanceMethod(DummyService, 'instanceRunInBG', {
          args: ['bottlearum'],
          constructorArgs: ['bottleawhiskey'],
          globalName: 'services/DummyService',
          delaySeconds,
        })
      }
      let delaySeconds: number

      function expectAddedToQueueWithDelay(priority: BackgroundQueuePriority, delay: number) {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        expect(background.queues[0].add).toHaveBeenCalledWith(
          'BackgroundJobQueueInstanceJob',
          {
            globalName: 'services/DummyService',
            args: ['bottlearum'],
            constructorArgs: ['bottleawhiskey'],
            importKey: undefined,
            method: 'instanceRunInBG',
          },
          { delay, priority: 2 },
        )
      }

      beforeEach(() => {
        process.env.REALLY_TEST_BACKGROUND_QUEUE = '1'
        background.connect()

        jest.spyOn(background.queues[0], 'add').mockResolvedValue({} as Job)
      })

      afterEach(() => {
        process.env.REALLY_TEST_BACKGROUND_QUEUE = undefined
      })

      it('sets the delay in milliseconds', async () => {
        delaySeconds = 30
        await subject()
        expectAddedToQueueWithDelay('default', 30000)
      })
    })
  })
})
