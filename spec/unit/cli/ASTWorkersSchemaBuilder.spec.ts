import { CliFileWriter, DreamCLI } from '@rvoh/dream/system'
import { Redis } from 'ioredis'
import ASTWorkersSchemaBuilder from '../../../src/cli/ASTWorkersSchemaBuilder.js'
import DefaultBullMQNativeOptionsMissingQueueConnectionAndDefaultQueueConnection from '../../../src/error/background/DefaultBullMQNativeOptionsMissingQueueConnectionAndDefaultQueueConnection.js'
import { Background, background, PsychicAppWorkers } from '../../../src/package-exports/index.js'
import { PsychicBackgroundOptions } from '../../../src/types/background.js'
import {
  fakeRedisConnection,
  installBullMQRecorders,
  nativeWorkerOptions,
} from '../../helpers/bullmqRecorders.js'

/**
 * `pnpm psy sync` builds src/types/workers.ts by connecting the `background`
 * singleton and reading the queue/workstream maps it populated, so background
 * misconfiguration surfaces at sync time rather than at boot.
 *
 * These specs must use the singleton, since ASTWorkersSchemaBuilder imports it
 * directly. The global spec hook has already connected it, so it is reset here
 * before and after each example.
 */
describe('ASTWorkersSchemaBuilder#build', () => {
  installBullMQRecorders()

  let queueConnection: Redis
  let workerConnection: Redis
  let writtenFiles: { filepath: string; contents: string }[]

  interface BackgroundInternals {
    defaultQueue: unknown
    defaultTransitionalQueue: unknown
    namedQueues: Record<string, unknown>
    namedTransitionalQueues: Record<string, unknown>
    groupNames: Record<string, string[]>
    workstreamNames: string[]
    _workers: unknown[]
    redisConnections: unknown[]
  }

  function resetBackgroundSingleton() {
    const internals = background as unknown as BackgroundInternals
    internals.defaultQueue = null
    internals.defaultTransitionalQueue = null
    internals.namedQueues = {}
    internals.namedTransitionalQueues = {}
    internals.groupNames = {}
    internals.workstreamNames = []
    internals._workers = []
    internals.redisConnections = []
  }

  async function buildWith(backgroundOptions: PsychicBackgroundOptions) {
    PsychicAppWorkers.getOrFail().set('background', backgroundOptions)
    await new ASTWorkersSchemaBuilder().build()
    return writtenFiles[0]!
  }

  beforeEach(() => {
    resetBackgroundSingleton()

    vi.spyOn(DreamCLI.logger, 'logProgress').mockImplementation(
      async (_text: string, cb: () => void | Promise<void>) => {
        await cb()
      },
    )
    writtenFiles = []
    vi.spyOn(CliFileWriter, 'write').mockImplementation((filepath: string, contents: string) => {
      writtenFiles.push({ filepath, contents })
      return Promise.resolve()
    })

    queueConnection = fakeRedisConnection('queue')
    workerConnection = fakeRedisConnection('worker')
  })

  afterEach(() => {
    resetBackgroundSingleton()
    vi.restoreAllMocks()
  })

  context('in native BullMQ mode', () => {
    it('writes a queueGroupMap keyed by named queue, and an empty workstreamNames', async () => {
      const written = await buildWith({
        defaultQueueConnection: queueConnection,
        defaultWorkerConnection: workerConnection,
        nativeBullMQ: {
          namedQueueOptions: { alpha: {}, beta: {} },
          namedQueueWorkers: {
            alpha: nativeWorkerOptions({ group: { id: 'alphaGroup' } }),
            beta: nativeWorkerOptions(),
          },
        },
      })

      expect(written.filepath).toMatch(/types\/workers\.ts$/)
      expect(written.contents).toMatch(/workstreamNames:\s*\[\]/)
      // every named queue gets a key, so it is a legal `backgroundJobConfig.queue`
      // value, whether or not any group ids were configured for it
      expect(written.contents).toMatch(/alpha:\s*\['alphaGroup'\]/)
      expect(written.contents).toMatch(/beta:\s*\[\]/)
      // the default queue is never named in queueGroupMap; you target it by
      // omitting `queue` altogether
      expect(written.contents).not.toContain(Background.defaultQueueName)
    })

    context('when no queue connection can be resolved', () => {
      it('rejects with the missing-queue-connection error at sync time', async () => {
        await expect(buildWith({ nativeBullMQ: {} })).rejects.toThrow(
          DefaultBullMQNativeOptionsMissingQueueConnectionAndDefaultQueueConnection,
        )
      })
    })
  })

  context('in simple (workstream) mode', () => {
    it('writes workstreamNames and an empty queueGroupMap', async () => {
      const written = await buildWith({
        defaultQueueConnection: queueConnection,
        defaultWorkerConnection: workerConnection,
        namedWorkstreams: [{ workerCount: 1, name: 'snazzy' }],
      })

      expect(written.contents).toMatch(/workstreamNames:\s*\['snazzy'\]/)
      expect(written.contents).toMatch(/queueGroupMap:\s*\{\}/)
    })
  })
})
