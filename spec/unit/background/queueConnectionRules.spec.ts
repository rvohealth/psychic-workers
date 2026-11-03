import {
  nativeDefaultQueueConnection,
  nativeNamedQueueConnection,
  simpleDefaultQueueConnection,
  simpleNamedWorkstreamQueueConnection,
} from '../../../src/background/helpers/queueConnectionRules.js'
import { fakeRedisConnection } from '../../helpers/bullmqRecorders.js'

describe('queueConnectionRules', () => {
  const topLevelDefault = fakeRedisConnection('topLevelDefault')
  const nativeDefault = fakeRedisConnection('nativeDefault')
  const own = fakeRedisConnection('own')

  context('simple mode', () => {
    it('the default is defaultQueueConnection', () => {
      expect(simpleDefaultQueueConnection({ defaultQueueConnection: topLevelDefault })).toBe(topLevelDefault)
    })

    it('the default is undefined when defaultQueueConnection is not set', () => {
      expect(simpleDefaultQueueConnection({})).toBeUndefined()
    })

    it('a named workstream uses its own queueConnection', () => {
      expect(simpleNamedWorkstreamQueueConnection({ name: 'w', queueConnection: own }, topLevelDefault)).toBe(
        own,
      )
    })

    it('a named workstream falls back to the default queue connection', () => {
      expect(simpleNamedWorkstreamQueueConnection({ name: 'w' }, topLevelDefault)).toBe(topLevelDefault)
    })

    it('a named workstream is undefined when it has neither its own connection nor a default', () => {
      expect(simpleNamedWorkstreamQueueConnection({ name: 'w' }, undefined)).toBeUndefined()
    })
  })

  context('native mode', () => {
    it('defaultQueueOptions.queueConnection beats the top-level defaultQueueConnection', () => {
      expect(
        nativeDefaultQueueConnection({
          nativeBullMQ: { defaultQueueOptions: { queueConnection: nativeDefault } },
          defaultQueueConnection: topLevelDefault,
        }),
      ).toBe(nativeDefault)
    })

    it('the default falls back to the top-level defaultQueueConnection', () => {
      expect(
        nativeDefaultQueueConnection({
          nativeBullMQ: { defaultQueueOptions: {} },
          defaultQueueConnection: topLevelDefault,
        }),
      ).toBe(topLevelDefault)
      expect(
        nativeDefaultQueueConnection({ nativeBullMQ: {}, defaultQueueConnection: topLevelDefault }),
      ).toBe(topLevelDefault)
    })

    it('the default is undefined when neither is set', () => {
      expect(nativeDefaultQueueConnection({ nativeBullMQ: {} })).toBeUndefined()
    })

    it('a named queue uses its own queueConnection', () => {
      expect(nativeNamedQueueConnection({ queueConnection: own }, nativeDefault)).toBe(own)
    })

    it('a named queue falls back to the native default queue connection', () => {
      expect(nativeNamedQueueConnection({}, nativeDefault)).toBe(nativeDefault)
    })

    it('a named queue is undefined when it has neither its own connection nor a default', () => {
      expect(nativeNamedQueueConnection({}, undefined)).toBeUndefined()
    })
  })
})
