import background from '../../../src/background/index.js'
import PsychicAppWorkers, {
  PsychicWorkersAppTestInvocationType,
} from '../../../src/psychic-app-workers/index.js'
import WorkerTestUtils from '../../../src/test-utils/WorkerTestUtils.js'
import DummyService from '../../../test-app/src/app/services/DummyService.js'

const JOB_ID = 'debounce-key-margin-spec'
const DELAY_SECONDS = 10
const DELAY_MS = DELAY_SECONDS * 1000
const MARGIN_MS = 1000

/**
 * The one real-Redis check on what the shorter deduplication key actually buys.
 * The recorder-based specs pin the option object this package builds; only
 * Redis can say what BullMQ then does with it.
 *
 * Two things are verified here, and they are the two halves of the default:
 *
 * 1. while the key is live, a repeat call **replaces** the pending job and
 *    slides its fire time — one delayed job, a new job id, a later score;
 * 2. once the key is gone but the job has not yet fired, a call creates a
 *    **second** delayed job instead of being swallowed. That second half is
 *    the defect the shorter `ttl` exists to close: with `ttl` pinned equal to
 *    the delay, the key could instead outlive the job and drop that call on
 *    the floor.
 *
 * The key's disappearance is induced with `queue.removeDeduplicationKey`
 * rather than waited out. Sleeping would prove nothing here: nothing in this
 * harness promotes delayed jobs (`promoteDelayedJobs` runs inside
 * `moveToActive`, and no worker is started), so a sleep that woke in the
 * landing zone would pass for the wrong reason — the job it found unfired
 * would be unfired because no one was promoting, not because the margin held.
 * It would also be a multi-second sleep racing a 1000 ms window, which is a
 * flake waiting to happen whatever the delay.  `removeDeduplicationKey` puts
 * Redis in exactly the state an expiry leaves it in: the key is simply not
 * there.
 *
 * Needs Redis; runs with `testInvocation: 'manual'` so jobs are really
 * enqueued. No worker is ever started, so nothing is promoted or executed.
 */
describe('the debounce key margin, against a real Redis', () => {
  let originalTestInvocation: PsychicWorkersAppTestInvocationType

  function defaultQueue() {
    return background.queues[0]!
  }

  beforeEach(async () => {
    const workersApp = PsychicAppWorkers.getOrFail()
    originalTestInvocation = workersApp.testInvocation
    workersApp.set('testInvocation', 'manual')

    background.connect()
    await WorkerTestUtils.clean()
  })

  afterEach(async () => {
    // `WorkerTestUtils.clean()` only clears a deduplication key while it still
    // points at a job it is removing (`removeDeduplicationKeyIfNeededOnRemoval`
    // tests `currentJobId == jobId`), so a replaced or promoted key survives it
    // and would silently swallow the next spec's enqueue of the same `jobId`.
    // Same reason `rateLimitedPsychicJobWorker.spec.ts` removes the limiter key
    // by hand.
    for (const queue of background.queues) await queue.removeDeduplicationKey(JOB_ID)

    await WorkerTestUtils.clean()
    PsychicAppWorkers.getOrFail().set('testInvocation', originalTestInvocation)
  })

  it('expires a margin before the job fires, so a late call enqueues rather than being swallowed', async () => {
    const queue = defaultQueue()
    const client = await queue.client
    const deduplicationKey = `${queue.toKey('de')}:${JOB_ID}`
    const delayedKey = queue.toKey('delayed')

    //////////////////////////////////////////////////////////
    // the first call arms the key for delay minus the margin //
    //////////////////////////////////////////////////////////
    await DummyService.backgroundWithDelay(
      { seconds: DELAY_SECONDS, jobId: JOB_ID },
      'classRunInBG',
      'bottlearum',
    )

    expect(await queue.getDelayedCount()).toEqual(1)
    const firstJob = (await queue.getDelayed())[0]!
    expect(await queue.getDeduplicationJobId(JOB_ID)).toEqual(firstJob.id)

    // the margin, measured against Redis rather than against the recorder: the
    // key must die strictly before the job is due
    const keyTtl = await client.pttl(deduplicationKey)
    expect(keyTtl).toBeGreaterThan(DELAY_MS - MARGIN_MS - 1000)
    expect(keyTtl).toBeLessThanOrEqual(DELAY_MS - MARGIN_MS)

    const firstScore = Number(await client.zscore(delayedKey, firstJob.id!))

    ///////////////////////////////////////////////////////////
    // a call while the key is live replaces and slides the job //
    ///////////////////////////////////////////////////////////
    await DummyService.backgroundWithDelay(
      { seconds: DELAY_SECONDS, jobId: JOB_ID },
      'classRunInBG',
      'bottlearum',
    )

    expect(await queue.getDelayedCount()).toEqual(1)
    const secondJob = (await queue.getDelayed())[0]!
    expect(secondJob.id).not.toEqual(firstJob.id)
    expect(await queue.getDeduplicationJobId(JOB_ID)).toEqual(secondJob.id)
    // greater-than-or-equal, not greater-than: the score is built from the
    // producer's `Date.now()`, which has 1ms resolution, so two enqueues a few
    // loopback round trips apart can land in the same millisecond and score
    // identically. `secondJob.id !== firstJob.id` just above is what carries
    // the point of this act — the job really was replaced — and the score only
    // has to show the timer did not move backwards.
    expect(Number(await client.zscore(delayedKey, secondJob.id!))).toBeGreaterThanOrEqual(firstScore)

    ////////////////////////////////////////////////////////////////////
    // once the key is gone, the still-pending job no longer swallows it //
    ////////////////////////////////////////////////////////////////////
    await queue.removeDeduplicationKey(JOB_ID)
    expect(await queue.getDeduplicationJobId(JOB_ID)).toBeNull()

    await DummyService.backgroundWithDelay(
      { seconds: DELAY_SECONDS, jobId: JOB_ID },
      'classRunInBG',
      'bottlearum',
    )

    expect(await queue.getDelayedCount()).toEqual(2)
    const delayedJobs = await queue.getDelayed()
    const delayedIds = delayedJobs.map(job => job.id)
    expect(new Set(delayedIds).size).toEqual(2)
    expect(delayedIds).toContain(secondJob.id)

    const thirdJob = delayedJobs.find(job => job.id !== secondJob.id)!
    expect(await queue.getDeduplicationJobId(JOB_ID)).toEqual(thirdJob.id)
  })
})
