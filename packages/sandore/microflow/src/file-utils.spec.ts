/**
 * file-utils.ts（产物收集与输入解析工具）的单元测试。
 *
 * 覆盖 glob→regex 转换、glob/regex 自动区分、透传变量替换、递归文件搜索、
 * `{uuid}_output.json` 读写、InputFrom 就近匹配（三种 path + 回退 + regex 模式）。
 * 文件系统依赖经自建 `FakeFs`（内存实现 target 导向两段式协议）注入。
 * @module @deepseek-ai/dsh-sandore-microflow/src/file-utils.spec
 */
import { describe, expect, it } from 'vitest';

import type { ExecutedStepDefault } from '../../workflow/src/types.ts';
import {
  escapeRegexChar,
  findFilesByGlob,
  findFilesByRegex,
  globToRegex,
  idMatches,
  isGlobPattern,
  readOutputJson,
  replacePassThroughVars,
  resolveFromInputFrom,
  resolvePathSegments,
  walkDir,
  writeOutputJson,
} from './file-utils.ts';
import type { FileSystem, FsDirEntry, FsTarget, FsWriteOutcome, StepOutputFile } from './file-utils.ts';

/** 内存文件系统（target 导向两段式协议）：`files` 存文件内容，`dirs` 存目录。 */
class FakeFs implements FileSystem {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();

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
    const result = resolvePathSegments(executed, 2, 'stg-1.step-a');
    expect(result).toEqual([executed[1]]);
  });

  it('resolves Step level to the previous iteration, skipping the current self-referential entry', () => {
    const executed: ExecutedStepDefault[] = [
      executedStep({ id: 'step-step-a-0001', stepId: 'step-a-0001', stageId: 'stg-1' }),
      executedStep({ id: 'step-step-a-49aa', stepId: 'step-a-49aa', stageId: 'stg-1' }),
    ];
    // currentIndex 指向当前（第二条）迭代条目；就近匹配应命中上一条而非当前条目。
    const result = resolvePathSegments(executed, 1, 'stg-1.step-a');
    expect(result).toEqual([executed[0]]);
  });

  it('resolves Stage level to all steps in the stage, nearest first', () => {
    const executed: ExecutedStepDefault[] = [
      executedStep({ id: 'e-a', stepId: 'a', stageId: 'stg-1' }),
      executedStep({ id: 'e-b', stepId: 'b', stageId: 'stg-1' }),
      executedStep({ id: 'e-c', stepId: 'c', stageId: 'stg-2' }),
    ];
    const result = resolvePathSegments(executed, 2, 'stg-1');
    expect(result).toEqual([executed[1], executed[0]]);
  });

  it('resolves OutputTo level by filtering the specific outputTo id', () => {
    const executed: ExecutedStepDefault[] = [
      executedStep({
        id: 'e-a',
        stepId: 'step-a',
        stageId: 'stg-1',
        outputTo: [{ id: 'opt-x' }, { id: 'opt-y' }],
      }),
      executedStep({ id: 'e-b', stepId: 'step-b', stageId: 'stg-1' }),
    ];
    expect(resolvePathSegments(executed, 1, 'stg-1.step-a.opt-x')).toEqual([executed[0]]);
    expect(resolvePathSegments(executed, 1, 'stg-1.step-a.opt-z')).toEqual([]);
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
