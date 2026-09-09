/**
 * file-utils.ts（产物收集与输入解析工具）的单元测试。
 *
 * 覆盖 glob→regex 转换、glob/regex 自动区分、透传变量替换、递归文件搜索、
 * `{uuid}_output.json` 读写、InputFrom 就近匹配（三种 path + 回退 + regex 模式）。
 * 文件系统依赖经自建 `FakeFs`（内存实现 target 导向两段式协议）注入。
 * @module @meiyukichan/dsh-sandore/microflow/src/file-utils.spec
 */
import { describe, expect, it } from 'vitest';

import type { ExecutedStepDefault } from '../workflow/types';
import {
  collectStepArtifacts,
  escapeRegexChar,
  findFilesByGlob,
  findFilesByRegex,
  globToRegex,
  hasUnresolvedVars,
  idMatches,
  isGlobPattern,
  readOutputJson,
  replacePassThroughVars,
  resolveFromInputFrom,
  resolveOutputToVars,
  resolvePathSegments,
  walkDir,
  writeOutputJson,
} from './file-utils.ts';
import type { FileSystem, FsDirEntry, FsTarget, FsWriteOutcome, StepOutputFile } from './file-utils.ts';

/** 内存文件系统（target 导向两段式协议）：`files` 存文件内容，`dirs` 存目录。 */
class FakeFs implements FileSystem {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();
  /** 模拟权限拒绝：listDir 命中这些 targetKey 时抛错（缺陷 18 try/catch 容错测试）。 */
  readonly listDirThrows = new Set<string>();

  seedFile(path: string, content = ''): void {
    this.files.set(path, content);
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i++) {
      this.dirs.add(segments.slice(0, i).join('/'));
    }
  }

  async resolve(path: string): Promise<FsTarget> {
    const normalized = path.replace(/\/+$/, '') || '/';
    return { targetKey: normalized, displayPath: normalized };
  }

  processPath(target: FsTarget): string {
    return target.displayPath;
  }

  async listDir(target: FsTarget): Promise<FsDirEntry[]> {
    if (this.listDirThrows.has(target.targetKey)) {
      throw new Error(`FS_PERMISSION_DENIED: ${target.displayPath}`);
    }
    const prefix = target.targetKey === '/' ? '' : `${target.targetKey}/`;
    const names = new Set<string>();
    for (const dir of this.dirs) {
      if (dir.startsWith(prefix)) {
        const name = dir.slice(prefix.length).split('/')[0]!;
        if (name !== '') names.add(name);
      }
    }
    for (const file of this.files.keys()) {
      if (file.startsWith(prefix)) {
        const name = file.slice(prefix.length).split('/')[0]!;
        if (name !== '') names.add(name);
      }
    }
    return [...names].sort().map(name => {
      const full = prefix + name;
      const isDir = this.dirs.has(full);
      return { name, type: isDir ? 'directory' : 'file', target: { targetKey: full, displayPath: full } };
    });
  }

  async readText(target: FsTarget): Promise<string> {
    const content = this.files.get(target.targetKey);
    if (content === undefined) throw new Error(`FS_NOT_FOUND: ${target.displayPath}`);
    return content;
  }

  async writeText(target: FsTarget, content: string): Promise<FsWriteOutcome> {
    const before = this.files.get(target.targetKey) ?? null;
    this.seedFile(target.targetKey, content);
    return { operation: before === null ? 'create' : 'update', version: 'v2', before, after: content };
  }
}

/** 组装一条已执行 Step 快照（补齐必填字段）。 */
function executedStep(fields: {
  id: string;
  stepId?: string;
  stageId: string;
  name?: string;
  output?: ExecutedStepDefault['output'];
  outputTo?: ExecutedStepDefault['outputTo'];
}): ExecutedStepDefault {
  return {
    type: 'default',
    id: fields.id,
    stageId: fields.stageId,
    name: fields.name ?? fields.stepId ?? fields.id,
    status: 'completed',
    visitCount: 1,
    ...(fields.stepId === undefined ? {} : { stepId: fields.stepId }),
    ...(fields.output === undefined ? {} : { output: fields.output }),
    ...(fields.outputTo === undefined ? {} : { outputTo: fields.outputTo }),
  };
}

