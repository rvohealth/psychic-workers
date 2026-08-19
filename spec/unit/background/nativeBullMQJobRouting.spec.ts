import { Queue, Worker } from 'bullmq'
import { Redis } from 'ioredis'
import nameToRedisQueueName from '../../../src/background/helpers/nameToRedisQueueName.js'
import NoQueueForSpecifiedQueueName from '../../../src/error/background/NoQueueForSpecifiedQueueName.js'
import NoQueueForSpecifiedWorkstream from '../../../src/error/background/NoQueueForSpecifiedWorkstream.js'
import { Background, PsychicAppWorkers } from '../../../src/package-exports/index.js'
import { BackgroundJobConfig, PsychicBackgroundOptions } from '../../../src/types/background.js'
import DummyService from '../../../test-app/src/app/services/DummyService.js'
import {
  fakeRedisConnection,
  nativeWorkerOptions,
  RecordingQueue,
  RecordingWorker,
} from '../../helpers/bullmqRecorders.js'

describe('Background#queueInstance routing in native BullMQ mode', () => {
  let queueConnection: Redis
  let workerConnection: Redis
  let backgroundInstance: Background

  const nativeBackgroundOptions = (): PsychicBackgroundOptions => ({
    defaultQueueConnection: queueConnection,
    defaultWorkerConnection: workerConnection,
    nativeBullMQ: {
      namedQueueOptions: { alpha: {}, beta: {} },
      namedQueueWorkers: { alpha: nativeWorkerOptions(), beta: nativeWorkerOptions() },
    },
  })

  function connectNative() {
    PsychicAppWorkers.getOrFail().set('background', nativeBackgroundOptions())
    backgroundInstance = new Background()
    backgroundInstance.connect()
    return backgroundInstance
  }

  function queueNamed(queueName: string) {
    return RecordingQueue.constructed.find(
      queue => queue.queueName === nameToRedisQueueName(queueName, queueConnection),
    )!
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function background(jobConfig: BackgroundJobConfig<any>) {
    await backgroundInstance.staticMethod(DummyService, 'classRunInBG', {
      globalName: 'services/DummyService',
      args: ['bottlearum'],
      jobConfig,
    })
  }

  beforeEach(() => {
    RecordingQueue.reset()
    RecordingWorker.reset()

    vi.spyOn(Background, 'Queue', 'get').mockReturnValue(RecordingQueue as unknown as typeof Queue)
    vi.spyOn(Background, 'Worker', 'get').mockReturnValue(RecordingWorker as unknown as typeof Worker)

    queueConnection = fakeRedisConnection('queue')
    workerConnection = fakeRedisConnection('worker')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  context('with testInvocation set to manual, so jobs are really enqueued', () => {
    beforeEach(() => {
      PsychicAppWorkers.getOrFail().set('testInvocation', 'manual')
      connectNative()
    })

    it('routes to the named queue identified by `queue`', async () => {
      await background({ queue: 'beta' })

      expect(queueNamed('beta').adds.length).toEqual(1)
      expect(queueNamed('beta').adds[0]!.jobType).toEqual('BackgroundJobQueueStaticJob')
      expect(queueNamed('alpha').adds.length).toEqual(0)
      expect(queueNamed(Background.defaultQueueName).adds.length).toEqual(0)
    })

    it('routes to the default queue when `queue` is omitted', async () => {
      await background({})

      expect(queueNamed(Background.defaultQueueName).adds.length).toEqual(1)
      expect(queueNamed('alpha').adds.length).toEqual(0)
      expect(queueNamed('beta').adds.length).toEqual(0)
    })

    it('resolves `workstream` against the same named queue map, even in native mode', async () => {
      // the generated types forbid `workstream` in native mode, but the runtime
      // indexes one map for both forms, so a named queue name resolves either way
      await background({ workstream: 'alpha' })

      expect(queueNamed('alpha').adds.length).toEqual(1)
    })

    it('routes a scheduled job to the named queue identified by `queue`', async () => {
      await backgroundInstance.scheduledMethod(DummyService, '* * * * *', 'classRunInBG', {
        globalName: 'services/DummyService',
        args: ['bottlearum'],
        jobConfig: { queue: 'beta' },
      })

      expect(queueNamed('beta').jobSchedulers.length).toEqual(1)
      expect(queueNamed('beta').jobSchedulers[0]![0]).toEqual('services/DummyService:classRunInBG')
      expect(queueNamed('alpha').jobSchedulers.length).toEqual(0)
      expect(queueNamed(Background.defaultQueueName).jobSchedulers.length).toEqual(0)
    })

    context('priority', () => {
      it('writes a top-level priority when there is no group id', async () => {
        await background({ queue: 'alpha', priority: 'urgent' })

        expect(queueNamed('alpha').adds[0]!.opts).toEqual({ group: undefined, priority: 1 })
        // `toEqual` ignores undefined-valued keys on both sides, so the `group:
        // undefined` above cannot tell "written as undefined" from "never
        // written". The key really is written, so assert its presence outright.
        expect(queueNamed('alpha').adds[0]!.opts).toHaveProperty('group')
      })

      it('defaults to `default` priority', async () => {
        await background({ queue: 'alpha' })

        expect(queueNamed('alpha').adds[0]!.opts).toEqual({ group: undefined, priority: 2 })
        expect(queueNamed('alpha').adds[0]!.opts).toHaveProperty('group')
      })

      it('moves the priority into the group and writes no top-level priority when a group id is present', async () => {
        await background({ queue: 'alpha', groupId: 'alphaGroup', priority: 'not_urgent' })

        expect(queueNamed('alpha').adds[0]!.opts).toEqual({
          group: { id: 'alphaGroup', priority: 3 },
        })
        expect(queueNamed('alpha').adds[0]!.opts).not.toHaveProperty('priority')
      })

      it('maps `last` to 4', async () => {
        await background({ queue: 'alpha', priority: 'last' })

        expect(queueNamed('alpha').adds[0]!.opts).toEqual({ group: undefined, priority: 4 })
        expect(queueNamed('alpha').adds[0]!.opts).toHaveProperty('group')
      })

      it('treats a workstream name as the group id', async () => {
        await background({ workstream: 'alpha', priority: 'urgent' })

        expect(queueNamed('alpha').adds[0]!.opts).toEqual({ group: { id: 'alpha', priority: 1 } })
      })
    })
  })

  context('with the default automatic test invocation', () => {
    beforeEach(() => {
      connectNative()
    })

    it('invokes the job immediately instead of adding it to the routed queue', async () => {
      await background({ queue: 'alpha' })

      expect(queueNamed('alpha').adds.length).toEqual(0)
      // `_addToQueue` builds a throwaway queue named `TestQueue` (the literal is
      // owned by src/background/index.ts) to construct the Job it invokes
      // directly, and `RecordingQueue.constructed` filters it back out
      expect(RecordingQueue.instances.map(queue => queue.queueName)).toContain('TestQueue')
      expect(RecordingQueue.constructed.map(queue => queue.queueName)).not.toContain('TestQueue')
    })

    it('raises for an unrecognized queue name before short-circuiting job invocation', async () => {
      await expect(background({ queue: 'ghost' })).rejects.toThrow(NoQueueForSpecifiedQueueName)
    })

    it('raises for an unrecognized workstream name before short-circuiting job invocation', async () => {
      await expect(background({ workstream: 'ghost' })).rejects.toThrow(NoQueueForSpecifiedWorkstream)
    })
  })
})
