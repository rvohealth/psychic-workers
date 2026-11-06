import { GlobalNameNotSet } from '@rvoh/dream/errors'
import { Job } from 'bullmq'
import BaseBackgroundedService from '../../../src/background/BaseBackgroundedService.js'
import background from '../../../src/background/index.js'
import PsychicAppWorkers, {
  PsychicWorkersAppTestInvocationType,
} from '../../../src/psychic-app-workers/index.js'
import WorkerTestUtils from '../../../src/test-utils/WorkerTestUtils.js'
import { BackgroundJobConfig } from '../../../src/types/background.js'
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

describe('background service registration', () => {
  describe('.globalName', () => {
    it('rejects a class with no registration', () => {
      class Unregistered extends BaseBackgroundedService {}
      expect(() => Unregistered.globalName).toThrow(GlobalNameNotSet)
    })

    it('rejects an empty registration, including on a registered parent’s child', () => {
      class Parent extends BaseBackgroundedService {}
      class Child extends Parent {}
      Parent.setGlobalName('services/Parent')
      Child.setGlobalName('')
      expect(() => Child.globalName).toThrow(GlobalNameNotSet)
      expect(Parent.globalName).toEqual('services/Parent')
    })

    it('rejects unregistered children and grandchildren of a registered ancestor', () => {
      class Parent extends BaseBackgroundedService {}
      class Child extends Parent {}
      class Grandchild extends Child {}
      Parent.setGlobalName('services/Parent')
      expect(() => Child.globalName).toThrow(GlobalNameNotSet)
      expect(() => Grandchild.globalName).toThrow(GlobalNameNotSet)
    })

    it('keeps parent and child registrations independent when either is registered again', () => {
      class Parent extends BaseBackgroundedService {}
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
            const services = PsychicAppWorkers.getOrFail().psychicApp.services
            const parentName = 'services/RegistrationParent'
            const childName = 'services/RegistrationChild'
            const previousParent: unknown = services[parentName]
            const previousChild: unknown = services[childName]
            Parent.setGlobalName(parentName)
            Child.setGlobalName(childName)
            services[parentName] = Parent
            services[childName] = Child

            try {
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
            } finally {
              if (previousParent === undefined) delete services[parentName]
              else services[parentName] = previousParent
              if (previousChild === undefined) delete services[childName]
              else services[childName] = previousChild
            }
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
    })
  }
})
