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

/**
 * 替换 `${xxx}` 透传变量：已定义**且值非空**替换为值，未定义或值为空保留原文。
 *
 * 2026-08-25（分支条件变量替换 + 空值守卫）：值为空时保留 `${xxx}` 占位符——避免
 * 替换成空导致路径粘连（如 `artifacts/${change-name}/proposal.md` + 空值 →
 * `artifacts//proposal.md` 误匹配）；占位符保留后由 `hasUnresolvedVars` 标 deferred，
 * 模型/下游可见「变量未解析」而非静默空值。
 */
export function replacePassThroughVars(str: string, vars: Readonly<Record<string, string>>): string {
  return str.replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
    const value = vars[name];
    return value === undefined || value === '' ? whole : value;
  });
}

/**
 * 检测字符串是否含未解析的 `${xxx}` 占位符（对齐基准 `hasUnresolvedVars`）。
 *
 * 缺陷 33/34 共享工具：finalize-manager 原内联正则（`hasUnresolvedPassThroughVars`/
 * `fillUnresolvedSingleVar`）与 outputTo 路径延迟解析共用同一变量语法语义。
 */
export function hasUnresolvedVars(str: string): boolean {
  return /\$\{[^}]+\}/.test(str);
}

// ── outputTo 变量解析（缺陷 34） ──────────────────────────────────────────────

/** outputTo 项解析结果：path/regex 替换后值 + 延迟标记。 */
export interface ResolvedOutputTo {
  readonly path?: string;
  readonly regex?: string;
  /** 替换后仍含未解析 `${xxx}` → true（需延迟到 finalize 后用更新后的 vars 再解析）。 */
  readonly deferred: boolean;
}

/**
 * 解析单个 outputTo 项的 `path`/`regex` 中的 `${xxx}` 透传变量占位符
 * （对齐基准 `resolveOutputToVars` L95-114）。
 *
 * 用 {@link replacePassThroughVars} 替换已定义变量；替换后仍含 `${}` 的项（变量未解析、
 * 需延迟到 finalize 再解析）标 `deferred: true` 供调用方延迟处理。**纯函数、不改输入**
 * ——返回新对象，原 outputTo 项保持只读不变，避免 finalize 评估与门禁校验之间的变量
 * 竞态（调用方各自用传入的 vars 副本解析，不依赖提前持久化）。
 *
 * @param item - outputTo 项（只取 `path`/`regex`，`id` 由调用方保留）。
 * @param vars - 透传变量字符串映射（已通过 `toVarMap` 转换）。
 */
