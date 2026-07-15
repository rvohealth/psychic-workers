import { PsychicApp } from '@rvoh/psychic'
import { Queue, Worker } from 'bullmq'
import { Background } from '../../../src/package-exports/index.js'

describe('Background#work process event handling', () => {
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

  let backgroundInstance: Background
  let exitSpy: ReturnType<typeof vi.spyOn>
  let handlers: Record<string, (...args: unknown[]) => void>

  beforeEach(() => {
    vi.spyOn(Background, 'Queue', 'get').mockReturnValue(QueueStub as unknown as typeof Queue)
    vi.spyOn(Background, 'Worker', 'get').mockReturnValue(WorkerStub as unknown as typeof Worker)
    vi.spyOn(PsychicApp, 'log').mockReturnValue(undefined)
    vi.spyOn(PsychicApp, 'logWithLevel').mockReturnValue(undefined)

    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never) as ReturnType<
      typeof vi.spyOn
    >

    handlers = {}
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = handler
      return process
    }) as typeof process.on)

    backgroundInstance = new Background()
    backgroundInstance.work()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  context('uncaughtException', () => {
    it('attempts graceful shutdown, then exits with code 1', async () => {
      const shutdownSpy = vi.spyOn(backgroundInstance, 'shutdown').mockResolvedValue(undefined)

      handlers['uncaughtException']!(new Error('uncaught exception'))

      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1))
      expect(shutdownSpy).toHaveBeenCalled()
    })

    context('when graceful shutdown rejects', () => {
      it('still exits with code 1', async () => {
        vi.spyOn(backgroundInstance, 'shutdown').mockRejectedValue(new Error('shutdown failure'))

        handlers['uncaughtException']!(new Error('uncaught exception'))

        await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1))
      })
    })

    context('when graceful shutdown hangs', () => {
      it('exits with code 1 once the shutdown timeout elapses', async () => {
        vi.useFakeTimers()
        vi.spyOn(backgroundInstance, 'shutdown').mockImplementation(() => new Promise(() => {}))

        handlers['uncaughtException']!(new Error('uncaught exception'))

        await vi.advanceTimersByTimeAsync(Background.SHUTDOWN_TIMEOUT_MS)
        expect(exitSpy).toHaveBeenCalledWith(1)
        vi.useRealTimers()
      })
    })

    context('when a second fatal error arrives during cleanup', () => {
      it('exits immediately with code 1', async () => {
        vi.spyOn(backgroundInstance, 'shutdown').mockImplementation(() => new Promise(() => {}))

        handlers['uncaughtException']!(new Error('first fatal error'))
        expect(exitSpy).not.toHaveBeenCalled()

        handlers['uncaughtException']!(new Error('second fatal error'))
        await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1))
      })
    })
  })

  context('unhandledRejection', () => {
    it('attempts graceful shutdown, then exits with code 1', async () => {
      const shutdownSpy = vi.spyOn(backgroundInstance, 'shutdown').mockResolvedValue(undefined)

      handlers['unhandledRejection']!(new Error('unhandled rejection'))

      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1))
      expect(shutdownSpy).toHaveBeenCalled()
    })
  })

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    context(signal, () => {
      it('exits with code 0 after clean graceful shutdown', async () => {
        const shutdownSpy = vi.spyOn(backgroundInstance, 'shutdown').mockResolvedValue(undefined)

        handlers[signal]!()

        await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0))
        expect(shutdownSpy).toHaveBeenCalled()
      })

      context('when graceful shutdown rejects', () => {
        it('exits with code 1 instead of leaving the process alive', async () => {
          vi.spyOn(backgroundInstance, 'shutdown').mockRejectedValue(new Error('shutdown failure'))

          handlers[signal]!()

          await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1))
        })
      })

      context('when graceful shutdown hangs', () => {
        it('exits with code 1 once the shutdown timeout elapses', async () => {
          vi.useFakeTimers()
          vi.spyOn(backgroundInstance, 'shutdown').mockImplementation(() => new Promise(() => {}))

          handlers[signal]!()

          await vi.advanceTimersByTimeAsync(Background.SHUTDOWN_TIMEOUT_MS)
          expect(exitSpy).toHaveBeenCalledWith(1)
          vi.useRealTimers()
        })
      })
    })
  }
})
