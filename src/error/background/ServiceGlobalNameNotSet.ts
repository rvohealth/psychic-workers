import { GlobalNameNotSet } from '@rvoh/dream/errors'

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
type ServiceClass = Function

/**
 * @internal
 *
 * Thrown when a service class that Psychic never registered is backgrounded
 * or scheduled. Psychic registers only the default export of each file in
 * the services directory, naming it after the file's path, so an
 * unregistered subclass would otherwise run under its parent's name.
 *
 * The message prescribes the fix: one default-exported service per file,
 * with the file hierarchy matching the inheritance chain (a child service
 * lives inside its parent's namespace, as STI models do).
 *
 * Extends Dream's GlobalNameNotSet so code that caught that error still
 * catches this one.
 */
export default class ServiceGlobalNameNotSet extends GlobalNameNotSet {
  constructor(
    private serviceClass: ServiceClass,
    private frameworkBase: ServiceClass,
  ) {
    super(serviceClass)
  }

  public override get message() {
    const chain = this.chain()
    const name = this.serviceClass.name
    const parent = chain.length > 1 ? chain[chain.length - 2]!.klass.name : undefined
    const registeredAncestor =
      chain.length > 1 && this.registeredPath(chain[0]!.klass) ? chain[0]!.klass.name : undefined

    const layout = chain
      .map(
        ({ klass, path }) =>
          `  src/app/services/${path}.ts\n    export default class ${klass.name}${this.extendsClause(klass)}`,
      )
      .join('\n')

    const intro = parent
      ? `${name} extends ${parent} but has no global name of its own, so it cannot be backgrounded or scheduled.
${
  registeredAncestor
    ? `If it were allowed to run, its jobs would be queued and scheduled under ${registeredAncestor}'s name, and the worker would run ${registeredAncestor} instead.`
    : ''
}`.trimEnd()
      : `${name} has no global name, so it cannot be backgrounded or scheduled.`

    return `
${intro}

Psychic registers a service only when it is the default export of its own file in the services
directory, and names it after that file's path. Make every service the default export of its own
file, and make the file hierarchy match the inheritance chain: a service that extends another
service lives inside its parent's namespace, the same way STI child models do.

${layout}

If ${name} is already the default export of that file, the app's services had not been loaded
when this ran (Psychic loads them when the app initializes).`
  }

  /**
   * The services from the topmost application-level ancestor down to the
   * class being reported, each with the path its file should have under
   * the services directory.
   */
  private chain(): { klass: ServiceClass; path: string }[] {
    const lineage: ServiceClass[] = []
    let klass: unknown = this.serviceClass

    while (typeof klass === 'function' && !this.isApplicationBase(klass)) {
      lineage.unshift(klass)
      const registered = this.registeredPath(klass)
      if (registered) break
      klass = Object.getPrototypeOf(klass)
    }

    if (lineage.length === 0) lineage.push(this.serviceClass)

    const chain: { klass: ServiceClass; path: string }[] = []
    for (const member of lineage) {
      const parentPath = chain[chain.length - 1]?.path
      const path = this.registeredPath(member) ?? (parentPath ? `${parentPath}/${member.name}` : member.name)
      chain.push({ klass: member, path })
    }
    return chain
  }

  /**
   * The framework base, or an application base class that extends it
   * directly (ApplicationBackgroundedService, ApplicationScheduledService).
   * Services that extend an application base are top-level services, not
   * children in its namespace.
   */
  private isApplicationBase(klass: ServiceClass) {
    return klass === this.frameworkBase || Object.getPrototypeOf(klass) === this.frameworkBase
  }

  private extendsClause(klass: ServiceClass) {
    const parentName = (Object.getPrototypeOf(klass) as ServiceClass).name
    return parentName ? ` extends ${parentName}` : ''
  }

  private registeredPath(klass: ServiceClass) {
    if (!Object.hasOwn(klass, '_globalName')) return undefined
    const globalName = (klass as unknown as { _globalName?: string })._globalName
    if (!globalName) return undefined
    return globalName.replace(/^services\//, '')
  }
}
