import { Job } from 'bullmq'
import background, { Background } from '../../../src/background/index.js'
import NoClassForSpecifiedGlobalName from '../../../src/error/background/NoClassForSpecifiedGlobalName.js'
import { BackgroundJobData, JobTypes } from '../../../src/types/background.js'
import createUser from '../../../test-app/spec/factories/UserFactory.js'
import User from '../../../test-app/src/app/models/User.js'

describe('background (app singleton)', () => {
  describe('.doWork', () => {
    function buildJob(jobType: JobTypes, jobData: BackgroundJobData) {
      const queue = new Background.Queue('TestQueue', { connection: {} })
      return new Job(queue, jobType, jobData, {})
    }

    context('BackgroundJobQueueStaticJob', () => {
      context('when the globalName no longer resolves to a class', () => {
        it('throws NoClassForSpecifiedGlobalName so the job is marked failed rather than completed', async () => {
          const job = buildJob('BackgroundJobQueueStaticJob', {
            globalName: 'services/ClassThatNoLongerExists',
            method: 'classRunInBG',
            args: ['bottlearum'],
          })

          await expect(background.doWork(job)).rejects.toThrow(NoClassForSpecifiedGlobalName)
        })

        it('includes the unresolvable globalName in the error message', async () => {
          const job = buildJob('BackgroundJobQueueStaticJob', {
            globalName: 'services/ClassThatNoLongerExists',
            method: 'classRunInBG',
            args: ['bottlearum'],
          })

          await expect(background.doWork(job)).rejects.toThrow('services/ClassThatNoLongerExists')
        })
      })

      context('when the job data is missing a globalName', () => {
        it('throws NoClassForSpecifiedGlobalName', async () => {
          const job = buildJob('BackgroundJobQueueStaticJob', {
            method: 'classRunInBG',
            args: ['bottlearum'],
          })

          await expect(background.doWork(job)).rejects.toThrow(NoClassForSpecifiedGlobalName)
        })
      })
    })

    context('BackgroundJobQueueModelInstanceJob', () => {
      context('when the globalName no longer resolves to a class', () => {
        it('throws NoClassForSpecifiedGlobalName so the job is marked failed rather than completed', async () => {
          const job = buildJob('BackgroundJobQueueModelInstanceJob', {
            globalName: 'ModelThatNoLongerExists',
            id: '123',
            method: 'testBackground',
            args: ['howyadoin'],
          })

          await expect(background.doWork(job)).rejects.toThrow(NoClassForSpecifiedGlobalName)
        })
      })

      context('when the model instance is not found', () => {
        it('returns without error (the record may have been legitimately deleted)', async () => {
          const job = buildJob('BackgroundJobQueueModelInstanceJob', {
            globalName: 'User',
            id: '9999999',
            method: 'testBackground',
            args: ['howyadoin'],
          })

          await expect(background.doWork(job)).resolves.toBeUndefined()
        })
      })

      context('when the class resolves and the model instance is found', () => {
        it('calls the specified method on the instance', async () => {
          const user = await createUser()
          vi.spyOn(User.prototype, '_testBackground')

          const job = buildJob('BackgroundJobQueueModelInstanceJob', {
            globalName: 'User',
            id: user.id,
            method: 'testBackground',
            args: ['howyadoin'],
          })

          await background.doWork(job)

          // eslint-disable-next-line @typescript-eslint/unbound-method
          expect(User.prototype._testBackground).toHaveBeenCalledWith(user.id, 'howyadoin', job)
        })
      })
    })
  })
})
