import { DreamApp } from '@rvoh/dream'
import { DreamCLI } from '@rvoh/dream/system'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import PsychicAppWorkers from '../psychic-app-workers/index.js'

/**
 * Originally, psychic-workers tapped into the types produced by psychic,
 * modifying the psychicTypes to include type configurations for workers
 * as well. Since Psychic no longer supports this method of augmenting
 * types, psychic-workers has been refactored to produce its own types
 * file.
 *
 * This service is responsible for identifying applications that are still
 * reliant on the types produced by psychic, and refactoring them so that their
 * imports are now in the correct places.
 */
export default class PsychicTypesDeprecation {
  public async deprecate() {
    const workersApp = PsychicAppWorkers.getOrFail()
    if (workersApp.bypassDeprecationChecks) return

    const files = [
      path.join(process.cwd(), DreamApp.system.dreamPath('models'), 'ApplicationBackgroundedModel.ts'),
      path.join(
        process.cwd(),
        DreamApp.system.dreamPath('models'),
        '..',
        'services',
        'ApplicationBackgroundedService.ts',
      ),
      path.join(
        process.cwd(),
        DreamApp.system.dreamPath('models'),
        '..',
        'services',
        'ApplicationScheduledService.ts',
      ),
    ]

    try {
      for (const file of files) {
        const fileContent = (await fs.readFile(file)).toString()
        if (fileContent.includes('psychicTypes')) {
          await DreamCLI.logger.logProgress(
            `[psychic workers] patching deprecated types for ${file.split(path.sep).at(-1)}`,
            async () => {
              await fs.writeFile(
                file,
                fileContent
                  .replace(/psychicTypes/g, 'psychicWorkerTypes')
                  .replace(/types\/psychic\.js/, 'types/workers.js'),
              )
            },
          )
        }
      }
    } catch (err) {
      console.error(err)
      console.log(`
ATTENTION: 

The psychic-workers package now requires a new configuration in order to continue providing types
in the modern psychic ecosystem. We attempted to automatically fix this for you, but something went
wrong. Please locate the following files, and ensure that they no longer provide the "psychicTypes" getter.
they should instead provide a psychicWorkerTypes getter in its place, which brings in types that
are now located in the newly-generated "types/workers.ts" file.

For the ApplicationBackgroundedModel.ts, ApplicationScheduledService.ts, and ApplicationBackgroundedService.ts 
files in your system, ensure that their "psychicTypes" getter is replaced with the "psychicWorkerTypes"
getter, like so:


import { psychicWorkerTypes } from '@src/types/workers.js'

export default class ApplicationBackgroundedModel extends BaseBackgroundedModel {
  ...

  public override get psychicWorkerTypes() {
    return psychicWorkerTypes
  }
}
`)
    }
  }
}
