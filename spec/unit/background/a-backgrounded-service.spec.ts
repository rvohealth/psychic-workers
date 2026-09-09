import { Job } from 'bullmq'
import { MockInstance } from 'vitest'
import background from '../../../src/background/index.js'
import AttemtedToBackgroundEntireDreamModel from '../../../src/error/background/AttemtedToBackgroundEntireDreamModel.js'
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

      it('adds the job to the queue corresponding to the workstream name with the workstream name as the group ID, and moves the priority into the group object', async () => {
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
          { group: { id: 'snazzy', priority: 4 } },
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
        await serviceClass.backgroundWithDelay({ seconds: 7, jobId: 'myjob' }, 'classRunInBG', 'bottlearum')
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
              ttl: 7000,
            },
            delay: 7000,
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

      it('adds the job to the queue corresponding to the workstream name with the workstream name as the group ID, and moves the priority into the group object', async () => {
        const spy = vi.spyOn(background.queues[1]!, 'add').mockResolvedValue({} as Job)
        await LastDummyServiceInNamedWorkstream.backgroundWithDelay(
          { seconds: 7, jobId: 'myjob' },
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
              ttl: 7000,
            },
            delay: 7000,
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
            { delay: { seconds: 7, jobId: 'myjob' } },
            'classRunInBG',
            'bottlearum',
          )
          expectAddedToQueue(LastDummyService, {
            deduplication: {
              extend: true,
              id: 'myjob',
              replace: true,
              ttl: 7000,
            },
            delay: 7000,
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
              ttl: 60000,
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

      it('preserves the workstream and moves the overridden priority into the group object', async () => {
        const spy = vi.spyOn(background.queues[1]!, 'add').mockResolvedValue({} as Job)
        await LastDummyServiceInNamedWorkstream.backgroundWith(
          { delay: { seconds: 7, jobId: 'myjob' }, priority: 'urgent' },
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
              ttl: 7000,
            },
            delay: 7000,
            group: { id: 'snazzy', priority: 1 },
          },
        )
      })
    })
  })
})
