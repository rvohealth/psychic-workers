import durationToSeconds from '../../../src/helpers/durationToSeconds.js'

describe('durationToSeconds', () => {
  context('with a blank object', () => {
    it('returns undefined', () => {
      const duration = durationToSeconds({})
      expect(duration).toEqual(0)
    })
  })

  context('seconds', () => {
    it('returns number', () => {
      const duration = durationToSeconds({ seconds: 31 })
      expect(duration).toEqual(31)
    })
  })

  context('minutes', () => {
    it('returns number * 60', () => {
      const duration = durationToSeconds({ minutes: 1 })
      expect(duration).toEqual(60)
    })
  })

  context('hours', () => {
    it('returns number * 60 * 60', () => {
      const duration = durationToSeconds({ hours: 1 })
      expect(duration).toEqual(60 * 60)
    })
  })

  context('days', () => {
    it('returns number * 60 * 60 * 24', () => {
      const duration = durationToSeconds({ days: 31 })
      expect(duration).toEqual(31 * 60 * 60 * 24)
    })
  })

  context('with multiple fields set', () => {
    it('combines multiple fields to yield seconds', () => {
      const duration = durationToSeconds({ days: 1, hours: 1, minutes: 1, seconds: 1 })

      const daysSeconds = 60 * 60 * 24
      const hoursSeconds = 60 * 60
      const minutesSeconds = 60
      const secondsSeconds = 1
      const expectedDurationSeconds = daysSeconds + hoursSeconds + minutesSeconds + secondsSeconds

      expect(duration).toEqual(expectedDurationSeconds)
    })
  })
})
