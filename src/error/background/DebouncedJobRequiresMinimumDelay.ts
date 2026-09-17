/**
 * Not exported from the package, and deliberately so: every branch of the guard
 * that throws it is a call-site mistake — a `jobId` behind a delay under the
 * floor, an empty `jobId`, or a delay that is zero, negative, `Infinity`, `NaN`
 * or past `Number.MAX_SAFE_INTEGER` — so an application can never usefully
 * catch it. The fix is always an edit to the call.
 *
 * `durationToSeconds` catches none of these: it validates nothing, and its
 * falsy-field sum silently drops a `NaN` field rather than propagating it
 * (`{ hours: 1, seconds: NaN }` is `3600`), so `{ seconds: NaN }` reaches this
 * check as `0`.
 *
 * The check runs before the test-mode short circuit in `_addToQueue`, so a
 * consumer's default test environment raises this exactly as production does.
 */
export default class DebouncedJobRequiresMinimumDelay extends Error {
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
A delayed background job was given the \`jobId\` ${JSON.stringify(this.jobId)}, but a delay too short to debounce with (got \`delaySeconds\`: ${String(this.delaySeconds)}).
\`jobId\` is a deduplication key: repeat calls arriving within the delay window are collapsed into one run, and each
call restarts the window, so a burst collapses however long it runs. The delay must be at least ${this.minimumDelayMs / 1000} seconds: the key
that does the collapsing lives one second less than the delay, and below this floor what is left is too short to
survive an ordinary pause between two calls. The delay must also be a finite number of milliseconds within
\`Number.MAX_SAFE_INTEGER\`, since BullMQ passes it to Redis unvalidated.

Either give the delay at least ${this.minimumDelayMs / 1000} seconds, e.g. \`{ seconds: ${this.minimumDelayMs / 1000}, jobId: ${JSON.stringify(this.jobId)} }\`, or drop the
\`jobId\` if you did not want debouncing. Nothing was enqueued.
`
  }

  private get emptyJobIdMessage() {
    return `
A delayed background job was given an empty \`jobId\` (got \`delaySeconds\`: ${String(this.delaySeconds)}).
\`jobId\` is a deduplication key: repeat calls arriving within the delay window are collapsed into one run. An empty
string is not a usable key — BullMQ refuses it — and it is almost always a key that was built from a value that
turned out to be missing, e.g. an id read from a nullable column.

Either give the \`jobId\` a non-empty value, or drop it if you did not want debouncing (a delay with no \`jobId\`
is enqueued normally, at any length). Nothing was enqueued.
`
  }
}
