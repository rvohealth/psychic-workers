import { Job } from 'bullmq'
import { background, BackgroundQueuePriority } from '../../../src'
import DummyService from '../../../test-app/src/app/services/DummyService'
import LastDummyService from '../../../test-app/src/app/services/LastDummyService'
import LastDummyServiceInNamedWorkstream from '../../../test-app/src/app/services/LastDummyServiceInNamedWorkstream'
import NotUrgentDummyService from '../../../test-app/src/app/services/NotUrgentDummyService'
import UrgentDummyService from '../../../test-app/src/app/services/UrgentDummyService'
import { MockInstance } from 'vitest'

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

    context('queue priority', () => {
      let spy: MockInstance

      const subject = async () => {
        await serviceClass.background('classRunInBG', 'bottlearum')
      }

      beforeEach(() => {
        process.env.REALLY_TEST_BACKGROUND_QUEUE = '1'
        background.connect()

        spy = vi.spyOn(background.queues[0], 'add').mockResolvedValue({} as Job)
      })

      afterEach(() => {
        process.env.REALLY_TEST_BACKGROUND_QUEUE = undefined
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
      beforeEach(() => {
        process.env.REALLY_TEST_BACKGROUND_QUEUE = '1'
        background.connect()
      })

      afterEach(() => {
        process.env.REALLY_TEST_BACKGROUND_QUEUE = undefined
      })

      it('adds the job to the queue corresponding to the workstream name with the workstream name as the group ID, and moves the priority into the group object', async () => {
        const spy = vi.spyOn(background.queues[1], 'add').mockResolvedValue({} as Job)
        await LastDummyServiceInNamedWorkstream.background('classRunInBG', 'bottlearum')

        expect(spy).toHaveBeenCalledWith(
          'BackgroundJobQueueStaticJob',
          {
            globalName: 'services/LastDummyServiceInNamedWorkstream',
            args: ['bottlearum'],
            importKey: undefined,
            method: 'classRunInBG',
          },
          { group: { id: 'snazzy', priority: 4 } },
        )
      })
    })
  })

  describe('.backgroundWithDelay', () => {
    it('calls the static method, passing args', async () => {
      const spy = vi.spyOn(DummyService, 'classRunInBG').mockImplementation(async () => {})
      await DummyService.backgroundWithDelay(25, 'classRunInBG', 'bottlearum')
      expect(spy).toHaveBeenCalledWith('bottlearum', expect.any(Job))
    })

    context('queue priority', () => {
      let spy: MockInstance

      const subject = async () => {
        await serviceClass.backgroundWithDelay(7, 'classRunInBG', 'bottlearum')
      }

      beforeEach(() => {
        process.env.REALLY_TEST_BACKGROUND_QUEUE = '1'
        background.connect()

        spy = vi.spyOn(background.queues[0], 'add').mockResolvedValue({} as Job)
      })

      afterEach(() => {
        process.env.REALLY_TEST_BACKGROUND_QUEUE = undefined
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
          { delay: 7000, priority: priorityLevel },
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
      beforeEach(() => {
        process.env.REALLY_TEST_BACKGROUND_QUEUE = '1'
        background.connect()
      })

      afterEach(() => {
        process.env.REALLY_TEST_BACKGROUND_QUEUE = undefined
      })

      it('adds the job to the queue corresponding to the workstream name with the workstream name as the group ID, and moves the priority into the group object', async () => {
        const spy = vi.spyOn(background.queues[1], 'add').mockResolvedValue({} as Job)
        await LastDummyServiceInNamedWorkstream.backgroundWithDelay(7, 'classRunInBG', 'bottlearum')

        expect(spy).toHaveBeenCalledWith(
          'BackgroundJobQueueStaticJob',
          {
            globalName: 'services/LastDummyServiceInNamedWorkstream',
            args: ['bottlearum'],
            importKey: undefined,
            method: 'classRunInBG',
          },
          { delay: 7000, group: { id: 'snazzy', priority: 4 } },
        )
      })
    })
  })
})
