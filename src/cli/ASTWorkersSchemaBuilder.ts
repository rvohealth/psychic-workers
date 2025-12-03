import { CliFileWriter, DreamCLI } from '@rvoh/dream/system'
import ts from 'typescript'
import background from '../background/index.js'
import ASTBuilder from './ASTBuilder.js'

const f = ts.factory

/**
 * Responsible for building dream globals, which can be found at
 * types/dream.globals.ts.
 *
 * This class leverages internal AST building mechanisms built into
 * typescript to manually build up object literals and interfaces
 * for our app to consume.
 */
export default class ASTWorkersSchemaBuilder extends ASTBuilder {
  public async build() {
    const logger = DreamCLI.logger
    const sourceFile = ts.createSourceFile('', '', ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)

    await logger.logProgress('[psychic workers] building workers types', async () => {
      const output = await this.prettier(
        this.printStatements([this.buildWorkersTypeConfigConst()], sourceFile),
      )

      await CliFileWriter.write(this.workersSchemaPath(), output)
    })
  }

  /**
   * @internal
   *
   * builds up the `export const globalTypeConfig = ...` statement within the types/workers.ts
   * file. It does this by leveraging low-level AST utils built into typescript
   * to manually build up an object literal, cast it as a const, and write it to
   * an exported variable.
   */
  private buildWorkersTypeConfigConst() {
    background.connect()

    const globalTypeConfigObjectLiteral = f.createObjectLiteralExpression(
      [
        f.createPropertyAssignment(
          f.createIdentifier('workstreamNames'),
          f.createArrayLiteralExpression(
            background['workstreamNames'].map(key => f.createStringLiteral(key)),
          ),
        ),

        f.createPropertyAssignment(
          f.createIdentifier('queueGroupMap'),
          f.createObjectLiteralExpression(
            Object.keys(background['groupNames']).map(key =>
              f.createPropertyAssignment(
                f.createStringLiteral(key),
                f.createArrayLiteralExpression(
                  background['groupNames'][key]!.map(str => f.createStringLiteral(str)),
                ),
              ),
            ),
            true, // multiline
          ),
        ),
      ],
      true, // multiline
    )

    // add "as const" to the end of the schema object we
    // have built before returning it
    const constAssertion = f.createAsExpression(
      globalTypeConfigObjectLiteral,
      f.createKeywordTypeNode(ts.SyntaxKind.ConstKeyword as ts.KeywordTypeSyntaxKind),
    )

    const psychicWorkerTypesObjectLiteralConst = f.createVariableStatement(
      [f.createModifier(ts.SyntaxKind.ExportKeyword)],
      f.createVariableDeclarationList(
        [
          f.createVariableDeclaration(
            f.createIdentifier('psychicWorkerTypes'),
            undefined,
            undefined,
            constAssertion,
          ),
        ],
        ts.NodeFlags.Const,
      ),
    )

    return psychicWorkerTypesObjectLiteralConst
  }

  /**
   * @internal
   *
   * writes the compiled statements to string.
   *
   */
  private printStatements(statements: ts.Node[], sourceFile: ts.SourceFile): string {
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, omitTrailingSemicolon: true })
    const result = printer.printList(
      ts.ListFormat.SourceFileStatements,
      f.createNodeArray(statements),
      sourceFile,
    )

    // TODO: add autogenerate disclaimer
    return `\
${result}`
  }
}
