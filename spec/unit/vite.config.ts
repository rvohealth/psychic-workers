import '../../test-app/src/conf/loadEnv.js'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    dir: './spec/unit',
    globals: true,
    setupFiles: ['luxon-jest-matchers', './spec/unit/setup/hooks.ts'],
    fileParallelism: true,
    maxConcurrency: parseInt(process.env.DREAM_PARALLEL_TESTS || '1'),
    maxWorkers: parseInt(process.env.DREAM_PARALLEL_TESTS || '1'),
    minWorkers: 1,
    mockReset: true,
    watch: false,

    globalSetup: './spec/unit/setup/globalSetup.ts',
  },
})
