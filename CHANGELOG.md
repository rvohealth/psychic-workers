## 2.7.0

- fix: `WorkerTestUtils.work()` and `workScheduled()` can now find a queue built under a `Cluster` connection when called with a `queue` name. The internal comparison opened a brace for the cluster case (`` `{${name}` ``) and never closed it, so it never equalled a queue's real cluster-mode name — `work({ queue })` iterated no queues and returned having worked nothing, rather than raising. Both now resolve the expected name through `nameToRedisQueueName`, the same function the package uses to build it.
- fix: `WorkerTestUtils.clean()` now also clears `active` jobs. `drain()` does not touch that set, so a job fetched by hand and never moved on outlived the process and was counted by the next run of the suite. A job whose lock is still held is left alone.
- fix: a debounced delayed job — one enqueued with a `jobId` — is no longer skipped. The deduplication key's lifetime was pinned equal to the delay, so it could outlive the job it guarded, and a call arriving in that gap enqueued nothing after the job had already run. The key's `ttl` is now the delay minus one second. This changes behaviour: a burst that previously collapsed into one run may now produce two, and calls landing in that last second stop collapsing — a flat second whatever the delay, so longer delays are cheaper. A suite asserting the enqueued job options will need its `ttl` expectations updated.
- a delay object now requires at least one of `seconds`, `minutes`, `hours` or `days`, at compile time: `backgroundWith({ delay: {} }, …)` and `{ delay: { jobId: 'x' } }` stop compiling, as does a duration that is only optional at the type level (one read from config, an env var or a nullable column). Narrow the value at the call site. A delay carrying a `jobId` is additionally refused at enqueue unless it is at least three seconds, is non-empty, and — on a rate-limited workstream — satisfies `delay - 1s >= duration / max`, so `{ max: 1, duration: 60000 }` needs a 61-second delay. A delay carrying no `jobId` is unaffected.
- asking for workers — `background.work()`, or `connect({ activateWorkers: true })` — now starts them in a process that had already connected, and raises instead of returning quietly when that process has no `defaultWorkerConnection`. Activation used to live inside `connect`'s build guard, so a process that connected first for any reason (a webserver, or a scheduled service registering itself) built no workers, with no error and no log line. Such a process now comes up consuming, so a fleet sized on the assumption that it consumed nothing will change on upgrade; a web process that calls `work()` without a worker connection now throws at that call site.
- `rateLimit` on a named workstream now rate limits on open-source BullMQ, not only BullMQ Pro: it is written as BullMQ's worker `limiter`, enforced per queue, so `{ max: 1, duration: 1000 }` means one job per second across every worker and process. Previously it was written only as Pro's group limit and silently did nothing. `max` and `duration` are now both required when `rateLimit` is given, so a partial one is a compile error; one that still reaches `connect()` without positive integers fails `connect()` naming the workstream and field, before any queue or worker is built.
- fix: `priority` from a `backgroundJobConfig` now takes effect on a named workstream, on any job given a `groupId`, and on a scheduled (cron) job. The priority was previously written inside `group` — a BullMQ Pro option open-source BullMQ never schedules on — or, for cron jobs, dropped entirely, so BullMQ drained those jobs from `wait` ahead of every prioritized job on the queue. It is now written at the top level on every job. Affected jobs move from BullMQ's `waiting` set to `prioritized`, so monitoring, dashboards or specs that count `getWaitingCount()` must account for that.
- add `RateLimitedPsychicJob`, exported from `@rvoh/psychic-workers/errors`. Throw `new RateLimitedPsychicJob({ pauseQueueForSeconds })` from a backgrounded or scheduled method when the service it talks to rate limits the request (an HTTP 429). The queue is paused for that many seconds and the job returns to the queue with `attemptsMade` unchanged and no backoff. It requires a worker carrying a BullMQ `limiter`; thrown anywhere else the job fails with a message naming the fix. Each re-fetch counts in BullMQ's `attemptsStarted`, and the worker option `maxStartedAttempts` is the only bound on that cycle — without it it is unbounded.

## 2.6.0

