import { Redis } from 'ioredis'
import nameToRedisQueueName from '../../../src/background/helpers/nameToRedisQueueName.js'
import { Background, background, PsychicAppWorkers } from '../../../src/package-exports/index.js'
import { PsychicBackgroundOptions } from '../../../src/types/background.js'
import DefaultDummyScheduledService from '../../../test-app/src/app/services/DefaultDummyScheduledService.js'
import { fakeRedisConnection, installBullMQRecorders } from '../../helpers/bullmqRecorders.js'

describe('unscheduling a scheduled job', () => {
  const bullmq = installBullMQRecorders()

  let queueConnection: Redis
  let workerConnection: Redis
  let backgroundInstance: Background

  const backgroundOptions = (): PsychicBackgroundOptions => ({
    defaultQueueConnection: queueConnection,
    defaultWorkerConnection: workerConnection,
    namedWorkstreams: [{ name: 'alpha', workerCount: 1 }],
    transitionalWorkstreams: {
      defaultQueueConnection: queueConnection,
      defaultWorkerConnection: workerConnection,
      namedWorkstreams: [{ name: 'alpha', workerCount: 1 }],
    },
  })

  /**
   * both the current and the transitional topology build a queue for every
   * logical name, so this returns them in construction order: current first,
   * transitional second
   */
  function queuesNamed(workstream?: string) {
    const queueName = nameToRedisQueueName(workstream ?? Background.defaultQueueName, queueConnection)
    return bullmq.queues.filter(queue => queue.queueName === queueName)
  }

  beforeEach(() => {
    queueConnection = fakeRedisConnection('queue')
    workerConnection = fakeRedisConnection('worker')

    PsychicAppWorkers.getOrFail().set('background', backgroundOptions())
    PsychicAppWorkers.getOrFail().set('testInvocation', 'manual')

    backgroundInstance = new Background()
    backgroundInstance.connect()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('unscheduleId', () => {
    it('is the id the job is scheduled under', async () => {
      const id = DefaultDummyScheduledService.unscheduleId('classRunInBg')
      expect(id).toEqual('services/DefaultDummyScheduledService:classRunInBg')

      await backgroundInstance.scheduledMethod(DefaultDummyScheduledService, '* * * * *', 'classRunInBg', {
        globalName: DefaultDummyScheduledService.globalName,
      })

      expect(queuesNamed()[0]!.jobSchedulers[0]![0]).toEqual(id)
    })

    it('does not connect to redis', () => {
      const disconnected = new Background()
      expect(DefaultDummyScheduledService.unscheduleId('classRunInBg')).toEqual(
        'services/DefaultDummyScheduledService:classRunInBg',
      )
      expect(disconnected.queues).toHaveLength(0)
    })
  })

  describe('BaseScheduledService.unschedule', () => {
    it('unschedules the id through the background singleton', async () => {
      vi.spyOn(background, 'unschedule').mockResolvedValue(true)

      expect(
        await DefaultDummyScheduledService.unschedule(
          DefaultDummyScheduledService.unscheduleId('classRunInBg'),
        ),
      ).toBe(true)

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(background.unschedule).toHaveBeenCalledWith('services/DefaultDummyScheduledService:classRunInBg')
    })
  })

  describe('Background#unschedule', () => {
    it('removes a scheduled job and reports that it did', async () => {
      await backgroundInstance.scheduledMethod(DefaultDummyScheduledService, '* * * * *', 'classRunInBg', {
        globalName: DefaultDummyScheduledService.globalName,
      })
      expect(queuesNamed()[0]!.jobSchedulers).toHaveLength(1)

      expect(await backgroundInstance.unschedule('services/DefaultDummyScheduledService:classRunInBg')).toBe(
        true,
      )
      expect(queuesNamed()[0]!.jobSchedulers).toHaveLength(0)
    })

    it('reports false when no such job is scheduled', async () => {
      expect(await backgroundInstance.unschedule('services/NeverScheduled:classRunInBg')).toBe(false)
    })

    it('finds the job in a named workstream, even though it was never routed there', async () => {
      await backgroundInstance.scheduledMethod(DefaultDummyScheduledService, '* * * * *', 'classRunInBg', {
        globalName: DefaultDummyScheduledService.globalName,
        jobConfig: { workstream: 'alpha' },
      })
      expect(queuesNamed('alpha')[0]!.jobSchedulers).toHaveLength(1)

      expect(await backgroundInstance.unschedule('services/DefaultDummyScheduledService:classRunInBg')).toBe(
        true,
      )
      expect(queuesNamed('alpha')[0]!.jobSchedulers).toHaveLength(0)
    })

    it('checks transitional queues as well as current ones', async () => {
      const transitionalQueue = queuesNamed('alpha')[1]!
      await transitionalQueue.upsertJobScheduler('services/DefaultDummyScheduledService:classRunInBg')

      expect(await backgroundInstance.unschedule('services/DefaultDummyScheduledService:classRunInBg')).toBe(
        true,
      )
      expect(transitionalQueue.jobSchedulers).toHaveLength(0)
    })

    it('leaves other scheduled jobs alone', async () => {
      await backgroundInstance.scheduledMethod(DefaultDummyScheduledService, '* * * * *', 'classRunInBg', {
        globalName: DefaultDummyScheduledService.globalName,
      })

      expect(await backgroundInstance.unschedule('services/SomeOtherService:classRunInBg')).toBe(false)
      expect(queuesNamed()[0]!.jobSchedulers).toHaveLength(1)
    })
  })
})
