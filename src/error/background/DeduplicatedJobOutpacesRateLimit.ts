import { WorkerQueueDescription } from './RateLimitedPsychicJobThrownFromWorkerWithoutLimiter.js'

/**
 * Not exported from the package: a delayed background job carried a `jobId`
 * (a deduplication key) behind a delay short enough that the job can enqueue
 * work faster than its own queue's rate limit allows that work to start.
 *
 * The comparison is against the deduplication key's lifetime rather than the
 * delay, because the key's lifetime is the fastest this `jobId` can produce
 * jobs. Calls arriving closer together than the key's lifetime are collapsed
 * and produce nothing until they stop; calls arriving just *past* it stop
 * collapsing and produce one job each. So one job per key lifetime — the delay
 * minus `DEDUPLICATION_KEY_MARGIN_MS` — is the ceiling, and it is reached by an
 * ordinary caller whose cadence happens to sit there, not by a pathological
 * one.
 *
 * Against that, the queue's limiter starts `max` jobs per `duration`
 * milliseconds, so `duration / max` is the fastest it can start them. When the
 * key's lifetime is shorter than that, a sustained stream of calls enqueues
 * faster than the queue drains, and the backlog grows without bound. The
 * limiter keeps the downstream service safe while it happens, so nothing fails
 * — the jobs simply accumulate in Redis, which is the silent failure this
 * refusal exists to convert into a loud one.
 *
 * A burst that stops is fine at any delay, and this check refuses it anyway,
 * because the difference between the two is the call pattern and that is not
 * knowable at enqueue. The refusal is nonetheless the right way round: a job
 * whose burstiness is genuinely guaranteed does not need the rate limit at all
 * (the debounce alone already collapses the burst into one call on the
 * service), and one whose burstiness is not guaranteed is the broken case.
 *
 * That leaves a job which sits on a rate-limited workstream because of the
 * service it talks to rather than because of its own cadence. It has two fixes
 * rather than one, and the message offers both: widen the delay, which costs
 * only latency the limiter would often have imposed anyway, or give the job its
 * own named workstream. The second is not a workaround — a workstream carries
 * one rate limit, so a service metering its endpoints separately wants one per
 * limit regardless, and several backgrounded classes pointed at the same
 * service is the ordinary way to express that.
 *
 * Checked in `_addToQueue` beside {@link DeduplicatedJobRequiresMinimumDelay},
 * above the test-mode short circuit, so a consumer's default test environment
 * raises this exactly as production does. Skipped when `connect()` recorded no
 * limiter for the queue, and when the limiter's `max` and `duration` are not
 * both usable positive numbers: only `namedWorkstreams` rate limits are
 * validated by `connect()`, so a `defaultBullMQWorkerOptions.limiter` or a
 * native `namedQueueWorkers` limiter can reach here as anything at all, and
 * guessing at a cadence from it would be worse than saying nothing.
 */
export default class DeduplicatedJobOutpacesRateLimit extends Error {
  constructor(
    private jobId: string,
    private delayMs: number,
    private keyLifetimeMs: number,
    private limiter: { max: number; duration: number },
    private queue: WorkerQueueDescription,
  ) {
    super()
  }

  public override get message() {
    return `
A delayed background job was given the \`jobId\` ${JSON.stringify(this.jobId)} behind a delay of ${this.seconds(this.delayMs)}, but ${this.where}
is rate limited to ${this.limiter.max} job${this.limiter.max === 1 ? '' : 's'} every ${this.limiter.duration}ms — one job every ${this.seconds(this.msPerJob)}.

\`jobId\` is a deduplication key, and the key that does the collapsing lives ${this.seconds(this.keyLifetimeMs)} (the delay minus a
one-second margin). Calls closer together than that are collapsed; calls further apart than that stop collapsing
and produce a job each. This \`jobId\` can therefore enqueue a job every ${this.seconds(this.keyLifetimeMs)}, which is faster than
this ${this.kind} can start them. Under a sustained stream of calls the backlog grows without bound — the rate
limit keeps the downstream service safe while it happens, so nothing fails and the jobs simply pile up in Redis.

Either give the delay at least ${this.seconds(this.minimumDelayMs)}, so that calls which stop collapsing still cannot outrun the rate
limit, or move the job to a ${this.kind} of its own — one with no rate limit, or one whose limit fits this job's
endpoint. A burst that stops arriving is collapsed into one run at any delay, but which pattern a caller has is
not knowable here. Nothing was enqueued.
`
  }

  private get msPerJob() {
    return this.limiter.duration / this.limiter.max
  }

  /**
   * the shortest delay that would pass: enough that the key outlives the
   * limiter's spacing. Rounded up to a whole second, since the delay is given
   * in whole-ish duration fields and a value that still failed by a fraction
   * of a second would be a hostile suggestion.
   */
  private get minimumDelayMs() {
    return Math.ceil((this.msPerJob + (this.delayMs - this.keyLifetimeMs)) / 1000) * 1000
  }

  private seconds(ms: number) {
    const secs = ms / 1000
    const rendered = Number.isInteger(secs) ? String(secs) : secs.toFixed(2).replace(/0+$/, '')
    return `${rendered} second${rendered === '1' ? '' : 's'}`
  }

  private get kind() {
    return this.queue.mode === 'simple' ? 'workstream' : 'queue'
  }

  private get where() {
    if (this.queue.isDefaultQueue) return `the default ${this.kind}`
    return `the \`${this.queue.configuredName}\` ${this.queue.transitional ? 'transitional ' : ''}${this.kind}`
  }
}
