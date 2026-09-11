/**
 * Raised when a Psychic job scheduler locator is malformed or uses an
 * unsupported locator version.
 */
export default class InvalidJobSchedulerLocator extends Error {
  public override get message() {
    return 'Invalid Psychic job scheduler locator'
  }
}
