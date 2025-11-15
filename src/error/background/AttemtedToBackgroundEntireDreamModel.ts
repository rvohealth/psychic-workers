import { Dream } from '@rvoh/dream'
import { camelize } from '@rvoh/dream/utils'

export default class AttemtedToBackgroundEntireDreamModel extends Error {
  public constructor(
    private method: string | undefined,
    private dream: Dream,
  ) {
    super()
  }

  public override get message() {
    const dreamClass = this.dream.constructor as typeof Dream
    const primaryKey = dreamClass.primaryKey as string
    const sanitizedMethodName = (this.method ?? 'myMethod').replace(/^_/, '')
    const className = this.dream.sanitizedConstructorName
    const instanceName = camelize(className)

    return `
Background \`${instanceName}.${primaryKey}\` (and \`${instanceName}.sanitizedConstructorName\`, if
the use case is polymorphic), not the entire Dream model. Then, in the
backgrounded method, find the model and return null if not found. For example:

\`\`\`
public async ${sanitizedMethodName}(${instanceName}: ${className}) {
  await background('_${sanitizedMethodName}', ${instanceName}.${primaryKey})
}

public async _${sanitizedMethodName}(${instanceName}Id: string) {
  const ${instanceName} = await User.find(${instanceName}Id)
  if (!${instanceName}) return

  ...
}
\`\`\`

This serves several purposes:
1. Dramatically reduces the size of what gets stored in Redis
2. Prevents sensitive data from being sent to Redis
3. Does not retry the job if the corresponding model was deleted between when the
   job was backgrounded and it was run
`
  }
}
