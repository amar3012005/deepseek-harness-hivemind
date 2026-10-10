import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

/** Reject an overlay whose shell still seeds an older primitives namespace. */
export function verifySharedShell(primitives, shell, plugins = []) {
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
      const candidate = new Set(node.properties.filter(ts.isPropertyAssignment).map(property => property.name.getText(program)))
      if (!properties || names.filter(name => candidate.has(name)).length
        > names.filter(name => properties.has(name)).length) properties = candidate
      return
    }
    ts.forEachChild(node, inspect)
  }
  if (initializer) inspect(initializer)
  if (!properties) throw new Error('Shell primitives namespace has no static export table')
  for (const plugin of plugins) {
    const ast = ts.createSourceFile('plugin.js', plugin, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const aliases = new Set()
    function findAlias(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && node.initializer && ts.isCallExpression(node.initializer)
        && node.initializer.expression.getText(ast) === 'require'
        && node.initializer.arguments[0] && ts.isStringLiteral(node.initializer.arguments[0])
        && node.initializer.arguments[0].text === '@deepseek-ai/dsh-client-ui-primitives') aliases.add(node.name.text)
      ts.forEachChild(node, findAlias)
    }
    findAlias(ast)
    function findUse(node) {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
        && aliases.has(node.expression.text) && !names.includes(node.name.text)) names.push(node.name.text)
      ts.forEachChild(node, findUse)
    }
    findUse(ast)
  }
  const missing = names.filter(name => !properties.has(name))
  if (missing.length) throw new Error(`Shared shell is stale; missing primitives: ${missing.join(', ')}`)
  return names.length
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.argv[2] ?? '/opt/deepseek-harness'
  const plugins = readdirSync(resolve(root, 'packages/client')).map(name => resolve(root, 'packages/client', name, 'lib/client.js'))
    .filter(existsSync).map(path => readFileSync(path, 'utf8'))
  const count = verifySharedShell(
    readFileSync(resolve(root, 'packages/client/ui-primitives/lib/index.js'), 'utf8'),
    readFileSync(resolve(root, 'apps/web/dist/assets/harness-shell.js'), 'utf8'),
    plugins,
  )
  console.log(`Shared shell verified: ${count} primitives exports`)
}
