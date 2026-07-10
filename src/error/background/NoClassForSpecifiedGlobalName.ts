export default class NoClassForSpecifiedGlobalName extends Error {
  constructor(private globalName: string | undefined) {
    super()
  }

  public override get message() {
    return `Error processing background job
No class found for globalName "${this.globalName}"

This usually means the class was renamed or removed after this job
(or its repeating job scheduler) was enqueued.
`
  }
}
