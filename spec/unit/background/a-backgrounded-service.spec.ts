import { describe as context } from '@jest/globals'
import { Job } from 'bullmq'
import { background, BackgroundQueuePriority } from '../../../src'
import DummyService from '../../../test-app/src/app/services/DummyService'
import LastDummyService from '../../../test-app/src/app/services/LastDummyService'
import LastDummyServiceInNamedWorkstream from '../../../test-app/src/app/services/LastDummyServiceInNamedWorkstream'
import NotUrgentDummyService from '../../../test-app/src/app/services/NotUrgentDummyService'
import UrgentDummyService from '../../../test-app/src/app/services/UrgentDummyService'

describe('a backgrounded service', () => {
  describe('.background', () => {
    it('calls the static method, passing args', async () => {
      jest.spyOn(DummyService, 'classRunInBG').mockImplementation(async () => {})
      jest.spyOn(DummyService, 'classRunInBGWithJobArg').mockImplementation(async () => {})
      await DummyService.background('classRunInBG', 'bottlearum')
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(DummyService.classRunInBG).toHaveBeenCalledWith('bottlearum', expect.any(Job))

      await DummyService.background('classRunInBGWithJobArg', 'bottlearum')
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(DummyService.classRunInBGWithJobArg).toHaveBeenCalledWith('bottlearum', expect.any(Job))
    })
  })

  describe('#background', () => {
    it('calls the instance method, passing constructor args to the constructor and args to the instance method', async () => {
      jest.spyOn(DummyService.prototype, 'instanceMethodToTest').mockImplementation(async () => {})
      await new DummyService('hello').background('instanceRunInBG', {
        args: ['bottlearum'],
        constructorArgs: ['bottleawhiskey'],
      })
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(DummyService.prototype.instanceMethodToTest).toHaveBeenCalledWith(
        'bottleawhiskey',
        'bottlearum',
        expect.any(Job),
      )
    })

    context('queue priority', () => {
      const subject = async () => {
        await new serviceClass('hello').background('instanceRunInBG', {
          args: ['bottlearum'],
          constructorArgs: ['bottleawhiskey'],
        })
      }

      let serviceClass:
        | typeof DummyService
        | typeof UrgentDummyService
        | typeof NotUrgentDummyService
        | typeof LastDummyService

      function expectAddedToQueueWithPriority(priority: BackgroundQueuePriority, priorityLevel: number) {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        expect(background.queues[0].add).toHaveBeenCalledWith(
          'BackgroundJobQueueInstanceJob',
          {
            globalName: `services/${serviceClass.name}`,
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
      beforeEach(() => {
        process.env.REALLY_TEST_BACKGROUND_QUEUE = '1'
        background.connect()
        jest.spyOn(background.queues[1], 'add').mockResolvedValue({} as Job)
      })

      afterEach(() => {
        process.env.REALLY_TEST_BACKGROUND_QUEUE = undefined
      })

      it('adds the job to the queue corresponding to the workstream name with the workstream name as the group ID, and moves the priority into the group object', async () => {
        await new LastDummyServiceInNamedWorkstream('hello').background('instanceRunInBG', {
          args: ['bottlearum'],
          constructorArgs: ['bottleawhiskey'],
        })

        // eslint-disable-next-line @typescript-eslint/unbound-method
        expect(background.queues[1].add).toHaveBeenCalledWith(
          'BackgroundJobQueueInstanceJob',
          {
            globalName: 'services/LastDummyServiceInNamedWorkstream',
            args: ['bottlearum'],
            constructorArgs: ['bottleawhiskey'],
            importKey: undefined,
            method: 'instanceRunInBG',
          },
          { group: { id: 'snazzy', priority: 4 } },
        )
      })
    })
  })

  describe('.backgroundWithDelay', () => {
    it('calls the static method, passing args', async () => {
      jest.spyOn(DummyService, 'classRunInBG').mockImplementation(async () => {})
      await DummyService.backgroundWithDelay(25, 'classRunInBG', 'bottlearum')
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(DummyService.classRunInBG).toHaveBeenCalledWith('bottlearum', expect.any(Job))
    })
  })

  describe('#backgroundWithDelay', () => {
    it('calls the instance method, passing constructor args to the constructor and args to the instance method', async () => {
      jest.spyOn(DummyService.prototype, 'instanceMethodToTest').mockImplementation(async () => {})
      await new DummyService('hello').backgroundWithDelay(15, 'instanceRunInBG', {
        args: ['bottlearum'],
        constructorArgs: ['bottleawhiskey'],
      })

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(DummyService.prototype.instanceMethodToTest).toHaveBeenCalledWith(
        'bottleawhiskey',
        'bottlearum',
        expect.any(Job),
      )
    })

    context('queue priority', () => {
      const subject = async () => {
        await new serviceClass('hello').backgroundWithDelay(7, 'instanceRunInBG', {
          args: ['bottlearum'],
          constructorArgs: ['bottleawhiskey'],
        })
      }
      let serviceClass:
        | typeof DummyService
        | typeof UrgentDummyService
        | typeof NotUrgentDummyService
        | typeof LastDummyService

      function expectAddedToQueueWithPriority(priority: BackgroundQueuePriority, priorityLevel: number) {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        expect(background.queues[0].add).toHaveBeenCalledWith(
          'BackgroundJobQueueInstanceJob',
          {
            globalName: `services/${serviceClass.name}`,
            args: ['bottlearum'],
            constructorArgs: ['bottleawhiskey'],
            importKey: undefined,
            method: 'instanceRunInBG',
          },
          { delay: 7000, priority: priorityLevel },
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
      beforeEach(() => {
        process.env.REALLY_TEST_BACKGROUND_QUEUE = '1'
        background.connect()
        jest.spyOn(background.queues[1], 'add').mockResolvedValue({} as Job)
      })

      afterEach(() => {
        process.env.REALLY_TEST_BACKGROUND_QUEUE = undefined
      })

      it('adds the job to the queue corresponding to the workstream name with the workstream name as the group ID, and moves the priority into the group object', async () => {
        await new LastDummyServiceInNamedWorkstream('hello').backgroundWithDelay(7, 'instanceRunInBG', {
          args: ['bottlearum'],
          constructorArgs: ['bottleawhiskey'],
        })

        // eslint-disable-next-line @typescript-eslint/unbound-method
        expect(background.queues[1].add).toHaveBeenCalledWith(
          'BackgroundJobQueueInstanceJob',
          {
            globalName: 'services/LastDummyServiceInNamedWorkstream',
            args: ['bottlearum'],
            constructorArgs: ['bottleawhiskey'],
            importKey: undefined,
            method: 'instanceRunInBG',
          },
          { delay: 7000, group: { id: 'snazzy', priority: 4 } },
        )
      })
    })
  })
})