- add `unschedule` and `unscheduleId` to `BaseScheduledService`. `unscheduleId` returns the id a method was scheduled under, e.g. `MyScheduledService.unscheduleId('myHourlyMethod')`, and `unschedule` removes the job registered under that id, e.g. `await MyScheduledService.unschedule(MyScheduledService.unscheduleId('myHourlyMethod'))`. Since the id is a plain string, it can be read in development and checked into a seed or migration, which allows a scheduled service class to be deleted in the same deploy that stops its job, e.g. `await ApplicationScheduledService.unschedule('services/MyScheduledService:myHourlyMethod')`. `unschedule` checks every queue, so it finds the job whether or not the service's workstream has changed since it was scheduled, and returns whether a job was actually removed. Unscheduling stops future runs; it does not cancel a run already placed on a queue.
- maintenance: refresh the repository's development tooling to Vitest 4.1.11, and with it the patched `@vitest/mocker`, `js-yaml`, `fast-uri`, and `@humanfs/node` versions the lockfile resolves to. Consumer-installed dependency and peer-dependency declarations are unchanged; this does not remediate a consumer application's independently resolved `@rvoh/psychic`/`fast-uri` dependency graph.

## 2.5.0

- add `backgroundWith` to `BaseBackgroundedService` (static) and `BaseBackgroundedModel` (static and instance). It takes `{ delay?: DelayedJobOpts; priority?: BackgroundQueuePriority }` as its first argument, followed by the method name and args. When `priority` is provided, it overrides the priority from `backgroundJobConfig` for that call only; `workstream`, `queue`, and `groupId` are preserved and the config object is not mutated. `delay` accepts the same options as `backgroundWithDelay`, including an optional `jobId` which debounces repeated calls within the delay window, e.g. `MyService.backgroundWith({ delay: { seconds: 30, jobId: 'my-unique-job-id' }, priority: 'urgent' }, 'myMethod', 'abc')`.
- deprecate `backgroundWithDelay` in favor of `backgroundWith({ delay }, ...)`. It continues to work unchanged and will be removed in a future major version.

## 2.4.1

- fix: `WorkerTestUtils.clean()` now also clears delayed jobs, as its documentation always stated. `queue.drain()` defaults to leaving the delayed set alone, and BullMQ parks a failed job there while it awaits its retry, so a job failing for a non-transient reason (a `globalName` that no longer resolves, say) was unreachable by `clean()` and survived into later test files — with the default `attempts`/backoff, for days. `WorkerTestUtils.workScheduled()` reads `getDelayed()` indiscriminately, so such a job would then fail whichever spec called `workScheduled` next, in a file unrelated to whatever enqueued it. If your suite has a spec that enqueued a delayed job and relied on it surviving a later `clean()`, it will now find that job gone.

## 2.4.0

- fix: worker processes started via `background.work()` now exit with code 1 after an `uncaughtException` or `unhandledRejection` (after best-effort graceful shutdown bounded by a 15s timeout), so orchestrators restart them instead of leaving a broken process alive
- fix: a failing or hung graceful shutdown on SIGTERM/SIGINT now logs and exits with code 1 instead of leaving the process ignoring signals until SIGKILL; clean shutdown still exits 0
- fix: one rejecting `worker.close()` no longer aborts closing the remaining workers and quitting redis connections during shutdown
- `doWork` now throws `NoClassForSpecifiedGlobalName` (exported from `@rvoh/psychic-workers/errors`) when a job's `globalName` no longer resolves to a class, so the job lands in BullMQ's failed set instead of silently completing. Previously, after a class rename/removal, queued jobs and repeating job schedulers referencing the old name would no-op forever with no log, failure, or metric. When the class resolves but the model instance is not found, the job still completes quietly (the record may have been legitimately deleted).

## 2.3.2

- upgrade to pnpm@11.9.0; add strictDepBuilds: false and deny esbuild/msgpackr-extract/puppeteer build scripts in pnpm-workspace.yaml

## 2.3.1

- switch to Github action publishing to npmjs.com

## 2.3.0

support psychic v3

## 2.2.0

- support defaultBullMQWorkerOptions (https://api.docs.bullmq.io/interfaces/v5.WorkerOptions.html), even with simple queue configuration

## 2.1.0

- add custom AST type builder to create custom types file for psychic workers, rather than piggy-backing off of psychic type builder, since that functionality is soon to be removed. This creates breaking changes at the type layer, so an automated script was added to refactor deprecated code to match the new type import location.

## 2.0.2

fix background with delay with debounce

## 2.0.1

bump glob to close dependabot alert

## 2.0.0

- namespace exports
- support Dream and Psychic 2.0

## 1.4.0

- throw an error if attempting to background an entire Dream model

## 1.3.0

- update for Psychic 1.11.1 and modern Dream

## 1.2.0

- update for Dream 1.4.0
