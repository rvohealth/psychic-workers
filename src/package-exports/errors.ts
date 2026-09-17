export { default as NoClassForSpecifiedGlobalName } from '../error/background/NoClassForSpecifiedGlobalName.js'
// exported for backward compatibility only. Thrown by the framework when a job's
// config names a queue that does not exist — a configuration mistake an
// application cannot recover from, and not intended to be caught.
export { default as NoQueueForSpecifiedQueueName } from '../error/background/NoQueueForSpecifiedQueueName.js'
// exported for backward compatibility only. Thrown by the framework when a job's
// config names a workstream that does not exist — a configuration mistake an
// application cannot recover from, and not intended to be caught.
export { default as NoQueueForSpecifiedWorkstream } from '../error/background/NoQueueForSpecifiedWorkstream.js'
export { default as RateLimitedPsychicJob } from '../error/background/RateLimitedPsychicJob.js'
