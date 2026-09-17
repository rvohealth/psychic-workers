import { Redis } from 'ioredis'
import DeduplicatedJobOutpacesRateLimit from '../../../src/error/background/DeduplicatedJobOutpacesRateLimit.js'
import { Background, PsychicAppWorkers } from '../../../src/package-exports/index.js'
import PsychicAppWorkersClass, {
  PsychicWorkersAppTestInvocationType,
} from '../../../src/psychic-app-workers/index.js'
import { PsychicBackgroundOptions } from '../../../src/types/background.js'
import { fakeRedisConnection, installBullMQRecorders } from '../../helpers/bullmqRecorders.js'

/**
 * A `jobId` behind a delay that is legal on its own can still be wrong for the
 * queue it lands on. The deduplication key's lifetime — the delay minus the
 * one-second margin — is the fastest one `jobId` can produce jobs, since calls
 * closer together than that are collapsed and calls further apart than that
 * stop collapsing and produce one job each. The queue's limiter starts at most
 * `max` jobs per `duration`. When the first outruns the second, a sustained
 * stream of calls grows a backlog that nothing surfaces: the limiter keeps the
 * downstream service safe while the jobs pile up in Redis.
 *
 * What makes the check possible at enqueue, in a process that may never run a
 * worker, is that `connect()` records every queue's worker options whether or
 * not it activates workers. These specs deliberately call `connect()` without
 * `activateWorkers`, so they fail if that ever stops being true.
 */
