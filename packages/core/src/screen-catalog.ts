import path from 'node:path';
import ts from 'typescript';
import type { Files } from './files.js';
import type { RouteCandidates } from './routes.js';

export type Screen = { route: string; name: string };
export function screenName(route: string) {
  return route === '/' ? 'Home' : route.split('/').filter(Boolean).map(part => part.replace(/[-_]/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase())).join(' / ');
}
// Read literal navigator titles only. Project code is never evaluated for discovery.
export async function screenCatalog(files: Files, id: string, tree: string[], routes: RouteCandidates): Promise<Screen[]> {
  const candidates = new Set(routes.candidates.filter(route => route.kind === 'static' && !route.ambiguous).map(route => route.path));
  const named = new Map<string, string>();
  for (const file of tree.filter(file => /^(?:src\/)?app\/.*_layout\.[jt]sx?$/.test(file)).slice(0, 24)) {
    const source = await files.read(id, file).catch(() => null);
    if (!source) continue;
    const ast = ts.createSourceFile(file, source.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node: ts.Node) {
      if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && /^(Tabs|Stack|Drawer)\.Screen$/.test(node.tagName.getText(ast))) {
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
        const name = attributes.find(attribute => attribute.name.getText(ast) === 'name')?.initializer;
        const options = attributes.find(attribute => attribute.name.getText(ast) === 'options')?.initializer;
        if (name && ts.isStringLiteral(name) && options && ts.isJsxExpression(options) && options.expression && ts.isObjectLiteralExpression(options.expression)) {
          const title = options.expression.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(ast).replace(/['"]/g, '') === 'title');
          if (title && ts.isPropertyAssignment(title) && ts.isStringLiteral(title.initializer)) {
            const root = file.startsWith('src/') ? 'src/app/' : 'app/';
            const route = '/' + [...path.posix.dirname(file.slice(root.length)).split('/'), ...name.text.split('/')].filter(part => part !== '.' && part !== 'index' && !part.startsWith('(')).join('/');
            if (candidates.has(route) && !named.has(route)) named.set(route, title.initializer.text.trim().slice(0, 80) || screenName(route));
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  return [...named.keys(), ...[...candidates].filter(route => !named.has(route))].slice(0, 24).map(route => ({ route, name: named.get(route) ?? screenName(route) }));
}