describe('globToRegex', () => {
  it('converts * to single-level wildcard', () => {
    const regex = globToRegex('artifacts/*.md');
    expect(regex.test('artifacts/report.md')).toBe(true);
    expect(regex.test('artifacts/sub/report.md')).toBe(false);
  });

  it('converts ** to multi-level wildcard and skips the following slash', () => {
    const regex = globToRegex('build/**/report.md');
    expect(regex.test('build/a/report.md')).toBe(true);
    expect(regex.test('build/a/b/report.md')).toBe(true);
    expect(regex.test('build/report.md')).toBe(true);
    expect(regex.test('build/report.txt')).toBe(false);
  });

  it('converts ? to a single non-slash character', () => {
    const regex = globToRegex('file?.txt');
    expect(regex.test('file1.txt')).toBe(true);
    expect(regex.test('file12.txt')).toBe(false);
  });

  it('escapes regex metacharacters in literal segments', () => {
    expect(globToRegex('a.b.txt').test('aXb.txt')).toBe(false);
    expect(globToRegex('a.b.txt').test('a.b.txt')).toBe(true);
  });
});

describe('escapeRegexChar', () => {
  it('escapes regex special characters and leaves others untouched', () => {
    expect(escapeRegexChar('.')).toBe('\\.');
    expect(escapeRegexChar('(')).toBe('\\(');
    expect(escapeRegexChar('a')).toBe('a');
    expect(escapeRegexChar('/')).toBe('/');
  });
});

describe('isGlobPattern', () => {
  it('detects glob patterns with wildcards', () => {
    expect(isGlobPattern('out/*.log')).toBe(true);
    expect(isGlobPattern('out/file?.txt')).toBe(true);
  });

  it('rejects regex-featured or literal patterns', () => {
    expect(isGlobPattern('out/\\d+.txt')).toBe(false);
    expect(isGlobPattern('plain/path.txt')).toBe(false);
    expect(isGlobPattern('foo(?=bar)')).toBe(false);
  });

  // ── 缺陷 19：对齐基准 looksLikeGlob 全特征检测（原实现漏检 .* / .+ / [^ / \d 等） ──

  it('rejects regex-style patterns that previously slipped through as glob (defect 19)', () => {
    // 修前：这些含 `*`/`?` 且不含 `\` 与 `(?` → 被误判为 glob → globToRegex 静默错误匹配。
    // 修后：命中 `.*` / `.+` / `[^` / `\d` 特征 → 正确判为非 glob → 走 fileExists 精确存在性检查。
    expect(isGlobPattern('.*')).toBe(false);
    expect(isGlobPattern('.+')).toBe(false);
    expect(isGlobPattern('\\d*')).toBe(false);
    expect(isGlobPattern('[^a]*')).toBe(false);
    expect(isGlobPattern('foo.*')).toBe(false);
  });

  it('keeps legitimate globs unflipped after the full-feature detection (regression)', () => {
    // 合法 glob 不含 `.*` / `.+` / `[^` / `\d` / `^…$` 特征，判定不变。
    expect(isGlobPattern('out/*.log')).toBe(true);
    expect(isGlobPattern('out/file?.txt')).toBe(true);
    expect(isGlobPattern('**/*.ts')).toBe(true);
    expect(isGlobPattern('build/**/report.md')).toBe(true);
  });

  it('still treats non-glob literal and regex-lookahead paths as non-glob', () => {
    expect(isGlobPattern('plain/path.txt')).toBe(false);
    expect(isGlobPattern('foo(?=bar)')).toBe(false);
    expect(isGlobPattern('^.*$')).toBe(false);
    expect(isGlobPattern('a{3}')).toBe(false);
  });
});

describe('replacePassThroughVars', () => {
  it('replaces defined variables and keeps undefined ones verbatim', () => {
    expect(replacePassThroughVars('x=${a}, y=${b}', { a: '1' })).toBe('x=1, y=${b}');
  });

  it('replaces in-loop-turn and all-loop-turn special variables', () => {
    expect(replacePassThroughVars('turn=${in-loop-turn}/${all-loop-turn}', {
      'in-loop-turn': '2',
      'all-loop-turn': '5',
    })).toBe('turn=2/5');
  });

  it('does not interpret $&/$1 sequences in replacement values', () => {
    expect(replacePassThroughVars('${a}', { a: 'x$&y$1z' })).toBe('x$&y$1z');
  });
});

// ── 缺陷 33/34：hasUnresolvedVars + resolveOutputToVars（共享工具） ──────────────

