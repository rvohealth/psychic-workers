import { Worker } from 'bullmq'
import { Background } from '../../../src/package-exports/index.js'

describe('Background#closeAllRedisConnections', () => {
  context('when closing one worker rejects', () => {
    it('still closes the remaining workers', async () => {
      const backgroundInstance = new Background()

      const failingWorker = { close: vi.fn().mockRejectedValue(new Error('redis down')) }
      const healthyWorker = { close: vi.fn().mockResolvedValue(undefined) }
      ;(backgroundInstance as unknown as { _workers: unknown[] })._workers = [
        failingWorker as unknown as Worker,
        healthyWorker as unknown as Worker,
      ]

      await backgroundInstance.closeAllRedisConnections()

      expect(failingWorker.close).toHaveBeenCalled()
      expect(healthyWorker.close).toHaveBeenCalled()
    })
  })
})
