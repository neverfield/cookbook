import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Diagnostic, SyntaxValidator } from '@codecanvas/protocol';
import {
  EditEngine,
  checkPathContainment,
  compileGlobPattern,
  getCachePaths,
  recoverJournal,
  validateSyntax,
} from '../src/index.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createWorkspace(files: Record<string, string | Buffer> = {}): Promise<string> {
  const root = await makeTempDir('codecanvas-edit-engine-ws-');
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(root, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content);
  }
  return root;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function listDirSafe(dirPath: string): Promise<string[]> {
  try {
    return await fs.readdir(dirPath);
  } catch {
    return [];
  }
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('WP0.2: Path containment (§8.2 step 1)', () => {
  it('rejects ../ traversal escapes, absolute paths, and null-byte/control paths with zero disk writes', async () => {
    const ws = await createWorkspace({
      'apps/web/src/App.tsx': 'export const App = () => <main>ok</main>;\n',
    });
    const engine = new EditEngine({
      workspaceRoot: ws,
      policy: { writeRoots: ['apps/web'] },
    });

    const badPaths: Array<{ file: string; expectedReason: string }> = [
      { file: '../escape.ts', expectedReason: 'path-traversal' },
      { file: 'apps/web/../../../etc/passwd', expectedReason: 'path-traversal' },
      { file: 'apps\\..\\..\\escape.ts', expectedReason: 'path-traversal' },
      { file: '/etc/passwd', expectedReason: 'not-workspace-relative' },
      { file: 'C:\\Windows\\System32\\drivers\\etc\\hosts', expectedReason: 'not-workspace-relative' },
      { file: 'apps/web/src/App.tsx\0.bak', expectedReason: 'control-characters' },
      { file: 'apps/web/src/App\n.tsx', expectedReason: 'control-characters' },
      { file: 'apps/web/src/\x1bApp.tsx', expectedReason: 'control-characters' },
      { file: '', expectedReason: 'empty-path' },
      { file: '.', expectedReason: 'target-is-directory' },
    ];

    for (const { file, expectedReason } of badPaths) {
      const result = await engine.apply([
        { kind: 'content', file, content: 'export const x = 1;\n' },
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.stage).toBe('containment');
        expect(result.rolledBack).toBe(false);
        expect(result.containmentViolations?.[0]?.reason).toBe(expectedReason);
      }
    }

    // Zero disk writes: `.codecanvas/` must not even have been created.
    expect(await pathExists(path.join(ws, '.codecanvas'))).toBe(false);
  });

  it('rejects symlinked directories and symlinked leaf files pointing outside workspace', async () => {
    const outsideDir = await makeTempDir('codecanvas-outside-');
    const outsideFile = path.join(outsideDir, 'secret.ts');
    const originalSecret = 'export const SECRET = "do-not-touch";\n';
    await fs.writeFile(outsideFile, originalSecret);

    const ws = await createWorkspace({
      'apps/web/src/App.tsx': 'export const App = () => <div />;\n',
    });

    // 1. Symlinked directory pointing outside workspace
    await fs.symlink(outsideDir, path.join(ws, 'apps/web/src/linked-dir'));
    // 2. Symlinked leaf file pointing to existing outside file
    await fs.symlink(outsideFile, path.join(ws, 'apps/web/src/linked-file.ts'));
    // 3. Dangling symlink leaf pointing to non-existent outside file
    await fs.symlink(
      path.join(outsideDir, 'nonexistent-outside.ts'),
      path.join(ws, 'apps/web/src/dangling-outside.ts'),
    );
    // 4. Symlink loop
    await fs.symlink(
      path.join(ws, 'apps/web/src/loop-b.ts'),
      path.join(ws, 'apps/web/src/loop-a.ts'),
    );
    await fs.symlink(
      path.join(ws, 'apps/web/src/loop-a.ts'),
      path.join(ws, 'apps/web/src/loop-b.ts'),
    );

    const engine = new EditEngine({
      workspaceRoot: ws,
      policy: { writeRoots: ['apps/web'] },
    });

    // Existing file through symlinked dir
    const resDirExisting = await engine.apply([
      {
        kind: 'content',
        file: 'apps/web/src/linked-dir/secret.ts',
        content: 'export const SECRET = "pwned";\n',
      },
    ]);
    expect(resDirExisting.ok).toBe(false);
    if (!resDirExisting.ok) {
      expect(resDirExisting.stage).toBe('containment');
      expect(resDirExisting.containmentViolations?.[0]?.reason).toBe('symlink-escape');
    }

    // Non-existent leaf inside symlinked dir (resolved via deepest existing ancestor)
    const resDirNew = await engine.apply([
      {
        kind: 'content',
        file: 'apps/web/src/linked-dir/nested/new-file.ts',
        content: 'export const x = 1;\n',
      },
    ]);
    expect(resDirNew.ok).toBe(false);
    if (!resDirNew.ok) {
      expect(resDirNew.stage).toBe('containment');
      expect(resDirNew.containmentViolations?.[0]?.reason).toBe('symlink-escape');
    }

    // Symlinked leaf file pointing outside
    const resLeaf = await engine.apply([
      {
        kind: 'content',
        file: 'apps/web/src/linked-file.ts',
        content: 'export const SECRET = "pwned";\n',
      },
    ]);
    expect(resLeaf.ok).toBe(false);
    if (!resLeaf.ok) {
      expect(resLeaf.stage).toBe('containment');
      expect(resLeaf.containmentViolations?.[0]?.reason).toBe('symlink-escape');
    }

    // Dangling symlink leaf pointing outside
    const resDangling = await engine.apply([
      {
        kind: 'content',
        file: 'apps/web/src/dangling-outside.ts',
        content: 'export const x = 1;\n',
      },
    ]);
    expect(resDangling.ok).toBe(false);
    if (!resDangling.ok) {
      expect(resDangling.stage).toBe('containment');
      expect(resDangling.containmentViolations?.[0]?.reason).toBe('symlink-escape');
    }

    // Symlink loop
    const resLoop = await engine.apply([
      {
        kind: 'content',
        file: 'apps/web/src/loop-a.ts',
        content: 'export const x = 1;\n',
      },
    ]);
    expect(resLoop.ok).toBe(false);
    if (!resLoop.ok) {
      expect(resLoop.stage).toBe('containment');
      expect(resLoop.containmentViolations?.[0]?.reason).toBe('symlink-loop');
    }

    // Outside file remains completely untouched, and nothing created outside.
    expect(await fs.readFile(outsideFile, 'utf8')).toBe(originalSecret);
    expect(await pathExists(path.join(outsideDir, 'nested'))).toBe(false);
    expect(await pathExists(path.join(outsideDir, 'nonexistent-outside.ts'))).toBe(false);
  });

  it('enforces writeRoots, protected globs, forbidden directories, and allows non-existent leaves inside writeRoots', async () => {
    const ws = await createWorkspace({
      'apps/web/src/App.tsx': 'export const App = () => <div />;\n',
      'apps/web/next.config.js': 'export default {};\n',
      'apps/web/generated/types.ts': 'export type Id = string;\n',
      'packages/other/src/index.ts': 'export const a = 1;\n',
      '.git/HEAD': 'ref: refs/heads/main\n',
      'apps/web/node_modules/pkg/index.js': 'module.exports = 1;\n',
    });

    // Symlink inside apps/web pointing to sibling package outside writeRoots
    await fs.symlink(
      path.join(ws, 'packages/other/src/index.ts'),
      path.join(ws, 'apps/web/src/escape-to-other-pkg.ts'),
    );

    const policy = {
      writeRoots: ['apps/web', 'packages/ui'],
      protected: ['**/*.config.*', '**/generated/**', '**/*.lock', '.github/**'],
    };

    // Outside writeRoots
    const outsideRoot = await checkPathContainment(ws, 'packages/other/src/index.ts', policy);
    expect(outsideRoot.ok).toBe(false);
    if (!outsideRoot.ok) {
      expect(outsideRoot.violation.reason).toBe('outside-write-roots');
    }

    // Symlink escaping writeRoots into another workspace dir
    const symlinkEscapeRoot = await checkPathContainment(
      ws,
      'apps/web/src/escape-to-other-pkg.ts',
      policy,
    );
    expect(symlinkEscapeRoot.ok).toBe(false);
    if (!symlinkEscapeRoot.ok) {
      expect(symlinkEscapeRoot.violation.reason).toBe('symlink-escape');
    }

    // Protected globs
    for (const file of [
      'apps/web/next.config.js',
      'apps/web/generated/types.ts',
      'apps/web/pnpm.lock',
    ]) {
      const check = await checkPathContainment(ws, file, policy);
      expect(check.ok).toBe(false);
      if (!check.ok) {
        expect(check.violation.reason).toBe('protected-path');
      }
    }

    // Forbidden directories (.git, node_modules, .codecanvas/cache)
    for (const file of [
      '.git/HEAD',
      'apps/web/node_modules/pkg/index.js',
      '.codecanvas/cache/journal/txn.json',
    ]) {
      const check = await checkPathContainment(ws, file, {});
      expect(check.ok).toBe(false);
      if (!check.ok) {
        expect(check.violation.reason).toBe('forbidden-directory');
      }
    }

    // Non-existent nested leaf inside allowed writeRoot resolves cleanly via realpath
    const validNew = await checkPathContainment(
      ws,
      'apps/web/src/components/NewCard/NewCard.tsx',
      policy,
    );
    expect(validNew.ok).toBe(true);
    if (validNew.ok) {
      expect(validNew.target.file).toBe('apps/web/src/components/NewCard/NewCard.tsx');
      expect(validNew.target.writeRoot).toBe('apps/web');
      expect(validNew.target.canonicalPath).toBe(
        path.join(await fs.realpath(ws), 'apps/web/src/components/NewCard/NewCard.tsx'),
      );
    }

    // Explicit empty writeRoots denies all writes
    const denyAll = await checkPathContainment(ws, 'apps/web/src/App.tsx', {
      writeRoots: [],
    });
    expect(denyAll.ok).toBe(false);
    if (!denyAll.ok) {
      expect(denyAll.violation.reason).toBe('outside-write-roots');
    }

    // Glob matcher sanity check
    expect(compileGlobPattern('**/*.config.*').test('vite.config.ts')).toBe(true);
    expect(compileGlobPattern('**/*.config.*').test('apps/web/vite.config.ts')).toBe(true);
    expect(compileGlobPattern('**/*.config.*').test('apps/web/config.ts')).toBe(false);
    expect(compileGlobPattern('.github/**').test('.github/workflows/ci.yml')).toBe(true);
  });
});

describe('WP0.2: Pre-write parse validation (§8.2 step 2)', () => {
  it('accepts valid JS, JSX, TS, TSX, CSS, SCSS, and JSON files', () => {
    expect(validateSyntax('src/app.js', 'export const f = () => <div>hi</div>;\n')).toEqual([]);
    expect(validateSyntax('src/app.jsx', 'export const C = ({ n }) => <span>{n}</span>;\n')).toEqual([]);
    // Plain .ts with angle-bracket generic & type assertion must parse without JSX conflict
    expect(
      validateSyntax('src/util.ts', 'export const id = <T>(x: T): T => x;\nexport const n = <number>1;\n'),
    ).toEqual([]);
    expect(
      validateSyntax('src/Button.tsx', 'export const Button = ({ label }: { label: string }) => <button>{label}</button>;\n'),
    ).toEqual([]);
    expect(
      validateSyntax('src/styles.css', '@media (min-width: 768px) { .card { color: var(--fg); } }\n'),
    ).toEqual([]);
    expect(
      validateSyntax(
        'src/styles.scss',
        '// line comment\n$primary: #111;\n@mixin pad($v) { padding: $v; }\n.btn {\n  @include pad(8px);\n  &:hover { color: $primary; }\n}\n',
      ),
    ).toEqual([]);
    expect(validateSyntax('src/tokens.json', '{"color": {"primary": "#000"}}\n')).toEqual([]);
  });

  it('rejects syntax-breaking JS, TS, JSX, TSX, CSS, SCSS, and JSON edits with structured diagnostics and zero disk writes', async () => {
    const origJs = 'export const a = 1;\n';
    const origTs = 'export const b: number = 2;\n';
    const origJsx = 'export const View = () => <section>ok</section>;\n';
    const origCss = '.card { color: red; }\n';
    const origScss = '$c: blue;\n.card { color: $c; }\n';
    const origJson = '{"ok": true}\n';

    const ws = await createWorkspace({
      'src/a.js': origJs,
      'src/b.ts': origTs,
      'src/View.jsx': origJsx,
      'src/card.css': origCss,
      'src/card.scss': origScss,
      'src/data.json': origJson,
    });

    const engine = new EditEngine({ workspaceRoot: ws });

    const brokenCases: Array<{ file: string; broken: string }> = [
      { file: 'src/a.js', broken: 'export const a = (\n  1 + ;\n' },
      { file: 'src/b.ts', broken: 'export interface Foo {\n  bar: string\n  baz: ;\n}\n' },
      { file: 'src/View.jsx', broken: 'export const View = () => (\n  <section><span>unclosed</section>\n);\n' },
      { file: 'src/card.css', broken: '.card {\n  color: red;\n' },
      { file: 'src/card.scss', broken: '$c: blue;\n.card {\n  &:hover {\n    color: $c;\n' },
      { file: 'src/data.json', broken: '{\n  "ok": true,\n}\n' },
    ];

    for (const { file, broken } of brokenCases) {
      // Pair every broken edit with a valid edit to another file to prove all-or-nothing zero disk writes
      const otherFile = file === 'src/a.js' ? 'src/b.ts' : 'src/a.js';
      const otherValid =
        otherFile === 'src/b.ts'
          ? 'export const b: number = 999;\n'
          : 'export const a = 999;\n';

      const result = await engine.apply([
        { kind: 'content', file: otherFile, content: otherValid },
        { kind: 'content', file, content: broken },
      ]);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.stage).toBe('validation');
        expect(result.rolledBack).toBe(false);
        expect(result.diagnostics).toBeDefined();
        expect(result.diagnostics!.length).toBeGreaterThanOrEqual(1);

        const diag = result.diagnostics![0]!;
        expect(diag.file).toBe(file);
        expect(diag.severity).toBe('error');
        expect(typeof diag.line).toBe('number');
        expect(diag.line!).toBeGreaterThanOrEqual(1);
        expect(typeof diag.column).toBe('number');
        expect(diag.column!).toBeGreaterThanOrEqual(1);
        expect(diag.col).toBe(diag.column);
        expect(diag.message.length).toBeGreaterThan(0);
      }
    }

    // Verify ZERO disk writes across every file and no `.codecanvas/` directory created.
    expect(await fs.readFile(path.join(ws, 'src/a.js'), 'utf8')).toBe(origJs);
    expect(await fs.readFile(path.join(ws, 'src/b.ts'), 'utf8')).toBe(origTs);
    expect(await fs.readFile(path.join(ws, 'src/View.jsx'), 'utf8')).toBe(origJsx);
    expect(await fs.readFile(path.join(ws, 'src/card.css'), 'utf8')).toBe(origCss);
    expect(await fs.readFile(path.join(ws, 'src/card.scss'), 'utf8')).toBe(origScss);
    expect(await fs.readFile(path.join(ws, 'src/data.json'), 'utf8')).toBe(origJson);
    expect(await pathExists(path.join(ws, '.codecanvas'))).toBe(false);
  });

  it('supports pluggable SyntaxValidator seam (LanguageAdapter.validate compatible)', async () => {
    const ws = await createWorkspace({
      'src/custom.txt': 'hello\n',
    });

    const customValidator: SyntaxValidator = {
      validate(file: string, text: string): Diagnostic[] {
        if (text.includes('FORBIDDEN')) {
          return [
            {
              file,
              severity: 'error',
              line: 1,
              col: 1,
              column: 1,
              message: 'Forbidden token detected',
            },
          ];
        }
        return [];
      },
    };

    const engine = new EditEngine({
      workspaceRoot: ws,
      validator: customValidator,
    });

    const res = await engine.apply([
      { kind: 'content', file: 'src/custom.txt', content: 'FORBIDDEN\n' },
    ]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.stage).toBe('validation');
      expect(res.diagnostics?.[0]?.message).toBe('Forbidden token detected');
    }
    expect(await fs.readFile(path.join(ws, 'src/custom.txt'), 'utf8')).toBe('hello\n');
  });
});

