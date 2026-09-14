/**
 * Throw from inside a backgrounded (or scheduled) method to signal that the
 * outside service it talks to rate-limited the request (an HTTP 429, say) and
 * asked it to stop sending for a while. `pauseQueueForSeconds` is how long that
 * while is, in whole seconds. Importable from `@rvoh/psychic-workers/errors`.
 *
 * ```ts
 * // conf/workers.ts — one named workstream per rate-limited service
 * namedWorkstreams: [{ name: 'slack', rateLimit: { max: 1, duration: 1000 } }]
 *
 * // app/services/SlackNotifier.ts
 * import { RateLimitedPsychicJob } from '@rvoh/psychic-workers/errors'
 *
 * export default class SlackNotifier extends ApplicationBackgroundedService {
 *   public static override get backgroundJobConfig() {
 *     return { workstream: 'slack' }
 *   }
 *
 *   public static async post(channel: string, text: string) {
 *     const response = await fetch('https://slack.com/api/chat.postMessage', { ... })
 *
 *     if (response.status === 429) {
 *       // Slack's Retry-After header is in seconds, and so is this field
 *       const seconds = Number(response.headers.get('retry-after') ?? 1)
 *       throw new RateLimitedPsychicJob({ pauseQueueForSeconds: seconds })
 *     }
 *   }
 * }
 * ```
 *
 * When the worker running the job carries a BullMQ `limiter` — a named
 * workstream with `rateLimit`, a native `namedQueueWorkers` entry with
 * `limiter`, `nativeBullMQ.defaultWorkerOptions.limiter`, or a global
 * `defaultBullMQWorkerOptions.limiter` — psychic-workers translates the signal
 * into BullMQ's own rate-limit mechanism: the pause is logged at `warn`
 * (`[psychic-workers] pausing queue <name> for <pauseQueueForSeconds>s: a job
 * threw RateLimitedPsychicJob`), the queue is paused for that many seconds, and the job
 * goes back onto the queue (state `waiting` for a workstream job,
 * `prioritized` for a default-queue job) with `attemptsMade` unchanged and no
 * backoff, so the burst is not multiplied by the retry schedule. The check
 * reads only the worker options: a queue rate-limited solely through BullMQ's
 * `queue.setGlobalRateLimit` is treated as misconfigured (below) even though
 * its workers would honor the pause. Every worker on the queue that carries a
 * `limiter` honors the pause; a limiter-less worker in another process on the
 * same queue — during a rolling deploy that has not yet picked up `rateLimit`,
 * say — instead re-fetches the job, runs it once more, and fails it with the
 * misconfiguration error described below.
 *
 * The pause replaces the queue's current limiter window and counter — the
 * configured `rateLimit` window and any earlier pause alike — so once
 * `pauseQueueForSeconds` elapses up to `max` jobs may start at once, and a
 * `pauseQueueForSeconds` shorter than the window's remaining time shortens the
 * configured limit. The value is applied as given, rounded up to a whole second,
 * with no upper bound; concurrent throws overwrite each other (last writer wins,
 * not longest).
 *
 * Once the pause ends, the re-queued job is fetched first, ahead of every other
 * job on the queue, so a request that never clears pauses the queue again on
 * every cycle. `attemptsMade` never grows, but each re-fetch counts in BullMQ's
 * `attemptsStarted`, and the worker option `maxStartedAttempts`
 * (`defaultBullMQWorkerOptions: { maxStartedAttempts: 10 }`, say) is the only
 * bound: without it the cycle is unbounded. Set it on any workstream whose jobs
 * throw this signal.
 *
 * Thrown from a job whose worker carries no `limiter`, the signal is a
 * misconfiguration: the job fails with an ordinary error (retried on the
 * queue's `attempts`/backoff schedule) of a class this package does not
 * export, whose message names the fix. psychic-workers registers no `failed`
 * listener, so the failure is observable through the app's own failed-job
 * monitoring. The same check runs under test invocation and
 * `WorkerTestUtils`, so a misplaced job goes red in specs; on a queue whose
 * workers would carry a `limiter`, the error propagates untranslated there so
 * a spec can assert on it, and `WorkerTestUtils.work()` stops at the first one
 * (rejecting with it, the job back in the queue) rather than looping.
 *
 * `pauseQueueForSeconds` must be a positive, finite number of safe magnitude;
 * the constructor throws a `RangeError` otherwise, at the throw site, before
 * anything reaches Redis. A fractional number of seconds is legal and is
 * rounded **up** — the field is a lower bound on the pause, so overshooting it
 * by under a second cannot break the promise, while rounding down could.
 */
export default class RateLimitedPsychicJob extends Error {
  public readonly pauseQueueForSeconds: number

  constructor({ pauseQueueForSeconds }: { pauseQueueForSeconds: number }) {
    super()

    // `Number.isFinite` does not coerce, so a non-numeric value fails it too
    if (
      !(
        Number.isFinite(pauseQueueForSeconds) &&
        pauseQueueForSeconds > 0 &&
        pauseQueueForSeconds <= Number.MAX_SAFE_INTEGER
      )
    ) {
      throw new RangeError(
        `RateLimitedPsychicJob requires pauseQueueForSeconds to be a positive, finite number of safe magnitude (the number of seconds to pause the queue for); received ${String(pauseQueueForSeconds)}`,
      )
    }

    this.pauseQueueForSeconds = pauseQueueForSeconds
  }

  public override get message() {
    return `job was rate limited; pause the queue for ${this.pauseQueueForSeconds} seconds`
  }
}
