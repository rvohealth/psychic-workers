import { WorkerQueueDescription } from '../../types/background.js'

/**
 * Not exported from the package: a delayed background job carried a `jobId`
 * behind a delay short enough that it can enqueue work faster than its own
 * queue's rate limit allows that work to start. Thrown from `_addToQueue`,
 * above the test-mode short circuit, so a consumer's test environment raises it
 * exactly as production does.
 */
export default class DebouncedJobOutpacesRateLimit extends Error {
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
    const rendered = Number.isInteger(secs) ? String(secs) : secs.toFixed(2).replace(/\.?0+$/, '')
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