describe('WP0.2: Atomic multi-file journal, rollback, and crash recovery (§8.2 step 4)', () => {
  it('stages temp files only in .codecanvas/cache/tmp/, commits atomically, preserves mode, and leaves tmp clean', async () => {
    const ws = await createWorkspace({
      'apps/web/src/Button.tsx': 'export const Button = () => <button>Old</button>;\n',
      'apps/web/src/Button.css': '.btn { color: red; }\n',
    });
    const buttonPath = path.join(ws, 'apps/web/src/Button.tsx');
    await fs.chmod(buttonPath, 0o640);

    const observedTmpFiles: string[] = [];
    const observedSrcDirEntries: string[][] = [];

    const engine = new EditEngine({
      workspaceRoot: ws,
      policy: { writeRoots: ['apps/web'] },
    });

    const result = await engine.apply(
      [
        {
          kind: 'edits',
          file: 'apps/web/src/Button.tsx',
          edits: [{ range: { start: 36, end: 39 }, newText: 'New' }],
        },
        {
          kind: 'content',
          file: 'apps/web/src/Button.css',
          content: '.btn { color: blue; }\n',
        },
        {
          kind: 'content',
          file: 'apps/web/src/new-dir/Badge.tsx',
          content: 'export const Badge = () => <span>v2</span>;\n',
        },
      ],
      {
        txnId: 'txn-clean-commit',
        fsHooks: {
          async onBeforeCommitEntry(_entry, index) {
            if (index === 0) {
              const wsReal = await fs.realpath(ws);
              const paths = getCachePaths(wsReal);
              observedTmpFiles.push(...(await listDirSafe(paths.tmpDir)));
              observedSrcDirEntries.push(
                await listDirSafe(path.join(ws, 'apps/web/src')),
              );
            }
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.txnId).toBe('txn-clean-commit');
    expect(result.files).toHaveLength(3);

    // Temp files were staged inside `.codecanvas/cache/tmp/`, never in `apps/web/src/`.
    expect(observedTmpFiles.sort()).toEqual([
      'txn-clean-commit-0.tmp',
      'txn-clean-commit-1.tmp',
      'txn-clean-commit-2.tmp',
    ]);
    expect(observedSrcDirEntries[0]?.sort()).toEqual(['Button.css', 'Button.tsx']);

    // All three target files reflect the committed edits.
    expect(await fs.readFile(buttonPath, 'utf8')).toBe(
      'export const Button = () => <button>New</button>;\n',
    );
    expect((await fs.stat(buttonPath)).mode & 0o777).toBe(0o640);
    expect(await fs.readFile(path.join(ws, 'apps/web/src/Button.css'), 'utf8')).toBe(
      '.btn { color: blue; }\n',
    );
    expect(
      await fs.readFile(path.join(ws, 'apps/web/src/new-dir/Badge.tsx'), 'utf8'),
    ).toBe('export const Badge = () => <span>v2</span>;\n');

    // Journal is marked `committed` and `.codecanvas/cache/tmp/` is completely empty.
    const journal = await engine.readJournal('txn-clean-commit');
    expect(journal?.status).toBe('committed');
    expect(journal?.committedAt).toBeDefined();

    const wsReal = await fs.realpath(ws);
    const cachePaths = getCachePaths(wsReal);
    expect(await listDirSafe(cachePaths.tmpDir)).toEqual([]);
  });

  it('rolls back ALL touched files to exact original bytes when the 2nd file write fails (soundness.ts case D)', async () => {
    const origA = Buffer.from(
      'export const A = () => <div data-id="a">Original A — café</div>;\r\n',
      'utf8',
    );
    const origB = Buffer.from(
      'export const B = () => <div data-id="b">Original B — π</div>;\n',
      'utf8',
    );

    const ws = await createWorkspace({
      'apps/web/src/A.tsx': origA,
      'apps/web/src/B.tsx': origB,
    });
    const pathA = path.join(ws, 'apps/web/src/A.tsx');
    const pathB = path.join(ws, 'apps/web/src/B.tsx');
    await fs.chmod(pathA, 0o644);
    await fs.chmod(pathB, 0o600);

    const engine = new EditEngine({
      workspaceRoot: ws,
      policy: { writeRoots: ['apps/web'] },
    });

    let renameCalls = 0;
    const result = await engine.apply(
      [
        {
          kind: 'content',
          file: 'apps/web/src/A.tsx',
          content: 'export const A = () => <div>Modified A</div>;\n',
        },
        {
          kind: 'content',
          file: 'apps/web/src/B.tsx',
          content: 'export const B = () => <div>Modified B</div>;\n',
        },
      ],
      {
        txnId: 'txn-fail-second',
        fsHooks: {
          async commitRename(from, to) {
            renameCalls += 1;
            if (renameCalls === 2) {
              const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
              err.code = 'ENOSPC';
              throw err;
            }
            await fs.rename(from, to);
          },
        },
      },
    );

    expect(renameCalls).toBe(2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('commit');
      expect(result.rolledBack).toBe(true);
      expect(result.txnId).toBe('txn-fail-second');
    }

    // Both files restored to exact byte-for-byte original contents and modes.
    const afterA = await fs.readFile(pathA);
    const afterB = await fs.readFile(pathB);
    expect(Buffer.compare(afterA, origA)).toBe(0);
    expect(Buffer.compare(afterB, origB)).toBe(0);
    expect((await fs.stat(pathA)).mode & 0o777).toBe(0o644);
    expect((await fs.stat(pathB)).mode & 0o777).toBe(0o600);

    // Journal marked `rolled-back`, and `.codecanvas/cache/tmp/` is empty.
    const journal = await engine.readJournal('txn-fail-second');
    expect(journal?.status).toBe('rolled-back');
    expect(journal?.rollbackReason).toContain('ENOSPC');

    const wsReal = await fs.realpath(ws);
    expect(await listDirSafe(getCachePaths(wsReal).tmpDir)).toEqual([]);
    expect((await listDirSafe(path.join(ws, 'apps/web/src'))).sort()).toEqual([
      'A.tsx',
      'B.tsx',
    ]);
  });

  it('removes newly created files and empty parent directories on rollback', async () => {
    const origExisting = 'export const Existing = () => <p>keep</p>;\n';
    const ws = await createWorkspace({
      'apps/web/src/Existing.tsx': origExisting,
    });

    const engine = new EditEngine({
      workspaceRoot: ws,
      policy: { writeRoots: ['apps/web'] },
    });

    let calls = 0;
    const result = await engine.apply(
      [
        {
          kind: 'content',
          file: 'apps/web/src/fresh/nested/Widget.tsx',
          content: 'export const Widget = () => <span />;\n',
        },
        {
          kind: 'content',
          file: 'apps/web/src/Existing.tsx',
          content: 'export const Existing = () => <p>updated</p>;\n',
        },
      ],
      {
        txnId: 'txn-rollback-newfile',
        fsHooks: {
          async commitRename(from, to) {
            calls += 1;
            if (calls === 2) {
              throw new Error('EIO: simulated disk error');
            }
            await fs.rename(from, to);
          },
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rolledBack).toBe(true);
    }

    expect(await pathExists(path.join(ws, 'apps/web/src/fresh/nested/Widget.tsx'))).toBe(false);
    expect(await pathExists(path.join(ws, 'apps/web/src/fresh'))).toBe(false);
    expect(await fs.readFile(path.join(ws, 'apps/web/src/Existing.tsx'), 'utf8')).toBe(
      origExisting,
    );
  });

  it('recovers from a simulated mid-commit crash via recoverJournal(), restoring all files and cleaning tmp', async () => {
    const origA = Buffer.from('export const Alpha = () => <h1>Alpha v1</h1>;\n', 'utf8');
    const origB = Buffer.from('export const Beta = () => <h2>Beta v1</h2>;\n', 'utf8');

    const ws = await createWorkspace({
      'apps/web/src/Alpha.tsx': origA,
      'apps/web/src/Beta.tsx': origB,
    });
    const wsReal = await fs.realpath(ws);
    const cachePaths = getCachePaths(wsReal);

    // Snapshot the exact on-disk state midway through commit (after file 0 was
    // renamed, while journal is still `pending` and file 1's `.tmp` is still in
    // `.codecanvas/cache/tmp/`), then replay that crashed state onto the workspace.
    const crashSnapshotDir = await makeTempDir('codecanvas-crash-snapshot-');

    const engine = new EditEngine({
      workspaceRoot: ws,
      policy: { writeRoots: ['apps/web'] },
    });

    const firstAttempt = await engine.apply(
      [
        {
          kind: 'content',
          file: 'apps/web/src/Alpha.tsx',
          content: 'export const Alpha = () => <h1>Alpha v2</h1>;\n',
        },
        {
          kind: 'content',
          file: 'apps/web/src/Beta.tsx',
          content: 'export const Beta = () => <h2>Beta v2</h2>;\n',
        },
        {
          kind: 'content',
          file: 'apps/web/src/added/Gamma.tsx',
          content: 'export const Gamma = () => <h3>Gamma v2</h3>;\n',
        },
      ],
      {
        txnId: 'txn-crashed-mid-commit',
        fsHooks: {
          async onAfterCommitEntry(_entry, index) {
            if (index === 0) {
              // Capture exact mid-commit disk state (Alpha updated, Beta still old,
              // journal still `pending`, tmp files for Beta & Gamma still present).
              await fs.cp(wsReal, crashSnapshotDir, { recursive: true });
              throw new Error('Abort to finish capturing crash snapshot');
            }
          },
        },
      },
    );
    expect(firstAttempt.ok).toBe(false);

    // Restore the exact mid-commit crashed state back into `wsReal`, plus an
    // orphaned temp file from an earlier aborted Phase-1 staging attempt.
    await fs.rm(path.join(wsReal, '.codecanvas'), { recursive: true, force: true });
    await fs.rm(path.join(wsReal, 'apps'), { recursive: true, force: true });
    await fs.cp(crashSnapshotDir, wsReal, { recursive: true });
    await fs.writeFile(path.join(cachePaths.tmpDir, 'orphan-stage.tmp'), 'partial');

    // Verify pre-recovery crashed disk state: Alpha has v2, Beta has v1, journal is `pending`.
    expect(await fs.readFile(path.join(wsReal, 'apps/web/src/Alpha.tsx'), 'utf8')).toBe(
      'export const Alpha = () => <h1>Alpha v2</h1>;\n',
    );
    expect(
      Buffer.compare(await fs.readFile(path.join(wsReal, 'apps/web/src/Beta.tsx')), origB),
    ).toBe(0);
    const pendingJournal = await engine.readJournal('txn-crashed-mid-commit');
    expect(pendingJournal?.status).toBe('pending');
    expect((await listDirSafe(cachePaths.tmpDir)).length).toBeGreaterThanOrEqual(2);

    // Fresh startup instance runs recoverJournal().
    const freshEngine = new EditEngine({
      workspaceRoot: wsReal,
      policy: { writeRoots: ['apps/web'] },
    });
    const report = await freshEngine.recoverJournal();

    expect(report.errors).toEqual([]);
    expect(report.recoveredTxnIds).toEqual(['txn-crashed-mid-commit']);
    expect(report.restoredFiles).toContain('apps/web/src/Alpha.tsx');
    expect(report.cleanedTempFiles).toContain('orphan-stage.tmp');

    // Both files restored to exact original bytes; Gamma was never committed/remains absent.
    expect(
      Buffer.compare(await fs.readFile(path.join(wsReal, 'apps/web/src/Alpha.tsx')), origA),
    ).toBe(0);
    expect(
      Buffer.compare(await fs.readFile(path.join(wsReal, 'apps/web/src/Beta.tsx')), origB),
    ).toBe(0);
    expect(await pathExists(path.join(wsReal, 'apps/web/src/added'))).toBe(false);

    // Journal transitioned to `rolled-back` with reason `crash-recovery`.
    const recoveredJournal = await freshEngine.readJournal('txn-crashed-mid-commit');
    expect(recoveredJournal?.status).toBe('rolled-back');
    expect(recoveredJournal?.rollbackReason).toBe('crash-recovery');

    // `.codecanvas/cache/tmp/` is completely clean.
    expect(await listDirSafe(cachePaths.tmpDir)).toEqual([]);

    // Idempotency: running recoverJournal() again is a clean no-op.
    const secondReport = await recoverJournal(wsReal, { writeRoots: ['apps/web'] });
    expect(secondReport.recoveredTxnIds).toEqual([]);
    expect(secondReport.restoredFiles).toEqual([]);
    expect(secondReport.removedFiles).toEqual([]);
    expect(secondReport.cleanedTempFiles).toEqual([]);
    expect(secondReport.errors).toEqual([]);
  });

  it('recovers from a crash after committing a new nested file and removes both the file and empty parent dirs', async () => {
    const origExisting = Buffer.from('export const Base = () => <main>base</main>;\n', 'utf8');
    const ws = await createWorkspace({
      'apps/web/src/Base.tsx': origExisting,
    });
    const wsReal = await fs.realpath(ws);
    const cachePaths = getCachePaths(wsReal);
    const crashSnapshotDir = await makeTempDir('codecanvas-crash-newfile-');

    const engine = new EditEngine({
      workspaceRoot: wsReal,
      policy: { writeRoots: ['apps/web'] },
    });

    await engine.apply(
      [
        {
          kind: 'content',
          file: 'apps/web/src/new-feature/sub/Card.tsx',
          content: 'export const Card = () => <article>new</article>;\n',
        },
        {
          kind: 'content',
          file: 'apps/web/src/Base.tsx',
          content: 'export const Base = () => <main>updated</main>;\n',
        },
      ],
      {
        txnId: 'txn-crash-after-newfile',
        fsHooks: {
          async onAfterCommitEntry(_entry, index) {
            if (index === 1) {
              // Crash AFTER both files renamed, right BEFORE writing `committed` marker.
              await fs.cp(wsReal, crashSnapshotDir, { recursive: true });
              throw new Error('Abort to capture post-rename pre-marker crash');
            }
          },
        },
      },
    );

    await fs.rm(path.join(wsReal, '.codecanvas'), { recursive: true, force: true });
    await fs.rm(path.join(wsReal, 'apps'), { recursive: true, force: true });
    await fs.cp(crashSnapshotDir, wsReal, { recursive: true });

    expect(
      await pathExists(path.join(wsReal, 'apps/web/src/new-feature/sub/Card.tsx')),
    ).toBe(true);
    expect(await fs.readFile(path.join(wsReal, 'apps/web/src/Base.tsx'), 'utf8')).toBe(
      'export const Base = () => <main>updated</main>;\n',
    );

    const report = await recoverJournal(wsReal, { writeRoots: ['apps/web'] });
    expect(report.errors).toEqual([]);
    expect(report.recoveredTxnIds).toEqual(['txn-crash-after-newfile']);
    expect(report.restoredFiles).toEqual(['apps/web/src/Base.tsx']);
    expect(report.removedFiles).toEqual(['apps/web/src/new-feature/sub/Card.tsx']);

    expect(await pathExists(path.join(wsReal, 'apps/web/src/new-feature'))).toBe(false);
    expect(
      Buffer.compare(await fs.readFile(path.join(wsReal, 'apps/web/src/Base.tsx')), origExisting),
    ).toBe(0);
    expect(await listDirSafe(cachePaths.tmpDir)).toEqual([]);
  });

  it('serializes concurrent apply() transactions cleanly without racing on tmp', async () => {
    const ws = await createWorkspace({
      'src/counter.ts': 'export const count = 0;\n',
    });
    const engine = new EditEngine({ workspaceRoot: ws });

    const [r1, r2] = await Promise.all([
      engine.apply(
        [{ kind: 'content', file: 'src/counter.ts', content: 'export const count = 1;\n' }],
        { txnId: 'txn-seq-1' },
      ),
      engine.apply(
        [{ kind: 'content', file: 'src/counter.ts', content: 'export const count = 2;\n' }],
        { txnId: 'txn-seq-2' },
      ),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(await fs.readFile(path.join(ws, 'src/counter.ts'), 'utf8')).toBe(
      'export const count = 2;\n',
    );

    const wsReal = await fs.realpath(ws);
    expect(await listDirSafe(getCachePaths(wsReal).tmpDir)).toEqual([]);
  });

  it('rejects overlapping TextEdits and duplicate canonical targets without touching disk', async () => {
    const orig = 'export const value = "hello";\n';
    const ws = await createWorkspace({
      'src/value.ts': orig,
    });
    await fs.symlink(
      path.join(ws, 'src/value.ts'),
      path.join(ws, 'src/value-alias.ts'),
    );

    const engine = new EditEngine({ workspaceRoot: ws });

    const overlapRes = await engine.apply([
      {
        kind: 'edits',
        file: 'src/value.ts',
        edits: [
          { range: { start: 0, end: 10 }, newText: 'a' },
          { range: { start: 5, end: 12 }, newText: 'b' },
        ],
      },
    ]);
    expect(overlapRes.ok).toBe(false);
    if (!overlapRes.ok) {
      expect(overlapRes.stage).toBe('apply-edits');
      expect(overlapRes.rolledBack).toBe(false);
    }

    // Two different paths resolving to the same canonical file via internal symlink
    const dupRes = await engine.apply([
      { kind: 'content', file: 'src/value.ts', content: 'export const value = "a";\n' },
      { kind: 'content', file: 'src/value-alias.ts', content: 'export const value = "b";\n' },
    ]);
    expect(dupRes.ok).toBe(false);
    if (!dupRes.ok) {
      expect(dupRes.stage).toBe('input');
      expect(dupRes.rolledBack).toBe(false);
    }

    expect(await fs.readFile(path.join(ws, 'src/value.ts'), 'utf8')).toBe(orig);
    expect(await pathExists(path.join(ws, '.codecanvas'))).toBe(false);
  });
});