describe('hasUnresolvedVars', () => {
  it('detects a ${xxx} placeholder as unresolved', () => {
    expect(hasUnresolvedVars('artifacts/${projectName}/report.md')).toBe(true);
    expect(hasUnresolvedVars('turn=${in-loop-turn}/${all-loop-turn}')).toBe(true);
  });

  it('returns false for a literal string without placeholders', () => {
    expect(hasUnresolvedVars('artifacts/my-project/report.md')).toBe(false);
    expect(hasUnresolvedVars('plain path with $ but no braces')).toBe(false);
  });

  it('returns false for empty string and for empty braces ${}', () => {
    expect(hasUnresolvedVars('')).toBe(false);
    // 正则要求 [^}]+（至少一个非 } 字符），空 ${} 不视为占位符。
    expect(hasUnresolvedVars('text ${} more')).toBe(false);
  });
});

describe('resolveOutputToVars', () => {
  it('resolves a defined ${xxx} in path and marks not deferred', () => {
    const result = resolveOutputToVars(
      { path: 'artifacts/${projectName}/report.md' },
      { projectName: 'my-project' },
    );
    expect(result.path).toBe('artifacts/my-project/report.md');
    expect(result.regex).toBeUndefined();
    expect(result.deferred).toBe(false);
  });

  it('resolves a defined ${xxx} in regex and marks not deferred', () => {
    const result = resolveOutputToVars({ regex: '${var}\\.md$' }, { var: 'report' });
    expect(result.regex).toBe('report\\.md$');
    expect(result.path).toBeUndefined();
    expect(result.deferred).toBe(false);
  });

  it('leaves an undefined ${xxx} verbatim and marks deferred', () => {
    const result = resolveOutputToVars(
      { path: 'artifacts/${projectName}/report.md' },
      {},
    );
    expect(result.path).toBe('artifacts/${projectName}/report.md');
    expect(result.deferred).toBe(true);
  });

  it('marks deferred when path is resolved but regex still has ${}', () => {
    const result = resolveOutputToVars(
      { path: '${a}/out.txt', regex: '${b}\\.md$' },
      { a: 'dir' },
    );
    expect(result.path).toBe('dir/out.txt');
    expect(result.regex).toBe('${b}\\.md$');
    expect(result.deferred).toBe(true);
  });

  it('returns an empty object (deferred=false) for an item with no path/regex', () => {
    const result = resolveOutputToVars({}, { a: '1' });
    expect(result).toEqual({ deferred: false });
  });

  it('does not mutate the input item (pure function)', () => {
    const item = { path: 'artifacts/${projectName}/report.md' };
    resolveOutputToVars(item, { projectName: 'my-project' });
    expect(item.path).toBe('artifacts/${projectName}/report.md');
  });
});

describe('idMatches', () => {
  it('matches exact id or a suffixed variant', () => {
    expect(idMatches('step-a', 'step-a')).toBe(true);
    expect(idMatches('step-a-49aa', 'step-a')).toBe(true);
    expect(idMatches('step-ab', 'step-a')).toBe(false);
  });
});

