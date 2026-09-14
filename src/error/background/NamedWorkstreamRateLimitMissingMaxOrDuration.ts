/**
 * Not exported from the package: a named workstream's `rateLimit` reached
 * `connect()` without a positive integer `max` or `duration`. The type requires
 * both, but a JavaScript config, a cast, or parsed JSON can still hand one in
 * missing or of the wrong type, and the type itself admits a fractional or
 * oversize number. Open-source BullMQ forwards the worker `limiter` it becomes
 * unvalidated: a missing or non-numeric field fails every job fetch on that
 * workstream with a Lua error that never names `rateLimit`, a fractional
 * `duration` is floored to 0ms and rate limits nothing, and one past Redis's
 * integer range fails every fetch. `connect()` throws this instead, before
 * building anything.
 */
export default class NamedWorkstreamRateLimitMissingMaxOrDuration extends Error {
  constructor(
    private workstreamName: string,
    private transitional: boolean,
    private field: 'max' | 'duration',
    private received: unknown,
  ) {
    super()
  }

  public override get message() {
    const entry = this.transitional ? 'transitionalWorkstreams.namedWorkstreams' : 'namedWorkstreams'
    const received = typeof this.received === 'string' ? JSON.stringify(this.received) : String(this.received)

    return `
\`rateLimit\` on the \`${this.workstreamName}\` entry in \`${entry}\` is missing a usable \`${this.field}\` (got ${received}).
Both \`max\` and \`duration\` must be positive integers, e.g. \`rateLimit: { max: 1, duration: 1000 }\`
(at most \`max\` jobs start in any \`duration\` milliseconds). Open-source BullMQ does not validate the worker
\`limiter\` this becomes and would fail every job fetch on that workstream or rate limit nothing, so nothing was connected.
`
  }
}
