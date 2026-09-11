import InvalidJobSchedulerLocator from '../../../src/error/background/InvalidJobSchedulerLocator.js'
import { Background } from '../../../src/package-exports/index.js'
import { installBullMQRecorders } from '../../helpers/bullmqRecorders.js'

describe('Background job scheduler identity', () => {
  const bullmq = installBullMQRecorders()

  it('preserves the deployed queue-local id and round-trips an opaque named-route locator', () => {
    const background = new Background()
    const identity = background.jobSchedulerIdentity('services/日:psychic-job-scheduler', 'réconcile:∆', {
      workstream: 'queue:v1:東京/💌',
    })

    expect(identity).toEqual({
      jobSchedulerId: 'services/日:psychic-job-scheduler:réconcile:∆',
      locator:
        'psychic-job-scheduler:v1:WyJzZXJ2aWNlcy_ml6U6cHN5Y2hpYy1qb2Itc2NoZWR1bGVyIiwicsOpY29uY2lsZTriiIYiLFsibmFtZWQiLCJxdWV1ZTp2MTrmnbHkuqwv8J-SjCJdXQ',
      globalName: 'services/日:psychic-job-scheduler',
      method: 'réconcile:∆',
      route: { kind: 'named', name: 'queue:v1:東京/💌' },
    })
    expect(new Background().jobSchedulerIdentityFromLocator(identity.locator)).toEqual(identity)
    expect(bullmq.allQueues).toEqual([])
  })

  it('uses one canonical named route for simple workstreams and native queues', () => {
    const background = new Background()

    const workstreamIdentity = background.jobSchedulerIdentity('services/Mailers', 'deliver', {
      workstream: 'mailers',
    })
    const queueIdentity = background.jobSchedulerIdentity('services/Mailers', 'deliver', {
      queue: 'mailers',
    })

    expect(queueIdentity).toEqual(workstreamIdentity)
  })

  it('round-trips the default logical route across Background generations', () => {
    const identity = new Background().jobSchedulerIdentity('services/Digest', 'deliver', {})

    expect(new Background().jobSchedulerIdentityFromLocator(identity.locator)).toEqual(identity)
    expect(identity.route).toEqual({ kind: 'default' })
  })

  it('rejects malformed and unsupported-version locators with the framework error', () => {
    const background = new Background()

    expect(() => background.jobSchedulerIdentityFromLocator('deliver')).toThrow(InvalidJobSchedulerLocator)
    expect(() =>
      background.jobSchedulerIdentityFromLocator('psychic-job-scheduler:v2:WyJub3QiLCJ2MSJd'),
    ).toThrow(InvalidJobSchedulerLocator)
    expect(() =>
      background.jobSchedulerIdentityFromLocator('psychic-job-scheduler:v1:not-base64url!'),
    ).toThrow(InvalidJobSchedulerLocator)
  })
})
