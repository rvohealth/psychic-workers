import { background } from '../../../src'
import { PsychicWorkersHookEventType } from '../../../src/psychic-application-workers'

describe('PsychicWorkers hooks', () => {
  beforeEach(() => {
    process.env.__PSYCHIC_HOOKS_TEST_CACHE = ''
  })

  function expectHookCalled(hookEventType: PsychicWorkersHookEventType) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    expect((process.env as any).__PSYCHIC_HOOKS_TEST_CACHE.split(',')).toEqual(
      expect.arrayContaining([hookEventType]),
    )
  }

  it('processes hooks for workers:shutdown', async () => {
    background.connect()
    await background.shutdown()
    expectHookCalled('workers:shutdown')
  })
})
