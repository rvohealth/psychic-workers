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
 * goes back onto the queue (state `prioritized`: this package writes a BullMQ
 * priority on every job it enqueues, mapping even `'default'` to 2 rather than
 * to BullMQ's no-priority 0, so a psychic-workers job reports `waiting` only in
 * the two cases described below) with `attemptsMade` unchanged and no backoff,
 * so the burst is not multiplied by the retry schedule. The check
 * reads only the worker options: a queue rate-limited solely through BullMQ's
 * `queue.setGlobalRateLimit` is treated as misconfigured (below) even though
 * its workers would honor the pause. Every worker on the queue that carries a
 * `limiter` honors the pause; a limiter-less worker in another process on the
 * same queue — during a rolling deploy that has not yet picked up `rateLimit`,
 * say — instead re-fetches the job, runs it once more, and fails it with the
 * misconfiguration error described below.
 *
 * The two ways a job on one of these queues can still report
 * `getState() === 'waiting'` are a job an application added itself through
 * `background.queues` with no `priority`, and a job BullMQ has recovered after
 * a stall. Stall recovery is worth knowing about: when a worker dies or loses
 * its lock, `moveStalledJobsToWait` returns the job to the `wait` LIST
 * unconditionally, without reading the priority it still carries — so a
 * recovered job reports `waiting` while its `opts.priority` is unchanged, and
 * because BullMQ drains the `wait` LIST before it reads the prioritized set,
 * that job is fetched ahead of every prioritized job on its queue however
 * urgent they are. The inversion is transient — it lasts until the recovered
 * job is picked up — and it is not configurable away; `maxStalledCount` bounds
 * how many times a single job can go around that loop. Nothing here is specific
 * to `RateLimitedPsychicJob`; it applies to every job this package enqueues,
 * and it is the reason an application's monitoring should not read `waiting` as
 * proof that a job carries no priority.
 *
 * The pause replaces the queue's current limiter window and counter — the
 * configured `rateLimit` window and any earlier pause alike — so once
 * `pauseQueueForSeconds` elapses up to `max` jobs may start at once, and a
 * `pauseQueueForSeconds` shorter than the window's remaining time shortens the
 * configured limit. The value is applied as given, rounded up to a whole second,
 * with no upper bound; concurrent throws overwrite each other (last writer wins,
 * not longest).
 *
 * Once the pause ends, the re-queued job is fetched first among the jobs at its
 * own priority — not ahead of every job on the queue: a job at a higher
 * priority still goes first — so a request that never clears pauses the queue
 * again on every cycle. "First" there is about ordering, not latency: BullMQ
 * pushes a job carrying a priority back from `active` with a bare sorted-set
 * write and no marker, so unlike a priority-less job it wakes no worker that is
 * already blocked waiting for work. A worker counting down the pause it was
 * just given notices immediately; an idle worker on the same queue in another
 * process may not see the job until its blocking read times out, which is
 * bounded by BullMQ's `drainDelay` (5s by default). That is the case worth
 * knowing for the limiter-less worker described above — it re-fetches the job,
 * but possibly a few seconds later than the pause itself would suggest.
 * Latency only: nothing is stranded, and the pause the job asked for usually
 * exceeds the window anyway. `attemptsMade` never grows, but each re-fetch counts in BullMQ's
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
 * the constructor throws a `RangeError` otherwise, at the throw site, so a
 * nonsense value fails there rather than at the pause. The bound is on the
 * value in **seconds**; what is sent to Redis is that value in milliseconds, a
 * thousand times larger. Redis accepts it — its expiry range is far wider than
 * this — but at the very top of the legal range the product is past
 * `Number.MAX_SAFE_INTEGER` and so is not exactly the number asked for. The
 * imprecision begins at a pause of roughly 285 million years, which is why the
 * bound is left where it is. A fractional number of seconds is legal and is
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
