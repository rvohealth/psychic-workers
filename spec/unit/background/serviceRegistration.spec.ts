import { GlobalNameNotSet } from '@rvoh/dream/errors'
import { Job } from 'bullmq'
import BaseBackgroundedService from '../../../src/background/BaseBackgroundedService.js'
import BaseScheduledService from '../../../src/background/BaseScheduledService.js'
import background from '../../../src/background/index.js'
import PsychicAppWorkers, {
  PsychicWorkersAppTestInvocationType,
} from '../../../src/psychic-app-workers/index.js'
import WorkerTestUtils from '../../../src/test-utils/WorkerTestUtils.js'
import { BackgroundJobConfig } from '../../../src/types/background.js'
import DefaultDummyScheduledService from '../../../test-app/src/app/services/DefaultDummyScheduledService.js'
import DummyService from '../../../test-app/src/app/services/DummyService.js'

const entryPoints = [
  {
    name: 'background',
    delayed: false,
    invoke: (service: typeof DummyService) => service.background('classRunInBG', 'registration'),
  },
  {
    name: 'backgroundWith',
    delayed: true,
    invoke: (service: typeof DummyService) =>
      service.backgroundWith({ delay: { seconds: 25 } }, 'classRunInBG', 'registration'),
  },
  {
    name: 'backgroundWithDelay',
    delayed: true,
    invoke: (service: typeof DummyService) =>
      service.backgroundWithDelay({ seconds: 25 }, 'classRunInBG', 'registration'),
  },
]

/**
 * the static registration surface the two service bases share, so that one
 * set of examples can subclass either base
 */
type RegistrableServiceBase = (abstract new () => object) & {
  readonly globalName: string
  setGlobalName(globalName: string): void
}

const serviceBases: { name: string; Base: RegistrableServiceBase }[] = [
  { name: 'BaseBackgroundedService', Base: BaseBackgroundedService },
  { name: 'BaseScheduledService', Base: BaseScheduledService },
]

/**
 * registers the given classes in the psychic app's service registry, the way
 * psychic's service loader would, runs the block, then restores whatever was
 * registered under those names before
 */
async function withRegisteredServices(
  registrations: Record<string, { setGlobalName(globalName: string): void }>,
  block: () => Promise<void>,
) {
  const services = PsychicAppWorkers.getOrFail().psychicApp.services
  const previous: Record<string, unknown> = {}
  for (const [globalName, serviceClass] of Object.entries(registrations)) {
    previous[globalName] = services[globalName]
    serviceClass.setGlobalName(globalName)
    services[globalName] = serviceClass
  }

  try {
    await block()
  } finally {
    for (const globalName of Object.keys(registrations)) {
      if (previous[globalName] === undefined) delete services[globalName]
      else services[globalName] = previous[globalName]
    }
  }
}