describe('walkDir / findFilesByGlob / findFilesByRegex', () => {
  function seededFs(): FakeFs {
    const fs = new FakeFs();
    fs.seedFile('/work/build/a/report.md');
    fs.seedFile('/work/build/b/report.md');
    fs.seedFile('/work/build/report.md');
    fs.seedFile('/work/notes.txt');
    fs.seedFile('/work/node_modules/pkg/index.js');
    return fs;
  }

  it('walkDir returns absolute paths of all files, skipping node_modules', async () => {
    const fs = seededFs();
    const found = await walkDir(fs, await fs.resolve('/work/build'));
    expect(found).toEqual(['/work/build/a/report.md', '/work/build/b/report.md', '/work/build/report.md']);
  });

  it('findFilesByGlob returns recursive matches as absolute paths', async () => {
    const fs = seededFs();
    const found = await findFilesByGlob(fs, '/work', 'build/**/report.md');
    expect(found.sort()).toEqual([
      '/work/build/a/report.md',
      '/work/build/b/report.md',
      '/work/build/report.md',
    ]);
  });

  it('findFilesByRegex matches file relative paths', async () => {
    const fs = seededFs();
    const found = await findFilesByRegex(fs, '/work', '^build/.+/report\\.md$');
    expect(found.sort()).toEqual(['/work/build/a/report.md', '/work/build/b/report.md']);
  });

  it('findFilesByRegex rejects an invalid regex with a readable error', async () => {
    const fs = seededFs();
    await expect(findFilesByRegex(fs, '/work', '[')).rejects.toThrow(/invalid regex/);
  });

  // ── 缺陷 18：walkDir 隐藏文件过滤差异（点目录跳/点文件留/node_modules跳/try-catch容错） ──

  it('walkDir skips dot directories (.git/.vscode/.venv) without recursing', async () => {
    const fs = new FakeFs();
    fs.seedFile('/work/real.txt');
    fs.seedFile('/work/.git/config');
    fs.seedFile('/work/.vscode/settings.json');
    fs.seedFile('/work/.venv/bin/python');
    const found = await walkDir(fs, await fs.resolve('/work'));
    expect(found).toEqual(['/work/real.txt']);
  });

  it('walkDir preserves dot files (.env/.gitignore) as collectible artifacts', async () => {
    const fs = new FakeFs();
    fs.seedFile('/work/.env', 'KEY=value');
    fs.seedFile('/work/.gitignore', 'node_modules');
    fs.seedFile('/work/out/.env', 'NESTED=value');
    fs.seedFile('/work/real.txt');
    const found = (await walkDir(fs, await fs.resolve('/work'))).sort();
    expect(found).toEqual(['/work/.env', '/work/.gitignore', '/work/out/.env', '/work/real.txt']);
  });

  it('walkDir still skips node_modules directories (recursion pruned)', async () => {
    const fs = new FakeFs();
    fs.seedFile('/work/real.txt');
    fs.seedFile('/work/node_modules/pkg/index.js');
    fs.seedFile('/work/node_modules/.cache/data.json');
    const found = await walkDir(fs, await fs.resolve('/work'));
    expect(found).toEqual(['/work/real.txt']);
  });

  it('walkDir tolerates listDir permission errors on a subtree (skips silently, siblings preserved)', async () => {
    const fs = new FakeFs();
    fs.seedFile('/work/keep.txt');
    fs.seedFile('/work/secret/hidden.txt');
    fs.seedFile('/work/open/public.txt');
    fs.listDirThrows.add('/work/secret');
    const found = (await walkDir(fs, await fs.resolve('/work'))).sort();
    expect(found).toEqual(['/work/keep.txt', '/work/open/public.txt']);
  });
});

describe('writeOutputJson / readOutputJson', () => {
  it('round-trips the output structure with sessionId and artifacts values', async () => {
    const fs = new FakeFs();
    const data: StepOutputFile = {
      sessionId: 's-1',
      output: {
        returnPrompt: 'done',
        artifacts: [{ id: 'opt-a', value: ['/abs/1.md', '/abs/2.md'] }],
      },
    };

    const writtenPath = await writeOutputJson(fs, '/work', 'uuid-123', data);
    expect(writtenPath).toBe('/work/uuid-123_output.json');

    const read = await readOutputJson(fs, '/work', 'uuid-123');
    expect(read).toEqual(data);
    expect(read.output.artifacts[0]?.value).toEqual(['/abs/1.md', '/abs/2.md']);
  });

  it('rejects malformed output json', async () => {
    const fs = new FakeFs();
    fs.seedFile('/work/bad_output.json', 'not-json');
    await expect(readOutputJson(fs, '/work', 'bad')).rejects.toThrow(/output json/);
  });

  it('rejects output json with an invalid shape', async () => {
    const fs = new FakeFs();
    fs.seedFile('/work/weird_output.json', JSON.stringify({ sessionId: 1 }));
    await expect(readOutputJson(fs, '/work', 'weird')).rejects.toThrow(/output json/);
  });
});

