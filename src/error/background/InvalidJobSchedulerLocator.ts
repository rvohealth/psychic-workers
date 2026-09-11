export default class InvalidJobSchedulerLocator extends Error {
  public override get message() {
    return 'Invalid Psychic job scheduler locator'
  }
}
