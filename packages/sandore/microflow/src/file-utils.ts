/**
 * 产物收集与输入解析工具集（纯函数 + 文件系统接缝）。
 *
 * 提供四组能力：
 * - 透传变量替换：`replacePassThroughVars`（含 `in-loop-turn`/`all-loop-turn`）；
 * - glob→regex 转换与自动区分：`globToRegex`/`escapeRegexChar`/`isGlobPattern`；
 * - 递归文件搜索：`walkDir`/`findFilesByGlob`/`findFilesByRegex`；
 * - 产物文件读写：`writeOutputJson`/`readOutputJson`（`{uuid}_output.json`）；
 * - InputFrom 就近匹配：`resolvePathSegments`/`resolveFromInputFrom`/`idMatches`。
 *
 * 文件系统经 `FileSystem` 结构类型接缝（target 导向两段式协议：先 `resolve` 得
 * `FsTarget`，再以 target 调 `listDir`/`readText`/`writeText`）注入，函数接受
 * `fs` 结构类型作为入参，不硬绑 `ctx`。`@deepseek-ai/dsh-fs` 未作为 sandore 运行
 * 时依赖安装，本文件按 `shell.ts`/`subagents.ts` 范式复刻最小结构类型并声明
 * `ctx.fs` 上下文键，宿主运行时注入的真实服务结构兼容即可。
 * @module @deepseek-ai/dsh-sandore-microflow/src/file-utils
 */
import type { ExecutedStepDefault, InputFromItem } from '@deepseek-ai/dsh-sandore-workflow/src/types';
import { textSummary } from './internal.ts';

// ── 文件系统接缝（target 导向两段式协议） ───────────────────────────────────

/** 不透明文件系统目标（`resolve` 返回；`targetKey` 仅供后端识别）。 */
export interface FsTarget {
  readonly targetKey: string;
  readonly displayPath: string;
}

/** `listDir` 返回的单个子项（`type` 判定目录性，`target` 供后续递归/读写）。 */
export interface FsDirEntry {
  readonly name: string;
  readonly type: 'file' | 'directory' | 'other';
  readonly target: FsTarget;
}

/** `writeText` 的写入结果。 */
export interface FsWriteOutcome {
  readonly operation: 'create' | 'update';
  readonly version: string;
  readonly before: string | null;
  readonly after: string;
}

/** 文件系统最小结构接缝（target 导向）。 */
export interface FileSystem {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>;
  processPath(target: FsTarget): string;
  listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>;
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>;
  writeText(target: FsTarget, content: string): Promise<FsWriteOutcome>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    fs: FileSystem;
  }
}

// ── 透传变量替换 ────────────────────────────────────────────────────────────

/** 替换 `${xxx}` 透传变量：已定义替换为值，未定义保留原文。 */
export function replacePassThroughVars(str: string, vars: Readonly<Record<string, string>>): string {
  return str.replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
    const value = vars[name];
    return value === undefined ? whole : value;
  });
}

// ── glob / regex 转换与自动区分 ─────────────────────────────────────────────

/** 转义单个正则元字符（非元字符原样返回）。 */
export function escapeRegexChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/** 将 glob 模式转换为锚定正则：`*`→`[^/]*`、`**`→`.*`（跳过后续 `/`）、`?`→`[^/]`。 */
export function globToRegex(glob: string): RegExp {
  let pattern = '^';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        pattern += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += escapeRegexChar(char);
    }
  }
  pattern += '$';
  return new RegExp(pattern);
}

/** 含 `*`/`?` 且无 regex 特征（反斜杠转义或 `(?`）时判定为 glob，否则视为 regex/字面路径。 */
export function isGlobPattern(pattern: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) return false;
  return !/\\.|\(\?/.test(pattern);
}

// ── 递归文件搜索 ────────────────────────────────────────────────────────────

