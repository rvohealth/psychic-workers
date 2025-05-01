import { DelayedJobDuration } from '../types/background.js'

export default function durationToSeconds(duration: DelayedJobDuration) {
  return (
    (duration.seconds ? duration.seconds : 0) +
    (duration.minutes ? duration.minutes * 60 : 0) +
    (duration.hours ? duration.hours * 60 * 60 : 0) +
    (duration.days ? duration.days * 60 * 60 * 24 : 0)
  )
}
