import assert from 'node:assert/strict'
import { BaseScheduledService, background } from '@rvoh/psychic-workers'
import { DuplicateNamedWorkstream, InvalidJobSchedulerLocator } from '@rvoh/psychic-workers/errors'
import * as schedulerTypes from '@rvoh/psychic-workers/types'

assert.equal(typeof BaseScheduledService.jobSchedulerLocator, 'function')
assert.equal(typeof BaseScheduledService.unschedule, 'function')
assert.equal(typeof background.getJobSchedulers, 'function')
assert.equal(typeof background.removeJobScheduler, 'function')
assert.equal(typeof InvalidJobSchedulerLocator, 'function')
assert.equal(typeof DuplicateNamedWorkstream, 'function')
assert.equal(typeof schedulerTypes, 'object')