/** 一次递归遍历命中的文件条目（目标 + 相对根目录的路径）。 */
interface WalkedFile {
  readonly target: FsTarget;
  readonly relativePath: string;
}

/** 递归收集目录下全部文件（跳过 `.` 与 `node_modules`）。 */
async function collectFiles(fs: FileSystem, dir: FsTarget, prefix: string, out: WalkedFile[]): Promise<void> {
  const entries = await fs.listDir(dir);
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === 'node_modules') continue;
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.type === 'directory') {
      await collectFiles(fs, entry.target, relativePath, out);
    } else if (entry.type === 'file') {
      out.push({ target: entry.target, relativePath });
    }
  }
}

/** 递归遍历目录，返回全部文件的进程绝对路径数组。 */
export async function walkDir(fs: FileSystem, dir: FsTarget): Promise<string[]> {
  const out: WalkedFile[] = [];
  await collectFiles(fs, dir, '', out);
  return out.map(file => fs.processPath(file.target));
}

/** 按 glob 模式搜索 `rootDir` 下匹配的文件，返回进程绝对路径数组。 */
export async function findFilesByGlob(fs: FileSystem, rootDir: string, pattern: string): Promise<string[]> {
  const regex = globToRegex(pattern);
  const root = await fs.resolve(rootDir);
  const out: WalkedFile[] = [];
  await collectFiles(fs, root, '', out);
  return out.filter(file => regex.test(file.relativePath)).map(file => fs.processPath(file.target));
}

/** 按正则搜索 `rootDir` 下相对路径匹配的文件，返回进程绝对路径数组。 */
export async function findFilesByRegex(fs: FileSystem, rootDir: string, regex: string): Promise<string[]> {
  let re: RegExp;
  try {
    re = new RegExp(regex);
  } catch (error) {
    throw new Error(`invalid regex '${regex}': ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = await fs.resolve(rootDir);
  const out: WalkedFile[] = [];
  await collectFiles(fs, root, '', out);
  return out.filter(file => re.test(file.relativePath)).map(file => fs.processPath(file.target));
}

// ── {uuid}_output.json 读写 ─────────────────────────────────────────────────

/** 单个 outputTo 的产物列表（写入 `{uuid}_output.json`）。 */
export interface OutputArtifact {
  readonly id: string;
  readonly value: string[];
}

/** `{uuid}_output.json` 的完整结构。 */
export interface StepOutputFile {
  readonly sessionId: string;
  readonly output: {
    readonly returnPrompt: string;
    readonly artifacts: OutputArtifact[];
  };
}

/** 由 stepMessageId 推导产物文件名。 */
export function outputJsonFileName(stepMessageId: string): string {
  return `${stepMessageId}_output.json`;
}

/** 写入 `{stepMessageId}_output.json`，返回文件进程绝对路径。 */
export async function writeOutputJson(
  fs: FileSystem,
  dir: string,
  stepMessageId: string,
  data: StepOutputFile,
): Promise<string> {
  const target = await fs.resolve(`${dir}/${outputJsonFileName(stepMessageId)}`);
  await fs.writeText(target, JSON.stringify(data, null, 2));
  return fs.processPath(target);
}

/** 校验并解析产物文件 JSON（`JSON.parse` 返回 unknown，逐字段校验形状）。 */
function parseOutputJson(text: string): StepOutputFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`malformed output json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('malformed output json: root is not an object');
  }
  const sessionId = (raw as { sessionId?: unknown }).sessionId;
  const output = (raw as { output?: unknown }).output;
  if (typeof sessionId !== 'string') {
    throw new Error('malformed output json: sessionId is not a string');
  }
  if (typeof output !== 'object' || output === null) {
    throw new Error('malformed output json: output is not an object');
  }
  const returnPrompt = (output as { returnPrompt?: unknown }).returnPrompt;
  const artifacts = (output as { artifacts?: unknown }).artifacts;
  if (typeof returnPrompt !== 'string') {
    throw new Error('malformed output json: output.returnPrompt is not a string');
  }
  if (!Array.isArray(artifacts)) {
    throw new Error('malformed output json: output.artifacts is not an array');
  }
  const parsedArtifacts: OutputArtifact[] = artifacts.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`malformed output json: artifacts[${index}] is not an object`);
    }
    const id = (item as { id?: unknown }).id;
    const value = (item as { value?: unknown }).value;
    if (typeof id !== 'string') {
      throw new Error(`malformed output json: artifacts[${index}].id is not a string`);
    }
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) {
      throw new Error(`malformed output json: artifacts[${index}].value is not a string array`);
    }
    return { id, value };
  });
  return { sessionId, output: { returnPrompt, artifacts: parsedArtifacts } };
}

