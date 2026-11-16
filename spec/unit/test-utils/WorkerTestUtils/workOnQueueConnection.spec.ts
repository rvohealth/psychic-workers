import { Job } from 'bullmq'
import { Redis } from 'ioredis'
import background from '../../../../src/background/index.js'
import PsychicAppWorkers, {
  PsychicBackgroundSimpleOptions,
  PsychicWorkersAppTestInvocationType,
} from '../../../../src/psychic-app-workers/index.js'
import WorkerTestUtils from '../../../../src/test-utils/WorkerTestUtils.js'
import DummyService from '../../../../test-app/src/app/services/DummyService.js'
import initializePsychicApp from '../../../../test-app/src/cli/helpers/initializePsychicApp.js'

// a database no other spec file uses, so the connections counted below are
// this file's own
const QUEUE_DB = 13

function newRedis(db: number) {
  return new Redis({
    username: process.env.REDIS_USER!,
    password: process.env.REDIS_PASSWORD!,
    host: process.env.REDIS_HOST!,
    port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379,
    db,
    enableOfflineQueue: false,
  })
}

/**
 * `WorkerTestUtils` works the `background` singleton, which connects once per
 * spec file — in the setup hook's first `beforeEach`, from whatever background
 * options the workers app holds at that moment. This file connects it first,
 * in `beforeAll`, with every queue on a Redis database other than the default
 * 0, so a test worker that does not use the queue's own connection cannot see
 * the job.
 */
describe('.work against a queue connection that is not the default Redis', () => {
  let originalTestInvocation: PsychicWorkersAppTestInvocationType
  let observer: Redis

  async function connectionsOnQueueDb() {
    const clients = (await observer.client('LIST')) as string
    return clients.split('\n').filter(line => line.includes(` db=${QUEUE_DB} `)).length
  }

  beforeAll(async () => {
    await initializePsychicApp()
    const workersApp = PsychicAppWorkers.getOrFail()
    workersApp.set('background', {
      ...(workersApp.backgroundOptions as PsychicBackgroundSimpleOptions),
      defaultQueueConnection: newRedis(QUEUE_DB),
    })
    background.connect()
    observer = newRedis(0)
    await new Promise(resolve => observer.once('ready', resolve))
  })

  afterAll(async () => {
    await observer.quit()
  })

  beforeEach(async () => {
    const workersApp = PsychicAppWorkers.getOrFail()
    originalTestInvocation = workersApp.testInvocation
    workersApp.set('testInvocation', 'manual')
    await WorkerTestUtils.clean()
  })

  afterEach(async () => {
    await WorkerTestUtils.clean()
    PsychicAppWorkers.getOrFail().set('testInvocation', originalTestInvocation)
  })

  it("works the job off the queue's own connection, and closes the connections it opened", async () => {
    const spy = vi.spyOn(DummyService, 'classRunInBG').mockImplementation(async () => {})
    await DummyService.background('classRunInBG', 'message 1')
    const connectionsBefore = await connectionsOnQueueDb()

    await WorkerTestUtils.work()

    expect(spy).toHaveBeenCalledWith('message 1', expect.any(Job))
    await vi.waitFor(async () => expect(await connectionsOnQueueDb()).toEqual(connectionsBefore))
  })
})
