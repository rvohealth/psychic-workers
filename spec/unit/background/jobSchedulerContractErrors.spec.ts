import { DuplicateNamedWorkstream, InvalidJobSchedulerLocator } from '../../../src/package-exports/errors.js'

describe('job scheduler contract errors', () => {
  describe('InvalidJobSchedulerLocator', () => {
    it('identifies malformed or unsupported opaque locators without exposing a decoder contract', () => {
      expect(new InvalidJobSchedulerLocator()).toMatchObject({
        message: 'Invalid Psychic job scheduler locator',
      })
    })
  })

  describe('DuplicateNamedWorkstream', () => {
    it('identifies the duplicated logical route and topology source', () => {
      expect(new DuplicateNamedWorkstream('mailers', 'transitional')).toMatchObject({
        message: 'Named workstream "mailers" is duplicated in transitional background configuration',
      })
    })
  })
})
