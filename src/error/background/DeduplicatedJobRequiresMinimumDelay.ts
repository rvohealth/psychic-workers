/**
 * Not exported from the package: a delayed background job carried a `jobId`
 * (a deduplication key) without a usable delay behind it, or carried a `jobId`
 * that is not a usable key (the empty string, which the type admits and BullMQ
 * refuses).
 *
 * A `jobId` debounces: BullMQ holds a deduplication key for the life of the
 * delay and swallows repeat calls that land while it is live. That is only
 * meaningful when the delay is long enough to outlast the time it takes a
 * worker to pick a job up, so this package requires at least five seconds.
 * Anything shorter — and zero, negative, `Infinity`, `NaN`, or a magnitude past
 * `Number.MAX_SAFE_INTEGER` — is refused here rather than quietly enqueued with
 * no deduplication at all, or forwarded to Redis `SET ... PX`, which rejects a
 * fractional or out-of-range argument. `durationToSeconds` does not catch any
 * of these: it validates nothing, and its falsy-field sum silently drops a
 * `NaN` field rather than propagating it (`{ hours: 1, seconds: NaN }` is
 * `3600`), so `{ seconds: NaN }` reaches this check as `0` and the remaining
 * shapes reach it as themselves.
 *
 * The check runs before the test-mode short circuit in `_addToQueue`, so a
 * consumer's default test environment raises this exactly as production does.
 */
export default class DeduplicatedJobRequiresMinimumDelay extends Error {
  constructor(
    private jobId: string,
    private delaySeconds: number | undefined,
    private minimumDelayMs: number,
  ) {
    super()
  }

  public override get message() {
    if (this.jobId === '') return this.emptyJobIdMessage
    return `
A delayed background job was given the \`jobId\` ${JSON.stringify(this.jobId)}, but no usable delay to go with it (got \`delaySeconds\`: ${String(this.delaySeconds)}).
\`jobId\` is a deduplication key: repeat calls arriving within the delay window are collapsed into one run. It only
does anything when the delay is at least ${this.minimumDelayMs / 1000} seconds, which is the point at which a debounce window is
meaningfully longer than the time it takes a worker to pick the job up. The delay must also be a finite number of
milliseconds within \`Number.MAX_SAFE_INTEGER\`, since BullMQ passes it to Redis unvalidated.

Either give the delay at least ${this.minimumDelayMs / 1000} seconds, e.g. \`{ seconds: ${this.minimumDelayMs / 1000}, jobId: ${JSON.stringify(this.jobId)} }\`, or drop the
\`jobId\` if you did not want deduplication. Nothing was enqueued.
`
  }

  private get emptyJobIdMessage() {
    return `
A delayed background job was given an empty \`jobId\` (got \`delaySeconds\`: ${String(this.delaySeconds)}).
\`jobId\` is a deduplication key: repeat calls arriving within the delay window are collapsed into one run. An empty
string is not a usable key — BullMQ refuses it — and it is almost always a key that was built from a value that
turned out to be missing, e.g. an id read from a nullable column.

Either give the \`jobId\` a non-empty value, or drop it if you did not want deduplication (a delay with no \`jobId\`
is enqueued normally, at any length). Nothing was enqueued.
`
  }
}