describe('a deduplicated job that outpaces its queue’s rate limit', () => {
  const bullmq = installBullMQRecorders()

  let queueConnection: Redis
  let workerConnection: Redis
  let originalBackgroundOptions: PsychicBackgroundOptions
  let originalTestInvocation: PsychicWorkersAppTestInvocationType

  function connectWith(backgroundOptions: Partial<PsychicBackgroundOptions>) {
    PsychicAppWorkers.getOrFail().set('background', {
      defaultQueueConnection: queueConnection,
      defaultWorkerConnection: workerConnection,
      ...backgroundOptions,
    })

    const backgroundInstance = new Background()
    // no `activateWorkers`: the limiter must be knowable to a producer process
    backgroundInstance.connect()
    return backgroundInstance
  }

  function enqueue(
    backgroundInstance: Background,
    opts: { delaySeconds: number; jobId?: string | undefined; workstream?: string },
  ) {
    return backgroundInstance.staticMethod({ name: 'DummyService' }, 'classRunInBG', {
      globalName: 'DummyService',
      delaySeconds: opts.delaySeconds,
      jobId: opts.jobId,
      jobConfig: opts.workstream ? { workstream: opts.workstream } : {},
    })
  }

  beforeEach(() => {
    const workersApp = PsychicAppWorkersClass.getOrFail()
    originalBackgroundOptions = workersApp.backgroundOptions
    originalTestInvocation = workersApp.testInvocation
    workersApp.set('testInvocation', 'manual')

    queueConnection = fakeRedisConnection('queue')
    workerConnection = fakeRedisConnection('worker')
  })

  afterEach(() => {
    const workersApp = PsychicAppWorkersClass.getOrFail()
    workersApp.set('background', originalBackgroundOptions)
    workersApp.set('testInvocation', originalTestInvocation)
    vi.restoreAllMocks()
  })

  context('when the key lifetime is shorter than the limiter’s spacing', () => {
    it('throws, enqueuing nothing', async () => {
      const backgroundInstance = connectWith({
        namedWorkstreams: [{ name: 'shipping', rateLimit: { max: 1, duration: 60000 } }],
      })

      // 3s delay => a 2s key, against one job every 60s
      await expect(
        enqueue(backgroundInstance, { delaySeconds: 3, jobId: 'sync-42', workstream: 'shipping' }),
      ).rejects.toThrow(DeduplicatedJobOutpacesRateLimit)

      expect(bullmq.queues.flatMap(queue => queue.adds)).toEqual([])
    })

    it('names the workstream, both limiter numbers, and a delay that would pass', async () => {
      const backgroundInstance = connectWith({
        namedWorkstreams: [{ name: 'shipping', rateLimit: { max: 1, duration: 60000 } }],
      })

      await expect(
        enqueue(backgroundInstance, { delaySeconds: 3, jobId: 'sync-42', workstream: 'shipping' }),
      ).rejects.toThrow(/`shipping` workstream/)

      await expect(
        enqueue(backgroundInstance, { delaySeconds: 3, jobId: 'sync-42', workstream: 'shipping' }),
      ).rejects.toThrow(/1 job every 60000ms/)

      // the key lives 2s, and the fix is the spacing plus the margin, rounded up
      await expect(
        enqueue(backgroundInstance, { delaySeconds: 3, jobId: 'sync-42', workstream: 'shipping' }),
      ).rejects.toThrow(/give the delay at least 61 seconds/)
    })

    /**
     * The guard sits above the test-mode short circuit, so a consumer running
     * the default `testInvocation` meets it exactly as production does. Written
     * without an override on purpose: this is what goes red if the check ever
     * moves down beside the deduplication block.
     */
    it('throws under the default automatic test invocation too', async () => {
      PsychicAppWorkersClass.getOrFail().set('testInvocation', 'automatic')

      const backgroundInstance = connectWith({
        namedWorkstreams: [{ name: 'shipping', rateLimit: { max: 1, duration: 60000 } }],
      })

      await expect(
        enqueue(backgroundInstance, { delaySeconds: 3, jobId: 'sync-42', workstream: 'shipping' }),
      ).rejects.toThrow(DeduplicatedJobOutpacesRateLimit)
    })
  })

  context('when the key lifetime covers the limiter’s spacing', () => {
    it('enqueues a delay wide enough for the limit', async () => {
      const backgroundInstance = connectWith({
        namedWorkstreams: [{ name: 'shipping', rateLimit: { max: 1, duration: 60000 } }],
      })

      await enqueue(backgroundInstance, { delaySeconds: 61, jobId: 'sync-42', workstream: 'shipping' })

      expect(bullmq.queues.flatMap(queue => queue.adds)).toHaveLength(1)
    })

    /**
     * The boundary is inclusive — the guard is `keyLifetime < spacing` — and
     * this is the only thing pinning that. A 61s delay leaves a 60s key against
     * a 60s spacing.
     */
    it('accepts a key lifetime exactly equal to the spacing', async () => {
      const backgroundInstance = connectWith({
        namedWorkstreams: [{ name: 'shipping', rateLimit: { max: 1, duration: 60000 } }],
      })

      await enqueue(backgroundInstance, { delaySeconds: 61, jobId: 'sync-42', workstream: 'shipping' })
      expect(bullmq.queues.flatMap(queue => queue.adds)).toHaveLength(1)

      await expect(
        enqueue(backgroundInstance, { delaySeconds: 60.999, jobId: 'sync-42', workstream: 'shipping' }),
      ).rejects.toThrow(DeduplicatedJobOutpacesRateLimit)
    })

    /**
     * The spacing is `duration / max`, not `duration`: a limiter that permits
     * many jobs per window is fast, however wide the window is. Reading
     * `duration` alone would refuse this.
     */
    it('divides the window by max rather than reading the window alone', async () => {
      const backgroundInstance = connectWith({
        // 100 jobs per minute is one job every 600ms
        namedWorkstreams: [{ name: 'bulk', rateLimit: { max: 100, duration: 60000 } }],
      })

      await enqueue(backgroundInstance, { delaySeconds: 3, jobId: 'sync-42', workstream: 'bulk' })

      expect(bullmq.queues.flatMap(queue => queue.adds)).toHaveLength(1)
    })
  })

  context('when there is nothing to compare against', () => {
    it('leaves a workstream with no rate limit alone', async () => {
      const backgroundInstance = connectWith({
        namedWorkstreams: [{ name: 'plain' }],
      })

      await enqueue(backgroundInstance, { delaySeconds: 3, jobId: 'sync-42', workstream: 'plain' })

      expect(bullmq.queues.flatMap(queue => queue.adds)).toHaveLength(1)
    })

    /**
     * The floor is a constraint on debouncing, and so is this: a delay with no
     * `jobId` deduplicates nothing, so there is no production rate to outrun
     * the limiter with.
     */
    it('leaves a short delay carrying no jobId alone', async () => {
      const backgroundInstance = connectWith({
        namedWorkstreams: [{ name: 'shipping', rateLimit: { max: 1, duration: 60000 } }],
      })

      await enqueue(backgroundInstance, { delaySeconds: 3, workstream: 'shipping' })

      expect(bullmq.queues.flatMap(queue => queue.adds)).toHaveLength(1)
    })

    /**
     * `connect()` validates `max` and `duration` for `namedWorkstreams` only,
     * so a global limiter reaches the guard unvalidated. A spacing derived from
     * a zero `max` is `Infinity`, which would refuse every debounced job on the
     * queue; saying nothing is the better failure.
     */
    it('says nothing about an unusable global limiter', async () => {
      const backgroundInstance = connectWith({
        defaultBullMQWorkerOptions: { limiter: { max: 0, duration: 60000 } },
        namedWorkstreams: [{ name: 'plain' }],
      })

      await enqueue(backgroundInstance, { delaySeconds: 3, jobId: 'sync-42', workstream: 'plain' })

      expect(bullmq.queues.flatMap(queue => queue.adds)).toHaveLength(1)
    })

    /**
     * A global limiter that *is* usable still applies: a workstream without its
     * own `rateLimit` inherits it through `defaultBullMQWorkerOptions`, and the
     * guard reads the effective worker options rather than the workstream's
     * `rateLimit` field, so one read covers both.
     */
    it('applies a usable global limiter to a workstream that sets none', async () => {
      const backgroundInstance = connectWith({
        defaultBullMQWorkerOptions: { limiter: { max: 1, duration: 60000 } },
        namedWorkstreams: [{ name: 'plain' }],
      })

      await expect(
        enqueue(backgroundInstance, { delaySeconds: 3, jobId: 'sync-42', workstream: 'plain' }),
      ).rejects.toThrow(DeduplicatedJobOutpacesRateLimit)
    })
  })
})
