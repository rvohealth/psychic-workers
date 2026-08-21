import background from '../../../../src/background/index.js'
import PsychicAppWorkers, {
  PsychicWorkersAppTestInvocationType,
} from '../../../../src/psychic-app-workers/index.js'
import WorkerTestUtils from '../../../../src/test-utils/WorkerTestUtils.js'
import DummyService from '../../../../test-app/src/app/services/DummyService.js'

async function allDelayedJobs() {
  background.connect()
  const delayedJobs = await Promise.all(background.queues.map(queue => queue.getDelayed()))
  return delayedJobs.flat()
}

describe('.clean', () => {
  let originalTestInvocation: PsychicWorkersAppTestInvocationType

  beforeEach(async () => {
    const workersApp = PsychicAppWorkers.getOrFail()
    originalTestInvocation = workersApp.testInvocation
    workersApp.set('testInvocation', 'manual')
    await WorkerTestUtils.clean()
  })

  afterEach(async () => {
    await WorkerTestUtils.clean()
    const workersApp = PsychicAppWorkers.getOrFail()
    workersApp.set('testInvocation', originalTestInvocation)
  })

  context('with existing delayed jobs', () => {
    it('clears the delayed jobs', async () => {
      vi.spyOn(DummyService, 'classRunInBG').mockImplementation(async () => {})

      await DummyService.backgroundWithDelay({ hours: 24 }, 'classRunInBG', 'delayed message')

      expect(await allDelayedJobs()).not.toHaveLength(0)

      await WorkerTestUtils.clean()

      expect(await allDelayedJobs()).toHaveLength(0)
    })
  })
})
