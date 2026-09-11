export default class DuplicateNamedWorkstream extends Error {
  constructor(
    private workstream: string,
    private source: 'current' | 'transitional',
  ) {
    super()
  }

  public override get message() {
    return `Named workstream "${this.workstream}" is duplicated in ${this.source} background configuration`
  }
}