describe('service registration', () => {
  for (const { name, Base } of serviceBases) {
    describe(`${name}.globalName`, () => {
      it('rejects a class with no registration', () => {
        class Unregistered extends Base {}
        expect(() => Unregistered.globalName).toThrow(GlobalNameNotSet)
      })

      it('rejects an empty registration, including on a registered parent’s child', () => {
        class Parent extends Base {}
        class Child extends Parent {}
        Parent.setGlobalName('services/Parent')
        Child.setGlobalName('')
        expect(() => Child.globalName).toThrow(GlobalNameNotSet)
        expect(Parent.globalName).toEqual('services/Parent')
      })

      it('rejects unregistered children and grandchildren of a registered ancestor', () => {
        class Parent extends Base {}
        class Child extends Parent {}
        class Grandchild extends Child {}
        Parent.setGlobalName('services/Parent')
        expect(() => Child.globalName).toThrow(GlobalNameNotSet)
        expect(() => Grandchild.globalName).toThrow(GlobalNameNotSet)
      })

      it('keeps parent and child registrations independent when either is registered again', () => {
        class Parent extends Base {}
        class Child extends Parent {}
        Parent.setGlobalName('services/Parent')
        Child.setGlobalName('services/Child')
        Parent.setGlobalName('services/RenamedParent')
        expect(Child.globalName).toEqual('services/Child')
        Child.setGlobalName('services/RenamedChild')
        expect(Parent.globalName).toEqual('services/RenamedParent')
        expect(Child.globalName).toEqual('services/RenamedChild')
      })
    })
  }

  for (const mode of ['automatic', 'manual'] as const) {
    describe(`with ${mode} test invocation`, () => {
      let originalTestInvocation: PsychicWorkersAppTestInvocationType

      beforeEach(async () => {
        const workersApp = PsychicAppWorkers.getOrFail()
        originalTestInvocation = workersApp.testInvocation
        workersApp.set('testInvocation', mode)
        await WorkerTestUtils.clean()
      })

      afterEach(async () => {
        PsychicAppWorkers.getOrFail().set('testInvocation', originalTestInvocation)
        vi.restoreAllMocks()
        await WorkerTestUtils.clean()
      })

      for (const entry of entryPoints) {
        describe(`.${entry.name}`, () => {
          it('rejects an unregistered child before dispatch, queueing, or parent method effects', async () => {
            class UnregisteredChild extends DummyService {}
            const dispatch = vi.spyOn(background, 'staticMethod')
            const parentMethod = vi.spyOn(DummyService, 'classRunInBG').mockResolvedValue()
            const queueAdds = background.queues.map(queue =>
              vi.spyOn(queue, 'add').mockResolvedValue({} as Job),
            )

            await expect(entry.invoke(UnregisteredChild)).rejects.toThrow(GlobalNameNotSet)

            expect(dispatch).not.toHaveBeenCalled()
            expect(parentMethod).not.toHaveBeenCalled()
            for (const add of queueAdds) expect(add).not.toHaveBeenCalled()
          })

          it('dispatches each registered class with its own identity and inherited method/config', async () => {
            const calls: { globalName: string; arg: string }[] = []
            class Parent extends DummyService {
              public static override get backgroundJobConfig(): BackgroundJobConfig<BaseBackgroundedService> {
                return { priority: 'urgent' }
              }

              public static override async classRunInBG(arg: string) {
                await Promise.resolve()
                calls.push({ globalName: this.globalName, arg })
              }
            }
            class Child extends Parent {}
            const parentName = 'services/RegistrationParent'
            const childName = 'services/RegistrationChild'

            await withRegisteredServices({ [parentName]: Parent, [childName]: Child }, async () => {
              const added = vi.spyOn(background.queues[0]!, 'add')
              await entry.invoke(Parent)
              await entry.invoke(Child)

              if (mode === 'manual') {
                expect(calls).toEqual([])
                expect(added).toHaveBeenCalledWith(
                  'BackgroundJobQueueStaticJob',
                  { globalName: childName, method: 'classRunInBG', args: ['registration'] },
                  { priority: 1, ...(entry.delayed ? { delay: 25000 } : {}) },
                )
                if (entry.delayed) await WorkerTestUtils.workScheduled()
                else await WorkerTestUtils.work()
              }

              expect(calls).toEqual([
                { globalName: parentName, arg: 'registration' },
                { globalName: childName, arg: 'registration' },
              ])
            })
          })

          if (mode === 'automatic') {
            it('awaits asynchronous method completion', async () => {
              let release!: () => void
              let started!: () => void
              const completion = new Promise<void>(resolve => {
                release = resolve
              })
              const entered = new Promise<void>(resolve => {
                started = resolve
              })
              const method = vi.spyOn(DummyService, 'classRunInBG').mockImplementation(async () => {
                started()
                await completion
              })
              let settled = false
              const invocation = entry.invoke(DummyService).then(() => {
                settled = true
              })

              try {
                await entered
                // Let any prematurely resolved dispatch promise settle before releasing the method.
                await new Promise<void>(resolve => setImmediate(resolve))
                expect(method).toHaveBeenCalled()
                expect(settled).toBe(false)
              } finally {
                release()
                await invocation
              }
              expect(settled).toBe(true)
            })
          }
        })
      }

      describe('scheduled services', () => {
        it('schedule rejects an unregistered child before connecting or upserting a scheduler', async () => {
          class UnregisteredChild extends DefaultDummyScheduledService {}
          const connect = vi.spyOn(background, 'connect')
          const scheduledMethod = vi.spyOn(background, 'scheduledMethod')
          const parentMethod = vi.spyOn(DefaultDummyScheduledService, 'classRunInBg').mockReturnValue()
          const upserts = background.queues.map(queue =>
            vi.spyOn(queue, 'upsertJobScheduler').mockResolvedValue({} as Job),
          )
          expect(upserts.length).toBeGreaterThan(0)

          await expect(
            UnregisteredChild.schedule('0 * * * *', 'classRunInBg', 'registration'),
          ).rejects.toThrow(GlobalNameNotSet)

          expect(connect).not.toHaveBeenCalled()
          expect(scheduledMethod).not.toHaveBeenCalled()
          expect(parentMethod).not.toHaveBeenCalled()
          for (const upsert of upserts) expect(upsert).not.toHaveBeenCalled()
        })

        it('unscheduleId rejects an unregistered child', () => {
          class UnregisteredChild extends DefaultDummyScheduledService {}
          expect(() => UnregisteredChild.unscheduleId('classRunInBg')).toThrow(GlobalNameNotSet)
        })

        it('unschedule(id) is unaffected by the class it is called on', async () => {
          class UnregisteredChild extends DefaultDummyScheduledService {}
          const parentId = DefaultDummyScheduledService.unscheduleId('classRunInBg')
          await DefaultDummyScheduledService.schedule('0 * * * *', 'classRunInBg', 'registration')

          expect(await UnregisteredChild.unschedule(parentId)).toBe(true)
          expect(await UnregisteredChild.unschedule(parentId)).toBe(false)
        })

        it('schedules each registered class under its own id, and each runs its own class', async () => {
          const calls: { globalName: string; arg: string }[] = []
          class Parent extends DefaultDummyScheduledService {
            public static override get backgroundJobConfig(): BackgroundJobConfig<BaseScheduledService> {
              return { priority: 'urgent' }
            }

            public static async recordRun(arg: string) {
              await Promise.resolve()
              calls.push({ globalName: this.globalName, arg })
            }
          }
          class Child extends Parent {}
          const parentName = 'services/RegistrationScheduledParent'
          const childName = 'services/RegistrationScheduledChild'

          await withRegisteredServices({ [parentName]: Parent, [childName]: Child }, async () => {
            background.connect()
            const upsert = vi.spyOn(background.queues[0]!, 'upsertJobScheduler')

            await Parent.schedule('0 * * * *', 'recordRun', 'parent run')
            await Child.schedule('0 * * * *', 'recordRun', 'child run')

            expect(Parent.unscheduleId('recordRun')).toEqual(`${parentName}:recordRun`)
            expect(Child.unscheduleId('recordRun')).toEqual(`${childName}:recordRun`)
            for (const [globalName, arg] of [
              [parentName, 'parent run'],
              [childName, 'child run'],
            ] as const) {
              expect(upsert).toHaveBeenCalledWith(
                `${globalName}:recordRun`,
                { pattern: '0 * * * *', tz: 'UTC' },
                {
                  name: 'BackgroundJobQueueStaticJob',
                  opts: { priority: 1 },
                  data: { globalName, method: 'recordRun', args: [arg] },
                },
              )
            }

            // registration only: scheduling never invokes the method, in either mode
            expect(calls).toEqual([])

            await WorkerTestUtils.workScheduled()

            expect(calls).toHaveLength(2)
            expect(calls).toEqual(
              expect.arrayContaining([
                { globalName: parentName, arg: 'parent run' },
                { globalName: childName, arg: 'child run' },
              ]),
            )
          })
        })
      })
    })
  }
})
