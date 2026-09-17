import { PsychicApp } from '@rvoh/psychic'
import { Job } from 'bullmq'
import { Redis } from 'ioredis'
import nameToRedisQueueName from '../../../src/background/helpers/nameToRedisQueueName.js'
import RateLimitedPsychicJobThrownFromWorkerWithoutLimiter from '../../../src/error/background/RateLimitedPsychicJobThrownFromWorkerWithoutLimiter.js'
import { RateLimitedPsychicJob } from '../../../src/package-exports/errors.js'
import { Background, PsychicAppWorkers } from '../../../src/package-exports/index.js'
import { BackgroundJobConfig, PsychicBackgroundOptions } from '../../../src/types/background.js'
import DummyService from '../../../test-app/src/app/services/DummyService.js'
import {
  fakeRedisConnection,
  installBullMQRecorders,
  nativeWorkerOptions,
  RecordingQueue,
} from '../../helpers/bullmqRecorders.js'

const PAUSE_QUEUE_FOR_SECONDS = 5

describe('RateLimitedPsychicJob', () => {
  describe('constructor', () => {
    it('is importable from the package’s errors barrel', () => {
      expect(new RateLimitedPsychicJob({ pauseQueueForSeconds: PAUSE_QUEUE_FOR_SECONDS })).toBeInstanceOf(
        Error,
      )
    })

    it('exposes pauseQueueForSeconds and names it in the message', () => {
      const signal = new RateLimitedPsychicJob({ pauseQueueForSeconds: PAUSE_QUEUE_FOR_SECONDS })
      expect(signal.pauseQueueForSeconds).toEqual(PAUSE_QUEUE_FOR_SECONDS)
      expect(signal.message).toEqual('job was rate limited; pause the queue for 5 seconds')
    })

    // the field is a lower bound on the pause, so a fraction of a second is
    // legal and is kept as given; the processor is what rounds it up
    it('keeps a fractional number of seconds as given', () => {
      const signal = new RateLimitedPsychicJob({ pauseQueueForSeconds: 2.5 })
      expect(signal.pauseQueueForSeconds).toEqual(2.5)
      expect(signal.message).toEqual('job was rate limited; pause the queue for 2.5 seconds')
    })

    // a zero or negative pause is not a pause, and a non-finite or oversize one
    // reaches Redis `SET … PX` as a value it rejects; the constructor refuses
    // them first, at the throw site
    it.each([0, -1, NaN, Infinity, -Infinity, 1e20, '5' as unknown as number])(
      'throws for a pauseQueueForSeconds of %s',
      pauseQueueForSeconds => {
        expect(() => new RateLimitedPsychicJob({ pauseQueueForSeconds })).toThrow(RangeError)
        expect(() => new RateLimitedPsychicJob({ pauseQueueForSeconds })).toThrow(
          `RateLimitedPsychicJob requires pauseQueueForSeconds to be a positive, finite number of safe magnitude (the number of seconds to pause the queue for); received ${String(pauseQueueForSeconds)}`,
        )
      },
    )
  })

  /**
   * Every worker `Background#connect` builds runs a processor that wraps
   * `doWork`. When the job throws `RateLimitedPsychicJob`:
   *
   * - on a worker whose options carry a BullMQ `limiter`, the processor logs
   *   the pause at `warn` (the length comes from the job and is applied as
   *   given), pauses the queue built alongside that worker for `pauseQueueForSeconds`
   *   and throws BullMQ's own `RateLimitError`, which the worker recognizes by
   *   its message (`bullmq:rateLimitExceeded`) and answers by moving the job
   *   back to the queue with no attempt counted
   * - on a worker whose options carry none, the processor fails the job with
   *   the non-exported misconfiguration error instead, whose message names the
   *   fix that applies to that worker, and pauses nothing
   *
   * The recorder harness stands in for BullMQ here, so the worker's response to
   * `RateLimitError` is not exercised (`rateLimitedPsychicJobWorker.spec.ts`
   * covers it against a real worker); what is asserted is exactly what crosses
   * the boundary: the log line, the pause request and the thrown error.
   */
  describe('thrown from a job under a worker processor', () => {
    const bullmq = installBullMQRecorders()

    let queueConnection: Redis
    let workerConnection: Redis

    /** every `PsychicApp.logWithLevel` call, as `[level, ...args]` */
    let logged: unknown[][]

    function connectWorkers(backgroundOptions: PsychicBackgroundOptions) {
      PsychicAppWorkers.getOrFail().set('background', backgroundOptions)
      const backgroundInstance = new Background()
      backgroundInstance.connect({ activateWorkers: true })
      return backgroundInstance
    }

    function queuesFor(queueName: string) {
      return bullmq.queues.filter(
        queue => queue.queueName === nameToRedisQueueName(queueName, queueConnection),
      )
    }

    function workersFor(queueName: string) {
      return bullmq.workers.filter(
        worker => worker.queueName === nameToRedisQueueName(queueName, queueConnection),
      )
    }

    /**
     * runs the recorded processor of the first worker on `queueName` with a
     * job whose method rejects with `RateLimitedPsychicJob`, resolving with
     * whatever the processor rejects with
     */
    async function runRateLimitedJobOn(queueName: string, workerIndex = 0): Promise<unknown> {
      vi.spyOn(DummyService, 'classRunInBG').mockRejectedValue(
        new RateLimitedPsychicJob({ pauseQueueForSeconds: PAUSE_QUEUE_FOR_SECONDS }),
      )

      const worker = workersFor(queueName)[workerIndex]!
      const processor = worker.processor as (job: Job) => Promise<void>
      const job = {
        name: 'BackgroundJobQueueStaticJob',
        data: { globalName: DummyService.globalName, method: 'classRunInBG', args: ['howyadoin'] },
      } as unknown as Job

      try {
        await processor(job)
      } catch (err) {
        return err
      }

      throw new Error('expected the processor to reject')
    }

    function expectRateLimitedQueue(queue: RecordingQueue, err: unknown) {
      // bullmq's own RateLimitError: the worker matches it by message alone
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toEqual('bullmq:rateLimitExceeded')
      expect(err).not.toBeInstanceOf(RateLimitedPsychicJob)
      expect(queue.rateLimits).toEqual([PAUSE_QUEUE_FOR_SECONDS * 1000])

      // the pause is applied as the job asked, so it is announced: short of
      // PTTL on the limiter key, the only sign that the workstream is stalled
      expect(logged).toEqual([
        [
          'warn',
          `[psychic-workers] pausing queue ${queue.name} for ${PAUSE_QUEUE_FOR_SECONDS}s: a job threw RateLimitedPsychicJob`,
        ],
      ])
      logged.length = 0
    }

    function expectMisconfigured(queue: RecordingQueue, err: unknown) {
      expect(err).toBeInstanceOf(RateLimitedPsychicJobThrownFromWorkerWithoutLimiter)
      expect(err).not.toBeInstanceOf(RateLimitedPsychicJob)
      expect((err as Error).cause).toBeInstanceOf(RateLimitedPsychicJob)
      expect((err as Error).message).toContain(
        `RateLimitedPsychicJob (pause the queue for ${PAUSE_QUEUE_FOR_SECONDS} seconds) was thrown from a job on`,
      )
      expect(queue.rateLimits).toEqual([])
      expect(logged).toEqual([])
    }

    beforeEach(() => {
      queueConnection = fakeRedisConnection('queue')
      workerConnection = fakeRedisConnection('worker')
      logged = []
      vi.spyOn(PsychicApp, 'logWithLevel').mockImplementation((...args: unknown[]) => {
        logged.push(args)
      })
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    context('simple mode', () => {
      context('a named workstream with rateLimit', () => {
        it('pauses that workstream’s queue for pauseQueueForSeconds and throws BullMQ’s RateLimitError', async () => {
          connectWorkers({
            defaultQueueConnection: queueConnection,
            defaultWorkerConnection: workerConnection,
            namedWorkstreams: [{ workerCount: 2, name: 'snazzy', rateLimit: { max: 1, duration: 1000 } }],
          })

          expectRateLimitedQueue(queuesFor('snazzy')[0]!, await runRateLimitedJobOn('snazzy', 1))
          expect(queuesFor(Background.defaultQueueName)[0]!.rateLimits).toEqual([])
        })
      })

      context('a named workstream without rateLimit', () => {
        it('fails the job with the misconfiguration error, naming that workstream’s namedWorkstreams entry, and pauses nothing', async () => {
          connectWorkers({
            defaultQueueConnection: queueConnection,
            defaultWorkerConnection: workerConnection,
            namedWorkstreams: [{ workerCount: 1, name: 'plain' }],
          })

          const err = await runRateLimitedJobOn('plain')
          expectMisconfigured(queuesFor('plain')[0]!, err)
          expect((err as Error).message).toContain('the `plain` workstream')
          expect((err as Error).message).toContain(
            'set `rateLimit: { max, duration }` on the `plain` entry in `namedWorkstreams`',
          )
        })
      })

      context('the default workstream with no global limiter', () => {
        it('fails the job with the misconfiguration error, telling the developer to move the job to a rate-limited named workstream', async () => {
          connectWorkers({
            defaultQueueConnection: queueConnection,
            defaultWorkerConnection: workerConnection,
            defaultWorkstream: { workerCount: 1 },
          })

          const err = await runRateLimitedJobOn(Background.defaultQueueName)
          expectMisconfigured(queuesFor(Background.defaultQueueName)[0]!, err)
          expect((err as Error).message).toContain('the default workstream')
          expect((err as Error).message).toContain(
            'move the job to a named workstream that sets `rateLimit: { max, duration }`',
          )
        })
      })

      context('the default workstream under a global defaultBullMQWorkerOptions.limiter', () => {
        it('pauses the default queue, since its workers carry that limiter', async () => {
          connectWorkers({
            defaultBullMQWorkerOptions: { limiter: { max: 10, duration: 1000 } },
            defaultQueueConnection: queueConnection,
            defaultWorkerConnection: workerConnection,
            defaultWorkstream: { workerCount: 1 },
          })

          expectRateLimitedQueue(
            queuesFor(Background.defaultQueueName)[0]!,
            await runRateLimitedJobOn(Background.defaultQueueName),
          )
        })
      })

      context('a transitional workstream with rateLimit', () => {
        it('pauses the transitional queue built alongside the throwing worker, not its current twin', async () => {
          connectWorkers({
            defaultQueueConnection: queueConnection,
            defaultWorkerConnection: workerConnection,
            namedWorkstreams: [{ workerCount: 1, name: 'snazzy' }],
            transitionalWorkstreams: {
              defaultQueueConnection: queueConnection,
              defaultWorkerConnection: workerConnection,
              namedWorkstreams: [{ workerCount: 1, name: 'snazzy', rateLimit: { max: 1, duration: 1000 } }],
            },
          })

          // both twins share a formatted queue name; the current one is built first
          const [currentQueue, transitionalQueue] = queuesFor('snazzy')
          const [, transitionalWorker] = workersFor('snazzy')
          expect(transitionalWorker!.workerOptions['limiter']).toEqual({ max: 1, duration: 1000 })

          expectRateLimitedQueue(transitionalQueue!, await runRateLimitedJobOn('snazzy', 1))
          expect(currentQueue!.rateLimits).toEqual([])

          // and the current twin, which has no rateLimit, is misconfigured
          const err = await runRateLimitedJobOn('snazzy', 0)
          expectMisconfigured(currentQueue!, err)
          expect(transitionalQueue!.rateLimits).toEqual([PAUSE_QUEUE_FOR_SECONDS * 1000])
        })

        it('names the transitionalWorkstreams entry when the transitional twin has no rateLimit', async () => {
          connectWorkers({
            defaultQueueConnection: queueConnection,
            defaultWorkerConnection: workerConnection,
            namedWorkstreams: [{ workerCount: 1, name: 'snazzy', rateLimit: { max: 1, duration: 1000 } }],
            transitionalWorkstreams: {
              defaultQueueConnection: queueConnection,
              defaultWorkerConnection: workerConnection,
              namedWorkstreams: [{ workerCount: 1, name: 'snazzy' }],
            },
          })

          const [, transitionalQueue] = queuesFor('snazzy')
          const err = await runRateLimitedJobOn('snazzy', 1)
          expectMisconfigured(transitionalQueue!, err)
          expect((err as Error).message).toContain('the `snazzy` transitional workstream')
          expect((err as Error).message).toContain(
            'set `rateLimit: { max, duration }` on the `snazzy` entry in `transitionalWorkstreams.namedWorkstreams`',
          )
        })
      })
    })

    context('native BullMQ mode', () => {
      context('a named queue whose namedQueueWorkers entry sets limiter', () => {
        it('pauses that queue for pauseQueueForSeconds and throws BullMQ’s RateLimitError', async () => {
          connectWorkers({
            defaultQueueConnection: queueConnection,
            defaultWorkerConnection: workerConnection,
            nativeBullMQ: {
              namedQueueOptions: { beta: {} },
              namedQueueWorkers: { beta: nativeWorkerOptions({ limiter: { max: 1, duration: 1000 } }) },
            },
          })

          expectRateLimitedQueue(queuesFor('beta')[0]!, await runRateLimitedJobOn('beta'))
        })
      })

      context('a named queue whose namedQueueWorkers entry sets no limiter', () => {
        it('fails the job with the misconfiguration error, naming that namedQueueWorkers entry', async () => {
          connectWorkers({
            defaultQueueConnection: queueConnection,
            defaultWorkerConnection: workerConnection,
            nativeBullMQ: {
              namedQueueOptions: { beta: {} },
              namedQueueWorkers: { beta: nativeWorkerOptions() },
            },
          })

          const err = await runRateLimitedJobOn('beta')
          expectMisconfigured(queuesFor('beta')[0]!, err)
          expect((err as Error).message).toContain('the `beta` queue')
          expect((err as Error).message).toContain(
            "set `limiter: { max, duration }` on `nativeBullMQ.namedQueueWorkers['beta']`",
          )
        })
      })

      context('the default queue with nativeBullMQ.defaultWorkerOptions.limiter', () => {
        it('pauses the default queue, since its workers carry that limiter', async () => {
          connectWorkers({
            defaultQueueConnection: queueConnection,
            defaultWorkerConnection: workerConnection,
            nativeBullMQ: {
              defaultWorkerOptions: nativeWorkerOptions({ limiter: { max: 1, duration: 1000 } }),
            },
          })

          expectRateLimitedQueue(
            queuesFor(Background.defaultQueueName)[0]!,
            await runRateLimitedJobOn(Background.defaultQueueName),
          )
        })
      })

      context('the default queue without a limiter', () => {
        it('fails the job with the misconfiguration error, telling the developer to move the job to a rate-limited named queue', async () => {
          connectWorkers({
            defaultQueueConnection: queueConnection,
            defaultWorkerConnection: workerConnection,
            nativeBullMQ: {},
          })

          const err = await runRateLimitedJobOn(Background.defaultQueueName)
          expectMisconfigured(queuesFor(Background.defaultQueueName)[0]!, err)
          expect((err as Error).message).toContain('the default queue')
          expect((err as Error).message).toContain(
            'move the job to a named queue whose `nativeBullMQ.namedQueueWorkers` entry sets',
          )
        })
      })
    })
  })

  /**
   * Under test invocation (`testInvocation: 'automatic'`, the default), a
   * backgrounded call runs the job in place and no worker exists, so the
   * per-queue record `connect` fills — whether the job's queue's workers would
   * carry a `limiter` — is the only thing that decides what the spec sees:
   * the untranslated `RateLimitedPsychicJob` where they would, the
   * misconfiguration error where they would not.
   */
  describe('thrown from a job under test invocation', () => {
    installBullMQRecorders()

    let queueConnection: Redis

    function connectWithoutWorkers(backgroundOptions: PsychicBackgroundOptions) {
      PsychicAppWorkers.getOrFail().set('background', backgroundOptions)
      const backgroundInstance = new Background()
      backgroundInstance.connect()
      return backgroundInstance
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function invoke(backgroundInstance: Background, jobConfig: BackgroundJobConfig<any>) {
      vi.spyOn(DummyService, 'classRunInBG').mockRejectedValue(
        new RateLimitedPsychicJob({ pauseQueueForSeconds: PAUSE_QUEUE_FOR_SECONDS }),
      )

      return backgroundInstance.staticMethod(DummyService, 'classRunInBG', {
        globalName: DummyService.globalName,
        args: ['howyadoin'],
        jobConfig,
      })
    }

    beforeEach(() => {
      expect(PsychicAppWorkers.getOrFail().testInvocation).toEqual('automatic')
      queueConnection = fakeRedisConnection('queue')
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    context('simple mode', () => {
      let backgroundInstance: Background

      beforeEach(() => {
        backgroundInstance = connectWithoutWorkers({
          defaultQueueConnection: queueConnection,
          defaultWorkerConnection: undefined,
          namedWorkstreams: [
            { name: 'limited', rateLimit: { max: 1, duration: 1000 } },
            { name: 'unlimited' },
          ],
        })
      })

      it('propagates RateLimitedPsychicJob untranslated from a workstream with rateLimit', async () => {
        await expect(invoke(backgroundInstance, { workstream: 'limited' })).rejects.toThrow(
          RateLimitedPsychicJob,
        )
      })

      it('raises the misconfiguration error from a workstream without rateLimit', async () => {
        await expect(invoke(backgroundInstance, { workstream: 'unlimited' })).rejects.toThrow(
          RateLimitedPsychicJobThrownFromWorkerWithoutLimiter,
        )
        await expect(invoke(backgroundInstance, { workstream: 'unlimited' })).rejects.toThrow(
          'set `rateLimit: { max, duration }` on the `unlimited` entry in `namedWorkstreams`',
        )
      })

      it('raises the misconfiguration error from the default workstream', async () => {
        await expect(invoke(backgroundInstance, {})).rejects.toThrow(
          RateLimitedPsychicJobThrownFromWorkerWithoutLimiter,
        )
        await expect(invoke(backgroundInstance, {})).rejects.toThrow('the default workstream')
      })

      it('propagates RateLimitedPsychicJob from the default workstream under a global defaultBullMQWorkerOptions.limiter', async () => {
        const limitedDefault = connectWithoutWorkers({
          defaultBullMQWorkerOptions: { limiter: { max: 10, duration: 1000 } },
          defaultQueueConnection: queueConnection,
          defaultWorkerConnection: undefined,
        })

        await expect(invoke(limitedDefault, {})).rejects.toThrow(RateLimitedPsychicJob)
      })
    })

    context('native BullMQ mode', () => {
      let backgroundInstance: Background

      beforeEach(() => {
        backgroundInstance = connectWithoutWorkers({
          defaultQueueConnection: queueConnection,
          nativeBullMQ: {
            namedQueueOptions: { limited: {}, unlimited: {} },
            namedQueueWorkers: {
              limited: nativeWorkerOptions({ limiter: { max: 1, duration: 1000 } }),
              unlimited: nativeWorkerOptions(),
            },
          },
        })
      })

      it('propagates RateLimitedPsychicJob untranslated from a queue whose namedQueueWorkers entry sets limiter', async () => {
        await expect(invoke(backgroundInstance, { queue: 'limited' })).rejects.toThrow(RateLimitedPsychicJob)
      })

      it('raises the misconfiguration error from a queue whose namedQueueWorkers entry sets no limiter', async () => {
        await expect(invoke(backgroundInstance, { queue: 'unlimited' })).rejects.toThrow(
          RateLimitedPsychicJobThrownFromWorkerWithoutLimiter,
        )
        await expect(invoke(backgroundInstance, { queue: 'unlimited' })).rejects.toThrow(
          "set `limiter: { max, duration }` on `nativeBullMQ.namedQueueWorkers['unlimited']`",
        )
      })

      it('raises the misconfiguration error from the default queue', async () => {
        await expect(invoke(backgroundInstance, {})).rejects.toThrow(
          RateLimitedPsychicJobThrownFromWorkerWithoutLimiter,
        )
        await expect(invoke(backgroundInstance, {})).rejects.toThrow('the default queue')
      })

      it('propagates RateLimitedPsychicJob from the default queue under nativeBullMQ.defaultWorkerOptions.limiter', async () => {
        const limitedDefault = connectWithoutWorkers({
          defaultQueueConnection: queueConnection,
          nativeBullMQ: {
            defaultWorkerOptions: nativeWorkerOptions({ limiter: { max: 1, duration: 1000 } }),
          },
        })

        await expect(invoke(limitedDefault, {})).rejects.toThrow(RateLimitedPsychicJob)
      })
    })
  })
})