export function resolveOutputToVars(
  item: { readonly path?: string | undefined; readonly regex?: string | undefined },
  vars: Readonly<Record<string, string>>,
): ResolvedOutputTo {
  const path = item.path === undefined ? undefined : replacePassThroughVars(item.path, vars);
  const regex = item.regex === undefined ? undefined : replacePassThroughVars(item.regex, vars);
  const deferred =
    (path !== undefined && hasUnresolvedVars(path)) ||
    (regex !== undefined && hasUnresolvedVars(regex));
  return {
    ...(path === undefined ? {} : { path }),
    ...(regex === undefined ? {} : { regex }),
    deferred,
  };
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

/**
 * 判定字符串是否为 glob 模式（对齐基准 `looksLikeGlob` 全特征检测）。
 *
 * 先排除含 regex 特征的模式——转义字符类 `\d`/`\D`/`\w`/`\W`/`\s`/`\S`/`\b`、
 * `(?`（前瞻/后瞻/非捕获）、`.*`、`.+`、`[^`（否定字符类）、`{<数字>`（量词）、
 * `^…$`（锚定）——再要求**未转义**的 `*` 或 `?` 才判为 glob。
 *
 * 修复缺陷 19：原实现只检 `\\.`（反斜杠转义）与 `(?` 两类，导致 `.*`/`[^a]*`/`foo.*`
 * 等「含 * /? 且不含 \ 与 (?」的 regex 写法被误判为 glob → 经 {@link globToRegex}
 * 静默错误匹配（`.*`→`^\.[^/]*$` 只匹配点文件、`[^a]*`→字面 `[^a]` 前缀几乎永不匹配
 * 恒报 missing）。增强后这些模式正确判为非 glob → 走 {@link fileExists} 精确存在性
 * 检查（缺陷 6 已修复：非 glob 不再走 {@link findFilesByRegex}，避免 `.*`→
 * `new RegExp('.*')` 匹配一切→门禁恒放行的联动风险）。
 *
 * 合法 glob（`out/*.log`、`out/file?.txt`、递归 `**` 通配）不含上述 regex 特征，
 * 判定不变。
 */
export function isGlobPattern(pattern: string): boolean {
  if (/\\[dDwWsSb]|\(\?|\.\*|\.\+|\[\^|\{\d|\^.*\$/.test(pattern)) return false;
  return /(?<!\\)[*?]/.test(pattern);
}

// ── 递归文件搜索 ────────────────────────────────────────────────────────────

/** 一次递归遍历命中的文件条目（目标 + 相对根目录的路径）。 */
interface WalkedFile {
  readonly target: FsTarget;
  readonly relativePath: string;
}

/**
 * 递归收集目录下全部文件。
 *
 * 跳过点**目录**（`.git`/`.vscode`/`.venv`/`.idea` 等，不递归其子树）与
 * `node_modules`，保留点**文件**（`.env`/`.gitignore` 仍可作产物收集）——折中取舍：
 * 完全对齐基准（`startsWith('.')` 跳过一切点条目）会回归「步骤生成 `.env` 后门禁
 * 校验」场景。同时消除原死判断 `entry.name === '.'`（`listDir` 只返回子项名，永不
 * 出现 `.` 子项，原条件恒假，实际只跳 node_modules；缺陷 18）。
 *
 * 权限容错：`listDir` 抛错（权限拒绝等）时跳过该子树而非中断整次遍历，对齐基准
 * `walkDir` 的 try/catch（缺陷 18 顺带补齐）。
 */
async function collectFiles(fs: FileSystem, dir: FsTarget, prefix: string, out: WalkedFile[]): Promise<void> {
  try {
    const entries = await fs.listDir(dir);
    for (const entry of entries) {
      if ((entry.name.startsWith('.') && entry.type === 'directory') || entry.name === 'node_modules') continue;
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.type === 'directory') {
        await collectFiles(fs, entry.target, relativePath, out);
      } else if (entry.type === 'file') {
        out.push({ target: entry.target, relativePath });
      }
    }
  } catch {
    // 权限拒绝等读取错误跳过该子树（对齐基准 walkDir 的 try/catch 容错）。
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

// ── 精确存在性检查（非 glob 字面路径） ────────────────────────────────────────

/**
 * 规范化拼接 `workdir` 与相对路径 `relPath`（剥除 `.`/冗余 `/` 段，处理 `..`）。
 *
 * `relPath` 以 `/` 开头视为绝对路径（忽略 `workdir`）。对齐 `node:path.resolve`
 * 在「workdir + 相对字面产物路径」场景下的可见行为，但不引入 node 依赖
 *（file-utils 保持纯函数 + fs 接缝）。内部辅助，不导出。
 */
function joinWorkdirPath(workdir: string, relPath: string): string {
  const raw = relPath.startsWith('/') ? relPath : `${workdir}/${relPath}`;
  return normalizePathSegments(raw);
}

function normalizePathSegments(path: string): string {
  const isAbsolute = path.startsWith('/');
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  const joined = out.join('/');
  if (isAbsolute) return joined === '' ? '/' : `/${joined}`;
  return joined;
}

/**
 * 精确判定 `workdir` 下相对路径 `relPath` 指向的文件是否存在（非 glob 字面路径）。
 *
 * 与 {@link findFilesByRegex} 的非锚定全树正则匹配不同：本函数对 `relPath` 做字面
 * 存在性检查（`resolve` + `readText` 不抛错即存在），避免路径中的 `.` 被当作正则
 * 元字符导致漏报（树内相似文件误命中→该报缺失却放行）或误报（`./` 前缀使非锚定
 * regex 误判→门禁恒失败）。对齐基准 `fs.existsSync(path.resolve(cwd, relPath))` 语义。
 *
 * 实现载体说明：sandore 仓库内无真实 fs 适配器（`ctx.fs` 由 DSH 宿主注入，
 * {@link FileSystem} 结构类型仅暴露 resolve/listDir/readText/writeText，无 exists
 * 原语），故用 resolve + readText 组合判定存在性——`resolve` 成功且 `readText`
 * 不抛错即存在；任一抛错（含 FS_NOT_FOUND）视为不存在。供 verifyArtifacts 非 glob
 * 分支与缺陷 #16 collectStepArtifacts 复用。
 */
export async function fileExists(fs: FileSystem, workdir: string, relPath: string): Promise<boolean> {
  const fullPath = joinWorkdirPath(workdir, relPath);
  try {
    const target = await fs.resolve(fullPath);
    await fs.readText(target);
    return true;
  } catch {
    return false;
  }
}

// ── 产物收集（outputTo → 实际文件列表） ───────────────────────────────────────

/**
 * 收集 Step 的产物文件列表（对齐基准 defact `collectStepArtifacts` L66-93）。
 *
 * 对 `step.outputTo` 每项解析实际生成的产物文件：
 * - `path` 字段：glob 模式 → {@link findFilesByGlob}；非 glob 字面路径 →
 *   {@link fileExists} 精确存在性检查（**复用缺陷 6 已落地的 fileExists**），
 *   存在则取规范化进程绝对路径；
 * - `regex` 字段：{@link findFilesByRegex}（与 verifyArtifacts 一致，不做 glob 检测）。
 *
 * **缺陷 34 联动**：每项 path/regex 先经 {@link resolveOutputToVars} 用 `vars` 替换
 * `${xxx}` 透传变量占位符，保证收集、门禁校验（{@link verifyArtifacts}）、
 * `<artifacts>` 提示词块三方使用同一份「已解析 outputTo」语义。vars 缺省为 `{}`——
 * 含 `${xxx}` 的项标 `deferred`，字面占位路径自然不命中文件 → 空值（延迟语义）。
 *
 * 同一 outputTo 项的 `path` 与 `regex` 结果合并到同一 `value`（对齐基准）。
 * 返回扁平的 {@link OutputArtifact} 列表（`id` 为 outputTo 项 id，`value` 为命中
 * 的进程绝对路径数组）。无 outputTo 时返回空数组。坏 glob/regex 容错跳过（对齐
 * 基准 try/catch 静默忽略）。
 *
 * **与 {@link verifyArtifacts} 的关系**：verifyArtifacts 只判定缺失（门禁用，返回
 * 缺失 pattern 列表），collectStepArtifacts 收集实际文件列表（收尾 AI 可见 +
 * Stage 契约 `artifacts[].files` + 前置产物块 `files`）；二者共享「解析 outputTo
 * → 匹配文件」核心逻辑（缺陷 6/16/34 联动：非 glob path 复用 fileExists 精确存在性
 * 检查，避免路径中的 `.` 被当作正则元字符导致漏报/误报；变量替换前置统一）。
 *
 * @param fs - 文件系统接缝（与 fileExists/findFilesByGlob/findFilesByRegex 同源）。
 * @param step - 含 `outputTo` 的 Step 视图（兼容 `WorkflowStep` 与 `ExecutedStepDefault`）。
 * @param workdir - 产物根目录（与 verifyArtifacts 的 workdir 一致）。
 * @param vars - 透传变量字符串映射（缺省 `{}`；含未解析占位符的项标 deferred）。
 */
export async function collectStepArtifacts(
  fs: FileSystem,
  step: { outputTo?: readonly { readonly id: string; readonly path?: string | undefined; readonly regex?: string | undefined }[] | undefined },
  workdir: string,
  vars: Readonly<Record<string, string>> = {},
): Promise<OutputArtifact[]> {
  const outputTo = step.outputTo;
  if (outputTo === undefined || outputTo.length === 0) {
    return [];
  }
  const artifacts: OutputArtifact[] = [];
  for (const item of outputTo) {
    const resolved = resolveOutputToVars(item, vars);
    const matched: string[] = [];
    if (resolved.path !== undefined) {
      if (isGlobPattern(resolved.path)) {
        try {
          matched.push(...await findFilesByGlob(fs, workdir, resolved.path));
        } catch {
          // 坏 glob 容错跳过（对齐基准 try/catch 静默忽略）。
        }
      } else if (await fileExists(fs, workdir, resolved.path)) {
        // 非 glob 字面路径：复用缺陷 6 的 fileExists 判定存在性（resolve + readText）。
        // fileExists 已成功意味着 resolve + readText 均通过，此处再 resolve 取
        // processPath 得到与 glob/regex 分支一致的进程绝对路径。
        const target = await fs.resolve(joinWorkdirPath(workdir, resolved.path));
        matched.push(fs.processPath(target));
      }
    }
    if (resolved.regex !== undefined) {
      try {
        matched.push(...await findFilesByRegex(fs, workdir, resolved.regex));
      } catch {
        // 坏 regex 容错跳过（对齐基准 try/catch 静默忽略）。
      }
    }
    artifacts.push({ id: item.id, value: matched });
  }
  return artifacts;
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
