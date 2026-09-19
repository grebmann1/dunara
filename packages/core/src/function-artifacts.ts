import path from 'node:path';
import ts from 'typescript';
import { hash } from '../../platform/src/crypto.js';
import { PlatformError, type Actor } from '../../platform/src/contracts.js';
import { PlatformStore } from '../../platform/src/store.js';
import { Files } from './files.js';

export type FunctionArtifact = { projectId: string; slug: string; entrypoint: string; files: { path: string; sourcePath: string; revision: string; content: string }[] };
/** Every dependency is vendored and captured without executing code or install hooks. */
export async function prepareFunction(files: Files, projectId: string, slug: string, entrypoint: string): Promise<FunctionArtifact> {
  const root = `supabase/functions/${slug}/`, visited = new Map<string, FunctionArtifact['files'][number]>(); let bytes = 0;
  async function visit(sourcePath: string) {
    if (visited.has(sourcePath)) return;
    if (!sourcePath.startsWith(root) || !/^[a-zA-Z0-9_/-]+\.ts$/.test(sourcePath) || sourcePath.includes('..') || visited.size >= 32) throw new PlatformError('INVALID_ARTIFACT', 'Function imports must be bounded .ts files within the function root.');
    const source = await files.read(projectId, sourcePath); bytes += Buffer.byteLength(source.content);
    if (bytes > 256_000) throw new PlatformError('LIMIT_EXCEEDED', 'The function artifact exceeds 256 KB.');
    visited.set(sourcePath, { path: sourcePath.slice(root.length), sourcePath, revision: source.revision, content: source.content });
    const ast = ts.createSourceFile(sourcePath, source.content, ts.ScriptTarget.Latest, true), imports: string[] = [];
    function dependency(value: ts.Expression | undefined) {
      if (!value || !ts.isStringLiteral(value) || !value.text.startsWith('./') && !value.text.startsWith('../') || !value.text.endsWith('.ts')) throw new PlatformError('INVALID_ARTIFACT', 'Vendor dependencies as relative .ts files. Remote, package, and computed imports are not supported.');
      imports.push(path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), value.text)));
    }
    function walk(node: ts.Node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier) dependency(node.moduleSpecifier);
      if (ts.isImportEqualsDeclaration(node) || ts.isImportTypeNode(node) || ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) throw new PlatformError('INVALID_ARTIFACT', 'Use static relative imports in reviewed functions.');
      ts.forEachChild(node, walk);
    }
    walk(ast);
    const diagnostics = ts.transpileModule(source.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, reportDiagnostics: true }).diagnostics ?? [];
    if (diagnostics.some(d => d.category === ts.DiagnosticCategory.Error)) throw new PlatformError('INVALID_ARTIFACT', 'Function TypeScript syntax is invalid. Correct the source before review.');
    if (ast.referencedFiles.length || ast.typeReferenceDirectives.length || ast.libReferenceDirectives.length) throw new PlatformError('INVALID_ARTIFACT', 'Function reference directives are not supported.');
    for (const dependencyPath of imports) await visit(dependencyPath);
  }
  await visit(entrypoint);
  return { projectId, slug, entrypoint: entrypoint.slice(root.length), files: [...visited.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}
export function saveArtifact(store: PlatformStore, actor: Actor, artifact: FunctionArtifact) {
  const id = hash(artifact), old = store.getRecord(actor, 'function-artifact', id);
  if (old && hash(old) !== id) throw new PlatformError('ARTIFACT_CORRUPTED', 'The immutable function artifact changed. Prepare a new review.');
  if (!old) store.putRecord(actor, 'function-artifact', id, artifact);
  return id;
}
export function readArtifact(store: PlatformStore, actor: Actor, projectId: string, id: string): FunctionArtifact {
  const artifact = store.getRecord<FunctionArtifact>(actor, 'function-artifact', id);
  if (!artifact || artifact.projectId !== projectId || hash(artifact) !== id) throw new PlatformError('ARTIFACT_UNAVAILABLE', 'The exact reviewed function artifact is unavailable. Prepare a new review.');
  return artifact;
}
