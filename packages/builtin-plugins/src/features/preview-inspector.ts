import { lstat } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { z } from 'zod';
import { BuilderError, revisionSchema } from "../../../core/src/contracts.js";
import type { Engine } from "../../../core/src/engine.js";
import { revision } from "../../../core/src/files.js";
import { templateRoot } from "../../../core/src/projects.js";
import { exists, readText } from "../../../core/src/storage.js";

export const inspectorApplySchema = z.object({ projectId: z.uuid(), proposedRevision: revisionSchema, confirmed: z.literal(true) }).strict();
export type InspectorProposal = Awaited<ReturnType<typeof previewInspectorSetup>>;
const marker = '// Mobile App Builder: development-only preview inspection';
const guidance = 'Manual integration: review the canonical builder-inspector.web.tsx and no-op builder-inspector.tsx, place both in src/, then import the bridge from your Expo Router root layout. Never overwrite a customized bridge. See docs/preview-context.md.';
function unsupported(message: string): never { throw new BuilderError('INVALID_INPUT', `${message} ${guidance}`); }

async function proposal(engine: Engine, id: string) {
  const project = await engine.projects.get(id), rootStat = await lstat(project.root);
  const manifest = await engine.files.read(id, 'package.json');
  const pkg = JSON.parse(manifest.content);
  if (!pkg.dependencies?.['expo-router'] || !pkg.dependencies?.expo) unsupported('Setup supports Expo Router projects only.');
  const layouts = [];
  for (const candidate of ['app/_layout.tsx', 'src/app/_layout.tsx']) if (await exists(await engine.files.resolve(id, candidate))) layouts.push(candidate);
  if (layouts.length !== 1) unsupported('Expected exactly one app/_layout.tsx or src/app/_layout.tsx.');
  const layoutPath = layouts[0]!;
  const layout = await engine.files.read(id, layoutPath);
  const diagnostics = ts.transpileModule(layout.content, { fileName: layoutPath, reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext } }).diagnostics;
  if (diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error)) unsupported('The root layout has syntax errors.');
  const ast = ts.createSourceFile(layoutPath, layout.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hasDefault = ast.statements.some(node => ts.isExportAssignment(node) && !node.isExportEquals || ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword));
  if (!hasDefault) unsupported('The root layout needs a conventional default export.');
  const files: { path: string; before: string | null; after: string; expectedRevision: string | null }[] = [];
  for (const relative of ['src/builder-inspector.tsx', 'src/builder-inspector.web.tsx']) {
    const canonical = await readText(path.join(templateRoot, relative));
    const current = await exists(await engine.files.resolve(id, relative)) ? await engine.files.read(id, relative) : null;
    if (current && current.content !== canonical) unsupported(`Conflicting or edited bridge: ${relative}.`);
    files.push({ path: relative, before: current?.content ?? null, after: canonical, expectedRevision: current?.revision ?? null });
  }
  const importPath = layoutPath.startsWith('src/') ? '../builder-inspector' : '../src/builder-inspector';
  const addition = `\n${marker}\nimport '${importPath}';\n`;
  const existingImports = ast.statements.filter(ts.isImportDeclaration).filter(node => ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.includes('builder-inspector'));
  const installed = existingImports.length === 1 && layout.content.endsWith(addition) && !existingImports[0]!.importClause;
  if ((existingImports.length || layout.content.includes(marker)) && !installed) unsupported('An unrecognized inspection import already exists.');
  files.push({ path: layoutPath, before: layout.content, after: installed ? layout.content : layout.content.replace(/\n?$/, '\n') + addition, expectedRevision: layout.revision });
  const identity = { id: project.id, root: project.root, device: rootStat.dev, inode: rootStat.ino };
  const proposedRevision = revision(JSON.stringify({ identity, manifestRevision: manifest.revision, files }));
  return { project: { id: project.id, name: project.name, root: project.root }, proposedRevision, installed: files.every(file => file.before === file.after), files };
}
export function previewInspectorSetup(engine: Engine, id: string) { return engine.projects.mutations.run(() => proposal(engine, id)); }
export async function applyInspectorSetup(engine: Engine, id: string, input: unknown) {
  const value = inspectorApplySchema.parse(input);
  if (value.projectId !== id) throw new BuilderError('INVALID_INPUT', 'Setup belongs to another project');
  return engine.projects.mutations.run(async () => {
    const current = await proposal(engine, id);
    if (value.proposedRevision !== current.proposedRevision) throw new BuilderError('REVISION_CONFLICT', 'Setup changed. Review a fresh proposal before applying.');
    const writes = current.files.filter(file => file.before !== file.after).map(file => ({ path: file.path, content: file.after, expectedRevision: file.expectedRevision }));
    return writes.length ? engine.files.writeUnlocked(id, writes) : { applied: [] };
  });
}
