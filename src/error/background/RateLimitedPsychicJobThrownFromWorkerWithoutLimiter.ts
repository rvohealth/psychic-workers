import RateLimitedPsychicJob from './RateLimitedPsychicJob.js'

/**
 * @internal
 *
 * how a queue was configured, as far as the misconfiguration message needs to
 * know in order to name the fix that applies to the worker that threw
 */
export interface WorkerQueueDescription {
  /** simple (workstream) configuration or native BullMQ configuration */
  mode: 'simple' | 'native'
  /** the default workstream/queue, as opposed to a named one */
  isDefaultQueue: boolean
  /** the workstream or queue name as configured (not the formatted Redis queue name) */
  configuredName: string
  /** a workstream declared under `transitionalWorkstreams` */
  transitional: boolean
}

/**
 * Not exported from the package: a `RateLimitedPsychicJob` was thrown from a
 * job whose worker carries no BullMQ `limiter`, so the queue cannot be paused.
 * The job runner fails the job with this error in the signal's place — an
 * ordinary failure, retried per the queue's `attempts`/backoff — so that it
 * reaches whatever failed-job monitoring the application has and the
 * developers learn the job is not on a rate-limited queue. The message names
 * the fix for the configuration mode in use.
 */
export default class RateLimitedPsychicJobThrownFromWorkerWithoutLimiter extends Error {
  constructor(
    private signal: RateLimitedPsychicJob,
    private queue: WorkerQueueDescription,
  ) {
    super(undefined, { cause: signal })
  }

  public override get message() {
    return `
RateLimitedPsychicJob (pause the queue for ${this.signal.pauseQueueForSeconds} seconds) was thrown from a job on ${this.where},
but the workers for that queue carry no BullMQ \`limiter\`, so the queue cannot be paused.
The job has been failed instead.

To fix this, ${this.fix}
`
  }

  private get where() {
    if (this.queue.isDefaultQueue)
      return this.queue.mode === 'simple' ? 'the default workstream' : 'the default queue'
    const kind = this.queue.mode === 'simple' ? 'workstream' : 'queue'
    return `the \`${this.queue.configuredName}\` ${this.queue.transitional ? 'transitional ' : ''}${kind}`
  }

  private get fix() {
    const name = this.queue.configuredName

    if (this.queue.mode === 'simple') {
      if (this.queue.isDefaultQueue)
        return `move the job to a named workstream that sets \`rateLimit: { max, duration }\` (rate limits target
one external service, so the default workstream never carries one). For example, with
\`namedWorkstreams: [{ name: 'slack', rateLimit: { max: 1, duration: 1000 } }]\` in your workers config,
give the backgrounded class \`backgroundJobConfig = { workstream: 'slack' }\`.`

      const entry = this.queue.transitional
        ? `the \`${name}\` entry in \`transitionalWorkstreams.namedWorkstreams\``
        : `the \`${name}\` entry in \`namedWorkstreams\``
      return `set \`rateLimit: { max, duration }\` on ${entry}, or move the job to a named
workstream that sets \`rateLimit\`.`
    }

    if (this.queue.isDefaultQueue)
      return `move the job to a named queue whose \`nativeBullMQ.namedQueueWorkers\` entry sets
\`limiter: { max, duration }\`.`

    return `set \`limiter: { max, duration }\` on \`nativeBullMQ.namedQueueWorkers['${name}']\`, or move the job
to a named queue whose \`namedQueueWorkers\` entry sets \`limiter\`.`
  }
}
