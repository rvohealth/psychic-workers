## 2.6.0

- add first-class scheduled-job lifecycle APIs. Scheduled service classes can derive a deterministic, Redis-free `jobSchedulerLocator(method)`, and `BaseScheduledService.unschedule(locator)` can use a checked-in locator after the concrete class has been deleted. Locators are opaque, versioned Psychic values; every locator emitted in 2.x remains supported through the last 2.x release.
- add `background.getJobSchedulers()` for an unordered inventory of recognizable Psychic scheduled static jobs across configured current and transitional queue origins, plus `background.removeJobScheduler(row)` for generation-bound removal from the exact origin where a row was observed. Export the framework-owned `PsychicJobScheduler`, `PsychicJobSchedulerOrigin`, and `PsychicJobSchedulerRoute` contracts from `@rvoh/psychic-workers/types`; serialized arguments, Redis connections, BullMQ queue objects, and BullMQ scheduler DTOs remain private.
- export `InvalidJobSchedulerLocator` and `DuplicateNamedWorkstream` from `@rvoh/psychic-workers/errors`. Duplicate named workstreams within one current or transitional simple-mode configuration now fail initialization instead of silently overwriting one another; the same logical route may still appear once in each topology.
- route-wide `unschedule` attempts every configured current and transitional origin for the locator's logical route and returns `true` if any scheduler was removed, or `false` if all were already absent. If a queue rejects, the call rejects after all origin attempts settle; another origin may already have been changed, and retrying the locator is safe. The encoded logical route must remain configured and reachable. Caller-owned Redis settings still decide whether an unavailable operation rejects or remains pending.
- exact-origin removal accepts a same-generation cloned inventory row and remains effective when cadence metadata is stale. Inventory plus exact-origin removal is the cleanup path after a service changes routes: locate the old-origin row and remove it there. If configured origins alias one BullMQ keyspace, removing either observation returns `true` and a later removal through the other returns `false`.
- scheduler removal prevents future occurrences but does not cancel an occurrence that is already active, and scheduling the same class and method later recreates that identity. Inventory queues are read independently rather than as one atomic snapshot, so concurrent changes or aliased origins can produce mixed-time duplicates or omissions; any rejecting read rejects the whole inventory call rather than returning partial data.
- no automatic orphan detection or deletion is introduced. Applications remain the sole owners of their schedules and explicitly inspect or remove stale registrations.
- scheduled-service subclasses with their own static `unschedule` or `jobSchedulerLocator` can collide with the new inherited names. An incompatible TypeScript declaration fails to compile and should be renamed; JavaScript or signature-compatible declarations can shadow the inherited API. The legacy broad method-name typing of `schedule()` is unchanged, while locator generation intentionally accepts only child job methods.
- maintenance: refresh the repository's development tooling to Vitest 4.1.11 and patched `@vitest/mocker`, `js-yaml`, `fast-uri`, and `@humanfs/node` resolutions. Consumer-installed dependency and peer-dependency declarations are unchanged; this does not remediate a consumer application's independently resolved `@rvoh/psychic`/`fast-uri` dependency graph.

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
