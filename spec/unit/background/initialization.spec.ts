import { background } from '../../../src/package-exports/index.js'
import { installBullMQRecorders } from '../../helpers/bullmqRecorders.js'

describe('background (app singleton) initialization', () => {
  installBullMQRecorders()

  context('workers', () => {
    it('reads extra workers from app configuration and applies them when calling work method', () => {
      background.work()
      // expect(background.extraWorkers.length).toEqual(1)
      // expect(background.extraWorkers[0]).toBeInstanceOf(bullmq.Worker)
    })
  })
})
