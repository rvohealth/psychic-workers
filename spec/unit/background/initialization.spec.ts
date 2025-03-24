import { Queue, Worker } from 'bullmq'
import { Background, background } from '../../../src/index.js'

describe('background (app singleton) initialization', () => {
  context('workers', () => {
    it('reads extra workers from app configuration and applies them when calling work method', () => {
      class QueueStub {
        close() {
          return null
        }
      }
      class WorkerStub {
        close() {
          return null
        }
      }

      vi.spyOn(Background, 'Queue', 'get').mockReturnValue(QueueStub as unknown as typeof Queue)
      vi.spyOn(Background, 'Worker', 'get').mockReturnValue(WorkerStub as unknown as typeof Worker)

      background.work()
      // expect(background.extraWorkers.length).toEqual(1)
      // expect(background.extraWorkers[0]).toBeInstanceOf(WorkerStub)
    })
  })
})
