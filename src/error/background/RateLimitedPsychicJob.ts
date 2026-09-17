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
 * The worker running the job must carry a BullMQ `limiter` — a named
 * workstream with `rateLimit`, a native `namedQueueWorkers` entry with
 * `limiter`, `nativeBullMQ.defaultWorkerOptions.limiter`, or a global
 * `defaultBullMQWorkerOptions.limiter`. Given one, psychic-workers translates
 * the signal into BullMQ's own rate-limit mechanism: the queue is paused for
 * that many seconds and the job goes back onto the queue with `attemptsMade`
 * unchanged and no backoff, so the burst is not multiplied by the retry
 * schedule. Note that this package writes a BullMQ priority on every job it
 * enqueues, so a re-queued job reports `prioritized` rather than `waiting` —
 * assertions on `getWaitingCount()` do not hold.
 *
 * The pause replaces the queue's current limiter window and counter — the
 * configured `rateLimit` window and any earlier pause alike — so once
 * `pauseQueueForSeconds` elapses up to `max` jobs may start at once, and a
 * `pauseQueueForSeconds` shorter than the window's remaining time shortens the
 * configured limit. Concurrent throws overwrite each other: last writer wins,
 * not longest.
 *
 * `attemptsMade` never grows, but each re-fetch counts in BullMQ's
 * `attemptsStarted`, and the worker option `maxStartedAttempts`
 * (`defaultBullMQWorkerOptions: { maxStartedAttempts: 10 }`, say) is the only
 * bound on that cycle: without it it is unbounded. Set it on any workstream
 * whose jobs throw this signal.
 *
 * Thrown from a job whose worker carries no `limiter`, the signal is a
 * misconfiguration: the job fails with an ordinary error whose message names
 * the fix. The same check runs under test invocation and `WorkerTestUtils`, so
 * a misplaced job goes red in specs.
 *
 * `pauseQueueForSeconds` must be a positive, finite number of safe magnitude;
 * the constructor throws a `RangeError` otherwise, at the throw site, so a
 * nonsense value fails there rather than at the pause. A fractional number of
 * seconds is legal and is rounded **up** — the field is a lower bound on the
 * pause, so overshooting it by under a second cannot break the promise, while
 * rounding down could.
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