describe('resolvePathSegments / resolveFromInputFrom', () => {
  it('resolves Step level to the nearest loop iteration with a suffixed id', () => {
    const executed: ExecutedStepDefault[] = [
      executedStep({ id: 'step-step-a-0001', stepId: 'step-a', stageId: 'stg-1' }),
      executedStep({ id: 'step-step-a-49aa', stepId: 'step-a-49aa', stageId: 'stg-1' }),
      executedStep({ id: 'step-step-b-0001', stepId: 'step-b', stageId: 'stg-1' }),
    ];
    const result = resolvePathSegments(executed, 2, 'step-a');
    expect(result).toEqual([executed[1]]);
  });

  it('resolves Step level to the previous iteration, skipping the current self-referential entry', () => {
    const executed: ExecutedStepDefault[] = [
      executedStep({ id: 'step-step-a-0001', stepId: 'step-a-0001', stageId: 'stg-1' }),
      executedStep({ id: 'step-step-a-49aa', stepId: 'step-a-49aa', stageId: 'stg-1' }),
    ];
    // 简化格式：path 为 step id；就近匹配命中最近同名 Step。
    const result = resolvePathSegments(executed, 1, 'step-a-49aa');
    expect(result).toEqual([executed[1]]);
  });

  it('resolves Step level by step id, nearest last', () => {
    const executed: ExecutedStepDefault[] = [
      executedStep({ id: 'e-a', stepId: 'a', stageId: 'stg-1' }),
      executedStep({ id: 'e-b', stepId: 'b', stageId: 'stg-1' }),
      executedStep({ id: 'e-c', stepId: 'c', stageId: 'stg-2' }),
    ];
    const result = resolvePathSegments(executed, 2, 'b');
    expect(result).toEqual([executed[1]]);
  });

  it('resolves Step level and returns empty for unknown step id', () => {
    const executed: ExecutedStepDefault[] = [
      executedStep({ id: 'e-a', stepId: 'step-a', stageId: 'stg-1' }),
      executedStep({ id: 'e-b', stepId: 'step-b', stageId: 'stg-1' }),
    ];
    expect(resolvePathSegments(executed, 1, 'step-a')).toEqual([executed[0]]);
    expect(resolvePathSegments(executed, 1, 'step-unknown')).toEqual([]);
  });

  it('falls back to the previous executed entry when inputFrom is empty', () => {
    const executed: ExecutedStepDefault[] = [
      executedStep({ id: 'e-a', stepId: 'a', stageId: 'stg-1' }),
      executedStep({ id: 'e-b', stepId: 'b', stageId: 'stg-1' }),
      executedStep({ id: 'e-c', stepId: 'c', stageId: 'stg-1' }),
    ];
    expect(resolveFromInputFrom(executed, 2, [])).toEqual([executed[1]]);
    expect(resolveFromInputFrom(executed, 0, [])).toEqual([]);
  });

  it('resolves regex mode against step output text', () => {
    const executed: ExecutedStepDefault[] = [
      executedStep({ id: 'e-a', stepId: 'a', stageId: 'stg-1', output: [{ type: 'text', text: 'generated report' }] }),
      executedStep({ id: 'e-b', stepId: 'b', stageId: 'stg-1', output: [{ type: 'text', text: 'nothing here' }] }),
    ];
    const result = resolveFromInputFrom(executed, 2, [{ id: 'in', regex: 'report' }]);
    expect(result).toEqual([executed[0]]);
  });

  it('rejects an invalid inputFrom regex with a readable error', () => {
    const executed: ExecutedStepDefault[] = [
      executedStep({ id: 'e-a', stepId: 'a', stageId: 'stg-1' }),
    ];
    expect(() => resolveFromInputFrom(executed, 1, [{ id: 'in', regex: '[' }])).toThrow(/invalid inputFrom regex/);
  });
});

// ── 缺陷 16：collectStepArtifacts（outputTo → 实际文件列表收集） ────────────────

