import { Job } from 'bullmq'
import { background, BackgroundQueuePriority } from '../../../src/index.js'
import DummyService from '../../../test-app/src/app/services/DummyService.js'
import readTmpFile from '../../helpers/readTmpFile.js'
import PsychicAppWorkers, {
  PsychicWorkersAppTestInvocationType,
} from '../../../src/psychic-app-workers/index.js'
import WorkerTestUtils from '../../../src/test-utils/WorkerTestUtils.js'

describe('background (app singleton)', () => {
  describe('.staticMethod', () => {
    it('calls the static method, passing args', async () => {
      await background.staticMethod(DummyService, 'classRunInBG', {
        globalName: 'services/DummyService',
        args: ['bottlearum'],
      })
      expect(await readTmpFile()).toEqual('bottlearum')
    })

    it('passes the Job as the last argument', async () => {
      await background.staticMethod(DummyService, 'classRunInBGWithJobArg', {
        globalName: 'services/DummyService',
        args: ['bottlearum'],
      })
      expect(await readTmpFile()).toEqual('bottlearum,BackgroundJobQueueStaticJob')
    })

    context('priority', () => {
      const subject = async () => {
        await background.staticMethod(DummyService, 'classRunInBG', {
          globalName: 'DummyService',
          args: ['bottlearum'],
          jobConfig: { priority },
        })
      }
      let priority: BackgroundQueuePriority

      function expectAddedToQueueWithPriority(priority: BackgroundQueuePriority, priorityLevel: number) {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        expect(background.queues[0]!.add).toHaveBeenCalledWith(
          'BackgroundJobQueueStaticJob',
          {
            globalName: 'DummyService',
            args: ['bottlearum'],
            importKey: undefined,
            method: 'classRunInBG',
          },
          { priority: priorityLevel },
        )
      }

      let originalTestInvocation: PsychicWorkersAppTestInvocationType
      let originalWorkerCount: string | undefined

      beforeEach(async () => {
        const workersApp = PsychicAppWorkers.getOrFail()
        originalTestInvocation = workersApp.testInvocation
        workersApp.set('testInvocation', 'manual')

        originalWorkerCount = process.env.WORKER_COUNT
        process.env.WORKER_COUNT = '1'

        background.connect()
        vi.spyOn(background.queues[0]!, 'add').mockResolvedValue({} as Job)

        await WorkerTestUtils.clean()
      })

      afterEach(() => {
        const workersApp = PsychicAppWorkers.getOrFail()
        workersApp.set('testInvocation', originalTestInvocation)

        process.env.WORKER_COUNT = originalWorkerCount
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
      const subject = async () => {
        await background.staticMethod(DummyService, 'classRunInBG', {
          globalName: 'DummyService',
          args: ['bottlearum'],
          delaySeconds,
        })
      }
      let delaySeconds: number

      function expectAddedToQueueWithPriority(priority: BackgroundQueuePriority, delay: number) {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        expect(background.queues[0]!.add).toHaveBeenCalledWith(
          'BackgroundJobQueueStaticJob',
          {
            globalName: 'DummyService',
            args: ['bottlearum'],
            importKey: undefined,
            method: 'classRunInBG',
          },
          { delay, priority: 2 },
        )
      }

      let originalTestInvocation: PsychicWorkersAppTestInvocationType
      let originalWorkerCount: string | undefined

      beforeEach(async () => {
        const workersApp = PsychicAppWorkers.getOrFail()
        originalTestInvocation = workersApp.testInvocation
        workersApp.set('testInvocation', 'manual')

        originalWorkerCount = process.env.WORKER_COUNT
        process.env.WORKER_COUNT = '1'

        background.connect()
        vi.spyOn(background.queues[0]!, 'add').mockResolvedValue({} as Job)

        await WorkerTestUtils.clean()
      })

      afterEach(() => {
        const workersApp = PsychicAppWorkers.getOrFail()
        workersApp.set('testInvocation', originalTestInvocation)

        process.env.WORKER_COUNT = originalWorkerCount
      })

      it('sets the delay in milliseconds', async () => {
        delaySeconds = 25
        await subject()
        expectAddedToQueueWithPriority('default', 25000)
      })
    })
  })
})
