import { PsychicApp } from '@rvoh/psychic'
import type { MockInstance } from 'vitest'
import nameToRedisQueueName from '../../../src/background/helpers/nameToRedisQueueName.js'
import { Background, PsychicAppWorkers } from '../../../src/package-exports/index.js'
import {
  fakeRedisConnection,
  installBullMQRecorders,
  type RecordingWorker,
} from '../../helpers/bullmqRecorders.js'

describe('Background#work process event handling', () => {
  installBullMQRecorders()

  let backgroundInstance: Background
  let exitSpy: MockInstance<typeof process.exit>
  let handlers: Record<string, (...args: unknown[]) => void>

  beforeEach(() => {
    vi.spyOn(PsychicApp, 'log').mockReturnValue(undefined)
    vi.spyOn(PsychicApp, 'logWithLevel').mockReturnValue(undefined)

    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

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

  context('on an instance that has already connected as a producer', () => {
    it('starts the workers the configuration asks for', () => {
      // this file otherwise runs against the simple test-app config, whose worker
      // count is environment-driven and defaults to 0; native mode is the only
      // shape that pins a count in the configuration itself. Configured inline
      // rather than through a shared helper, which lives in the other spec file
      const queueConnection = fakeRedisConnection('queue')
      const workerConnection = fakeRedisConnection('worker')
      PsychicAppWorkers.getOrFail().set('background', {
        nativeBullMQ: { defaultWorkerCount: 2 },
        defaultQueueConnection: queueConnection,
        defaultWorkerConnection: workerConnection,
      })

      // its own instance, separate from the fixture the outer beforeEach worked,
      // and never the singleton: a root-suite beforeEach has already connected
      // that one, so its guard is armed before any example runs
      const producerThenWorker = new Background()
      producerThenWorker.connect()
      expect(producerThenWorker.workers.length).toEqual(0)

      producerThenWorker.work()

      const defaultQueueName = nameToRedisQueueName(Background.defaultQueueName, queueConnection)
      expect(producerThenWorker.workers.length).toEqual(2)
      expect(
        producerThenWorker.workers.map(worker => (worker as unknown as RecordingWorker).queueName),
      ).toEqual([defaultQueueName, defaultQueueName])
    })
  })
})
