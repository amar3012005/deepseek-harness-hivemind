import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

/** Reject an overlay whose shell still seeds an older primitives namespace. */
export function verifySharedShell(primitives, shell) {
  const library = ts.createSourceFile('primitives.js', primitives, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const names = library.statements.filter(ts.isExportDeclaration)
    .flatMap(statement => statement.exportClause && ts.isNamedExports(statement.exportClause)
      ? statement.exportClause.elements.map(element => element.name.text) : [])
  if (names.length === 0) throw new Error('Shared primitives have no built export declaration')
  const program = ts.createSourceFile('shell.js', shell, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const variables = new Map()
  let namespace
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) variables.set(node.name.text, node.initializer)
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name)
      && node.name.text === '@deepseek-ai/dsh-client-ui-primitives') namespace = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(program)
  if (!namespace || !ts.isIdentifier(namespace)) throw new Error('Shell has no shared primitives namespace')
  const initializer = variables.get(namespace.text)
  let properties
  function inspect(node) {
    if (ts.isObjectLiteralExpression(node)) {
      properties = new Set(node.properties.filter(ts.isPropertyAssignment).map(property => property.name.getText(program)))
      return
    }
    ts.forEachChild(node, inspect)
  }
  if (initializer) inspect(initializer)
  if (!properties) throw new Error('Shell primitives namespace has no static export table')
  const missing = names.filter(name => !properties.has(name))
  if (missing.length) throw new Error(`Shared shell is stale; missing primitives: ${missing.join(', ')}`)
  return names.length
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.argv[2] ?? '/opt/deepseek-harness'
  const count = verifySharedShell(
    readFileSync(resolve(root, 'packages/client/ui-primitives/lib/index.js'), 'utf8'),
    readFileSync(resolve(root, 'apps/web/dist/assets/harness-shell.js'), 'utf8'),
  )
  console.log(`Shared shell verified: ${count} primitives exports`)
}
