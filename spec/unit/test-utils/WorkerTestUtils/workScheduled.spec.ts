import { Job } from 'bullmq'
import PsychicAppWorkers, {
  PsychicWorkersAppTestInvocationType,
} from '../../../../src/psychic-app-workers/index.js'
import WorkerTestUtils from '../../../../src/test-utils/WorkerTestUtils.js'
import User from '../../../../test-app/src/app/models/User.js'
import DummyScheduledService from '../../../../test-app/src/app/services/DummyScheduledService.js'
import DummyService from '../../../../test-app/src/app/services/DummyService.js'
import LastDummyServiceInNamedWorkstream from '../../../../test-app/src/app/services/LastDummyServiceInNamedWorkstream.js'
import UrgentDummyService from '../../../../test-app/src/app/services/UrgentDummyService.js'
import parallelTestSafeQueueName from '../../../../src/background/helpers/parallelTestSafeQueueName.js'

describe('.work', () => {
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

  context('with no scheduled jobs', () => {
    it('does not call any scheduled methods, nor any other queued jobs, but also does not stall', async () => {
      const serviceSpy = vi.spyOn(DummyService, 'classRunInBG').mockImplementation(async () => {})
      const modelSpy = vi.spyOn(User, 'classRunInBG').mockImplementation(async () => {})
      const scheduledSpy = vi.spyOn(DummyScheduledService, 'classRunInBg').mockResolvedValue(undefined)

      // intentionally create queueable jobs to ensure that they do not get run
      await DummyService.background('classRunInBG', 'message 2')
      await User.background('classRunInBG', 'message 3')

      await WorkerTestUtils.workScheduled()

      expect(scheduledSpy).not.toHaveBeenCalled()
      expect(serviceSpy).not.toHaveBeenCalled()
      expect(modelSpy).not.toHaveBeenCalled()
    }, 5000)
  })

  context('with existing scheduled jobs', () => {
    it('works off all scheduled jobs', async () => {
      const bgSpy = vi.spyOn(DummyService, 'classRunInBG').mockImplementation(async () => {})
      const userSpy = vi.spyOn(User, 'classRunInBG').mockImplementation(async () => {})
      const urgentSpy = vi.spyOn(UrgentDummyService, 'classRunInBG').mockImplementation(async () => {})
      const workstreamSpy = vi
        .spyOn(LastDummyServiceInNamedWorkstream, 'classRunInBG')
        .mockImplementation(async () => {})
      const scheduledSpy = vi.spyOn(DummyScheduledService, 'classRunInBg').mockResolvedValue(undefined)

      await DummyService.background('classRunInBG', 'message 1')
      await DummyService.background('classRunInBG', 'message 2')
      await User.background('classRunInBG', 'message 3')
      await UrgentDummyService.background('classRunInBG', 'message 4')
      await LastDummyServiceInNamedWorkstream.background('classRunInBG', 'message 5')
      await DummyScheduledService.schedule('0 * * * *', 'classRunInBg', 'message 6')

      expect(bgSpy).not.toHaveBeenCalled()
      expect(userSpy).not.toHaveBeenCalled()
      expect(urgentSpy).not.toHaveBeenCalled()
      expect(workstreamSpy).not.toHaveBeenCalled()
      expect(scheduledSpy).not.toHaveBeenCalled()

      await WorkerTestUtils.workScheduled()

      expect(scheduledSpy).toHaveBeenCalledWith('message 6', expect.any(Job))

      expect(bgSpy).not.toHaveBeenCalled()
      expect(userSpy).not.toHaveBeenCalled()
      expect(urgentSpy).not.toHaveBeenCalled()
      expect(workstreamSpy).not.toHaveBeenCalled()
    })

    context('when provided a queue', () => {
      it('only works of the jobs from that queue', async () => {
        const scheduledSpy = vi.spyOn(DummyScheduledService, 'classRunInBg').mockResolvedValue(undefined)
        await DummyScheduledService.schedule('0 * * * *', 'classRunInBg', 'message 1')
        expect(scheduledSpy).not.toHaveBeenCalled()

        await WorkerTestUtils.workScheduled({ queue: parallelTestSafeQueueName('snazzy') })
        expect(scheduledSpy).not.toHaveBeenCalled()

        await WorkerTestUtils.workScheduled({ queue: parallelTestSafeQueueName('TestappBackgroundJobQueue') })
        expect(scheduledSpy).toHaveBeenCalledWith('message 1', expect.any(Job))
      })
    })

    context('when provided a for', () => {
      it('only works of the jobs from that queue', async () => {
        const scheduledSpy = vi.spyOn(DummyScheduledService, 'classRunInBg').mockResolvedValue(undefined)
        await DummyScheduledService.schedule('0 * * * *', 'classRunInBg', 'message 1')
        expect(scheduledSpy).not.toHaveBeenCalled()

        await WorkerTestUtils.workScheduled({ for: User })
        expect(scheduledSpy).not.toHaveBeenCalled()

        await WorkerTestUtils.workScheduled({ for: DummyScheduledService })
        expect(scheduledSpy).toHaveBeenCalledWith('message 1', expect.any(Job))
      })
    })
  })
})
