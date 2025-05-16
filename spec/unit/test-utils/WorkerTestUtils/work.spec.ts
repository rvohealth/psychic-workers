import { Job } from 'bullmq'
import PsychicAppWorkers, {
  PsychicWorkersAppTestInvocationType,
} from '../../../../src/psychic-app-workers/index.js'
import WorkerTestUtils from '../../../../src/test-utils/WorkerTestUtils.js'
import User from '../../../../test-app/src/app/models/User.js'
import DummyService from '../../../../test-app/src/app/services/DummyService.js'
import LastDummyServiceInNamedWorkstream from '../../../../test-app/src/app/services/LastDummyServiceInNamedWorkstream.js'
import UrgentDummyService from '../../../../test-app/src/app/services/UrgentDummyService.js'

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

  context('with no jobs', () => {
    it('does nothing, but does not stall', async () => {
      const serviceSpy = vi.spyOn(DummyService, 'classRunInBG').mockImplementation(async () => {})
      const modelSpy = vi.spyOn(User, 'classRunInBG').mockImplementation(async () => {})

      await WorkerTestUtils.work()

      expect(serviceSpy).not.toHaveBeenCalled()
      expect(modelSpy).not.toHaveBeenCalled()
    }, 5000)
  })

  context('with existing jobs', () => {
    it('works off all jobs in all queues', async () => {
      const bgSpy = vi.spyOn(DummyService, 'classRunInBG').mockImplementation(async () => {})
      const userSpy = vi.spyOn(User, 'classRunInBG').mockImplementation(async () => {})
      const urgentSpy = vi.spyOn(UrgentDummyService, 'classRunInBG').mockImplementation(async () => {})
      const workstreamSpy = vi
        .spyOn(LastDummyServiceInNamedWorkstream, 'classRunInBG')
        .mockImplementation(async () => {})

      await DummyService.background('classRunInBG', 'message 1')
      await DummyService.background('classRunInBG', 'message 2')
      await User.background('classRunInBG', 'message 3')
      await UrgentDummyService.background('classRunInBG', 'message 4')
      await LastDummyServiceInNamedWorkstream.background('classRunInBG', 'message 5')

      expect(bgSpy).not.toHaveBeenCalled()
      expect(userSpy).not.toHaveBeenCalled()
      expect(urgentSpy).not.toHaveBeenCalled()
      expect(workstreamSpy).not.toHaveBeenCalled()

      await WorkerTestUtils.work()
      expect(bgSpy).toHaveBeenCalledWith('message 1', expect.any(Job))
      expect(bgSpy).toHaveBeenCalledWith('message 2', expect.any(Job))
      expect(userSpy).toHaveBeenCalledWith('message 3', expect.any(Job))
      expect(urgentSpy).toHaveBeenCalledWith('message 4', expect.any(Job))
      expect(workstreamSpy).toHaveBeenCalledWith('message 5', expect.any(Job))
    })
  })

  context('when provided a queue', () => {
    it('only works of the jobs from that queue', async () => {
      const bgSpy = vi.spyOn(DummyService, 'classRunInBG').mockImplementation(async () => {})
      await DummyService.background('classRunInBG', 'message 1')
      expect(bgSpy).not.toHaveBeenCalled()

      await WorkerTestUtils.work({ queue: 'snazzy' })
      expect(bgSpy).not.toHaveBeenCalled()

      await WorkerTestUtils.work({ queue: 'TestappBackgroundJobQueue' })
      expect(bgSpy).toHaveBeenCalledWith('message 1', expect.any(Job))
    })
  })
})