describe('collectStepArtifacts', () => {
  /** 通用产物播种 fs：out/report.md、out/notes.md、build/a/report.md、build/b/report.md。 */
  function seededFs(): FakeFs {
    const fs = new FakeFs();
    fs.seedFile('/work/out/report.md');
    fs.seedFile('/work/out/notes.md');
    fs.seedFile('/work/build/a/report.md');
    fs.seedFile('/work/build/b/report.md');
    return fs;
  }

  it('returns an empty array when step has no outputTo', async () => {
    const fs = seededFs();
    expect(await collectStepArtifacts(fs, { outputTo: undefined }, '/work')).toEqual([]);
    expect(await collectStepArtifacts(fs, { outputTo: [] }, '/work')).toEqual([]);
  });

  it('collects files via the glob path branch (findFilesByGlob, anchored)', async () => {
    const fs = seededFs();
    const result = await collectStepArtifacts(fs, { outputTo: [{ id: 'opt-a', path: 'out/*.md' }] }, '/work');
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('opt-a');
    expect(result[0]!.value.sort()).toEqual(['/work/out/notes.md', '/work/out/report.md']);
  });

  it('collects a single file via the non-glob literal path branch (reuses fileExists)', async () => {
    const fs = seededFs();
    const result = await collectStepArtifacts(fs, { outputTo: [{ id: 'opt-p', path: 'out/report.md' }] }, '/work');
    expect(result).toEqual([{ id: 'opt-p', value: ['/work/out/report.md'] }]);
  });

  it('returns an empty value for a non-glob literal path when the file is absent', async () => {
    const fs = seededFs();
    const result = await collectStepArtifacts(fs, { outputTo: [{ id: 'opt-p', path: 'out/missing.md' }] }, '/work');
    expect(result).toEqual([{ id: 'opt-p', value: [] }]);
  });

  it('does not falsely match a non-glob literal path against nested similar files', async () => {
    const fs = new FakeFs();
    // 期望产物 output/result.txt 本身不存在；仅树内存在嵌套同名/相似文件。
    // 非 glob 分支用 fileExists 精确存在性检查（resolve + readText），不被相似文件误命中。
    fs.seedFile('/work/dist/output/result.txt');
    fs.seedFile('/work/output/result.txt.bak');
    const result = await collectStepArtifacts(fs, { outputTo: [{ id: 'opt-p', path: 'output/result.txt' }] }, '/work');
    expect(result).toEqual([{ id: 'opt-p', value: [] }]);
  });

  it('collects files via the regex branch (findFilesByRegex, unanchored tree scan)', async () => {
    const fs = seededFs();
    const result = await collectStepArtifacts(
      fs,
      { outputTo: [{ id: 'opt-re', regex: '^build/.+/report\\.md$' }] },
      '/work',
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.value.sort()).toEqual(['/work/build/a/report.md', '/work/build/b/report.md']);
  });

  it('merges path and regex results for the same outputTo item', async () => {
    const fs = seededFs();
    const result = await collectStepArtifacts(
      fs,
      { outputTo: [{ id: 'opt-mix', path: 'out/*.md', regex: '^build/.+/report\\.md$' }] },
      '/work',
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.value.sort()).toEqual([
      '/work/build/a/report.md',
      '/work/build/b/report.md',
      '/work/out/notes.md',
      '/work/out/report.md',
    ]);
  });

  it('tolerates a bad regex pattern (skips silently, returns empty value)', async () => {
    const fs = seededFs();
    const result = await collectStepArtifacts(
      fs,
      { outputTo: [{ id: 'opt-bad', regex: '[' }] },
      '/work',
    );
    expect(result).toEqual([{ id: 'opt-bad', value: [] }]);
  });

  it('returns one artifact entry per outputTo item, preserving id order', async () => {
    const fs = seededFs();
    const result = await collectStepArtifacts(
      fs,
      {
        outputTo: [
          { id: 'opt-1', path: 'out/report.md' },
          { id: 'opt-2', regex: 'report\\.md' },
        ],
      },
      '/work',
    );
    expect(result.map(a => a.id)).toEqual(['opt-1', 'opt-2']);
  });

  // ── 缺陷 34：collectStepArtifacts 用 vars 解析 outputTo 中的 ${xxx} ──────────

  it('resolves ${xxx} in a path via vars before matching (collects the real file)', async () => {
    const fs = new FakeFs();
    fs.seedFile('/work/artifacts/my-project/report.md');
    const result = await collectStepArtifacts(
      fs,
      { outputTo: [{ id: 'opt-var', path: 'artifacts/${projectName}/report.md' }] },
      '/work',
      { projectName: 'my-project' },
    );
    expect(result).toEqual([{ id: 'opt-var', value: ['/work/artifacts/my-project/report.md'] }]);
  });

  it('defers (empty value) an unresolved ${xxx} path when vars lack the variable', async () => {
    const fs = new FakeFs();
    // 播种解析后路径下的真实文件（artifacts/my-project/report.md），但字面占位路径
    // artifacts/${projectName}/report.md 不存在 → vars 缺变量时 deferred → 空值。
    fs.seedFile('/work/artifacts/my-project/report.md');
    const result = await collectStepArtifacts(
      fs,
      { outputTo: [{ id: 'opt-var', path: 'artifacts/${projectName}/report.md' }] },
      '/work',
      {},
    );
    expect(result).toEqual([{ id: 'opt-var', value: [] }]);
  });

  it('resolves ${xxx} in a regex via vars before matching', async () => {
    const fs = new FakeFs();
    fs.seedFile('/work/out/my-project.md');
    const result = await collectStepArtifacts(
      fs,
      { outputTo: [{ id: 'opt-re', regex: '^out/${projectName}\\.md$' }] },
      '/work',
      { projectName: 'my-project' },
    );
    expect(result).toEqual([{ id: 'opt-re', value: ['/work/out/my-project.md'] }]);
  });
});