/** 读回并校验 `{stepMessageId}_output.json`。 */
export async function readOutputJson(fs: FileSystem, dir: string, stepMessageId: string): Promise<StepOutputFile> {
  const target = await fs.resolve(`${dir}/${outputJsonFileName(stepMessageId)}`);
  const text = await fs.readText(target);
  return parseOutputJson(text);
}

// ── InputFrom 就近匹配 ──────────────────────────────────────────────────────

/** 后缀匹配：`actualId === targetId` 或 `actualId` 以 `targetId-` 开头（循环带后缀 id）。 */
export function idMatches(actualId: string, targetId: string): boolean {
  return actualId === targetId || actualId.startsWith(`${targetId}-`);
}

/** 判断某条已执行 Step 是否匹配 stepId（对 `stepId ?? id` 做后缀匹配）。 */
function matchesStepId(step: ExecutedStepDefault, stepId: string): boolean {
  return idMatches(step.stepId ?? step.id, stepId);
}

/**
 * 按 `path` 就近匹配已执行 Step。
 *
 * 简化格式：`path` 直接为 Step id（单段），自执行列表末尾往前最近匹配同名 Step
 * （`idMatches` 支持循环后缀 id）；不再支持 `stageId.stepId` / `stageId.stepId.opt-xxx`。
 * @param executedSteps - 扁平已执行 Step（含循环迭代条目）。
 * @param _currentIndex - 保留参数（兼容调用方）。
 * @param path - 引用的 Step id。
 */
export function resolvePathSegments(
  executedSteps: readonly ExecutedStepDefault[],
  _currentIndex: number,
  path: string,
): ExecutedStepDefault[] {
  for (let i = executedSteps.length - 1; i >= 0; i--) {
    const step = executedSteps[i]!;
    if (matchesStepId(step, path)) return [step];
  }
  return [];
}

/**
 * 解析 `inputFromItems` 为就近命中的已执行 Step。
 *
 * 每项 `path` 走 {@link resolvePathSegments}，`regex` 遍历全部 Step 输出文本做正则
 * 匹配（倒序最近优先）；`inputFromItems` 为空时回退前一条执行条目
 * （`currentIndex - 1`）。
 */
export function resolveFromInputFrom(
  executedSteps: readonly ExecutedStepDefault[],
  currentIndex: number,
  inputFromItems: readonly InputFromItem[],
): ExecutedStepDefault[] {
  if (inputFromItems.length === 0) {
    const previous = executedSteps[currentIndex - 1];
    return previous === undefined ? [] : [previous];
  }
  const result: ExecutedStepDefault[] = [];
  for (const item of inputFromItems) {
    if (item.path !== undefined) {
      result.push(...resolvePathSegments(executedSteps, currentIndex, item.path));
    } else if (item.regex !== undefined) {
      let regex: RegExp;
      try {
        regex = new RegExp(item.regex);
      } catch (error) {
        throw new Error(`invalid inputFrom regex '${item.regex}': ${error instanceof Error ? error.message : String(error)}`);
      }
      const matched = executedSteps.filter(step => regex.test(textSummary(step.output)));
      result.push(...matched.reverse());
    }
  }
  return result;
}
