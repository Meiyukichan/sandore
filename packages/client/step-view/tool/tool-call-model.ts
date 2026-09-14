/**
 * tool-call-model（B2b step-view 版）：抄自 DSH 0.1.2-rc.1
 * `ui-tool/src/client/tool/models/tool-call-model.ts`（只读参考 deepseek-harness）。
 *
 * 工具摘要行的纯 row-model 派生：variant 分类、单行摘要、展开时的输入正文格式、
 * 结算结果扁平文本——全部从冻结的 Tool block 叶子推导。输入素材来自调用 ARGUMENTS；
 * 输出与错误素材来自结算 result。受支持 terminal 调用的展开体由
 * terminal-card-model 提供（rc.1 分工，见其文件头）。
 *
 * 适配（全部显式、对齐 sandore 编译面）：
 * - 类型不再 import ui-chat/ui-conversation：block 面由 step-row-data 的本地断言
 *   （StepToolCallBlock/StepToolResultNode，按 unknown 叶子读取）供给，本文件只
 *   转发类型引用；
 * - `abbreviateHomePath`：rc.1 从 `@deepseek-ai/dsh-util-workspace-path` 导入，
 *   sandore 未安装该包 → 复刻自 runtime `workspaces/path.ts` 源码的本地实现
 *   （与旧路径 tool-call-model 同法；含 Windows/UNC 守卫）。面板不传 home 时恒
 *   直通（rc.1 无 host description 面时的同款直通）；
 * - 标题键：rc.1 用 `tool.title.*` conversation 键，sandore 字典以同名键镜像
 *   （zh/en 逐字对齐 rc.1），类型经 Extract<SandoreKey, `tool.title.${string}`>。
 * 其余逻辑逐字保留（variant 表/摘要键/state 派生/relativizeToCwd/formatToolBody）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/tool/tool-call-model
 */
import type { SandoreKey } from '../../locales.ts'
import type { StepToolCallBlock, StepToolResultNode } from '../step-row-data.ts'

/** Tool-call 行 variant（通用原子渲染器按名称选择）。 */
export type ToolRowVariant = 'search' | 'read' | 'bash' | 'write' | 'edit' | 'code' | 'others'

/** 行状态语义；颜色由 StateDot 自供（设计未给色）。 */
export type ToolRowState = 'running' | 'ok' | 'error' | 'stopped'

type ToolTitleKey = Extract<SandoreKey, `tool.title.${string}`>

/** 各通用 variant 的标题键（照 rc.1 VARIANT_TITLE_KEYS）。 */
export const VARIANT_TITLE_KEYS = {
  search: 'tool.title.search', read: 'tool.title.read', bash: 'tool.title.bash',
  write: 'tool.title.write', edit: 'tool.title.edit', code: 'tool.title.code',
  others: 'tool.title.generic',
} as const satisfies Record<ToolRowVariant, ToolTitleKey>

/**
 * 已知 tool 名 → variant。
 *
 * `cordis_define` 刻意缺席：ui-cordis 为它注册 keyed `tool.call.toolview` 条目，
 * keyed 命中会替换通用行（本表只经 GenericToolCard——ToolCallTree 分发 fallback
 * ——可达）。sandore 面板不注册任何 keyed toolview，故这里注册的条目都可达。
 */
const TOOL_VARIANTS: Record<string, ToolRowVariant> = {
  bash: 'bash',
  // PowerShell 孪生是 shell 工具：走 bash 行族（icon/颜色），标题用其自有键。
  pwsh: 'bash',
  read: 'read',
  web_fetch: 'read',
  web_search: 'search',
  grep: 'search',
  glob: 'search',
  write: 'write',
  edit: 'edit',
  run_code: 'code',
  cordis_package_inspect: 'read',
  cordis_runtime_inspect: 'read',
  // 三个 run-control 动词各收一个包 id 并产一张收据，通用行是既定意图而非
  // 未分类默认：没有程序可展示（那是 cordis_define 的卡）也没有文件可打开。
  // id 落在摘要槽，标题键命名该动作。
  cordis_run: 'others',
  cordis_stop: 'others',
  cordis_undefine: 'others',
}

/** 精化通用 variant 行而不替换它的 tool 自有标题键。 */
const TOOL_TITLE_KEYS: Record<string, ToolTitleKey> = {
  cordis_package_inspect: 'tool.title.inspect',
  cordis_runtime_inspect: 'tool.title.inspect',
  cordis_run: 'tool.title.runCordis',
  cordis_stop: 'tool.title.stopCordis',
  cordis_undefine: 'tool.title.removeCordis',
  pwsh: 'tool.title.pwsh',
}

/**
 * 把 tool 名分类到行 variant。
 * @param toolName - wire tool 名。
 * @returns 匹配的 variant；未知 → others。
 */
export function classifyTool(toolName: string): ToolRowVariant {
  return TOOL_VARIANTS[toolName] ?? 'others'
}

/** ToolRow 需要的一切，从冻结 slice 一次派生。 */
export interface ToolRowModel {
  variant: ToolRowVariant
  titleKey: ToolTitleKey
  summary: string
  /**
   * 来自 args（`path`/`file_path`）的文件系统路径；URL 读取与非文件工具缺席。
   * 会话 cwd 已知时由 chat 视图在打开前解析相对值。
   */
  filePath: string | undefined
  /** 原始参数 JSON（展开时才格式化）。null = 无输入节。 */
  bodyRaw: string | null
  /** 扁平结果文本（{@link resultText}）；运行中或结果无文本 → null。 */
  output: string | null
  /** error 行折叠摘要 = 结果首行；其余状态 → null。 */
  errorSummary: string | null
  state: ToolRowState
}

/**
 * 结算结果的 content 块扁平为展示文本：text 块逐字，其余形状 pretty JSON。
 * 失败调用的空 content 回退到结构化 error 的 `name: code` 行。
 * @param node - 结算结果节点。
 * @returns 扁平结果文本（可能为空）。
 */
export function resultText(node: StepToolResultNode): string {
  const parts: string[] = []
  for (const block of node.content) {
    const record = typeof block === 'object' && block !== null
      ? block as { type?: unknown; text?: unknown }
      : null
    if (record?.type === 'text' && typeof record.text === 'string') parts.push(record.text)
    else parts.push(JSON.stringify(block, null, 2))
  }
  if (parts.length === 0 && node.error !== undefined) {
    parts.push(`${node.error.name}: ${node.error.code}`)
  }
  return parts.join('\n')
}

function parseArgs(argsRaw: string): unknown {
  try {
    return JSON.parse(argsRaw)
  } catch {
    // 非 JSON args（流中截断）：摘要/正文回退原始串。
    return undefined
  }
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

function pickString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = args[key]
    if (typeof v === 'string' && v !== '') return v
  }
  return undefined
}

/** 各 variant 的摘要键偏好（args 派生；结果派生摘要是台账条目）。 */
const SUMMARY_KEYS: Record<ToolRowVariant, readonly string[]> = {
  bash: ['description', 'command'],
  read: ['path', 'file_path', 'url'],
  search: ['query', 'pattern', 'url'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  code: ['description'],
  others: [],
}

/**
 * 剥掉工作区根的绝对路径（仅展示）。
 * @param text - 要缩短的路径。
 * @param cwd - 会话工作区根；缺席/空则路径原样。
 * @returns 相对工作区根的路径；不根植于其下时原样。
 */
export function relativizeToCwd(text: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return text
  const root = cwd.replace(/[/\\]+$/, '')
  if (text.startsWith(`${root}/`) || text.startsWith(`${root}\\`)) return text.slice(root.length + 1)
  return text
}

/** Drive-letter 或 UNC 路径；Web 展示不得把这些改写成 `~`。 */
function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith('\\\\')
}

/**
 * 仅展示的 POSIX home 缩写（runtime `workspaces/path.ts` 源码复刻）。
 * Windows drive/UNC 路径逐字保留，包括 home 本身为 Windows 路径时。缺席/空/
 * 文件系统根 home 让 path 原样，`/` 不能变成 `~`。
 * @param path - 绝对或已缩短的展示路径。
 * @param home - host account home；缺席跳过缩写。
 * @returns POSIX home 及其后代 → `~`/`~/…`，否则原样。
 */
export function abbreviateHomePath(path: string, home?: string): string {
  if (home === undefined || home === '') return path
  if (isWindowsStylePath(path) || isWindowsStylePath(home)) return path
  const root = home.replace(/\/+$/, '')
  if (root === '' || root === '/') return path
  if (path.replace(/\/+$/, '') === root) return '~'
  if (path.startsWith(`${root}/`)) return `~${path.slice(root.length)}`
  return path
}

function deriveSummary(variant: ToolRowVariant, argsRaw: string): string {
  const parsed = parseArgs(argsRaw)
  if (typeof parsed !== 'object' || parsed === null) return firstLine(argsRaw)
  const args = parsed as Record<string, unknown>
  if (variant === 'search' && Array.isArray(args.queries)) {
    const queries = args.queries.filter((query): query is string => typeof query === 'string' && query !== '')
    if (queries.length > 0) return queries.map(firstLine).join(', ')
  }
  const picked = pickString(args, SUMMARY_KEYS[variant])
  if (picked !== undefined) return firstLine(picked)
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v !== '') return firstLine(v)
  }
  return firstLine(argsRaw)
}

/** 路径键——绝不含 `url`（web_fetch 落 read variant 的摘要键处理）。 */
const FILE_PATH_KEYS = ['path', 'file_path'] as const

/** 摘要可为可打开工作区路径的文件工具 variant。 */
const FILE_PATH_VARIANTS: ReadonlySet<ToolRowVariant> = new Set(['read', 'write', 'edit'])

function deriveFilePath(variant: ToolRowVariant, argsRaw: string): string | undefined {
  if (!FILE_PATH_VARIANTS.has(variant)) return undefined
  const parsed = parseArgs(argsRaw)
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const picked = pickString(parsed as Record<string, unknown>, FILE_PATH_KEYS)
  return picked === undefined ? undefined : firstLine(picked)
}

/**
 * 通用输入正文在其可见时格式化一份参数 payload。
 * @param variant - 为 Tool 名选中的行呈现。
 * @param argsRaw - 原始参数 JSON 或不完整原文。
 * @returns 展示正文；空输入 → null。
 */
export function formatToolBody(variant: ToolRowVariant, argsRaw: string): string | null {
  if (argsRaw === '') return null
  const parsed = parseArgs(argsRaw)
  if (parsed === undefined) return argsRaw
  // code 行展开体就是程序本体（行 variant 样式的等宽），不是它外面的 args JSON 信封。
  if (variant === 'code' && typeof parsed === 'object' && parsed !== null) {
    const code = (parsed as Record<string, unknown>).code
    if (typeof code === 'string' && code !== '') return code
  }
  return JSON.stringify(parsed, null, 2)
}

/**
 * 从冻结 call slice 派生完整 row model。
 * @param toolName - wire tool 名（dispatch 供给；窗口截断的 result 也存活）。
 * @param block - RunningToolCall 或 ToolResultNode（本地断言面）。
 * @param cwd - 会话工作区根；工作区根路径摘要相对其显示。
 * @param home - host account home；遗留 POSIX home 路径显示为 `~`。
 * @returns row model。
 */
export function toolRowModel(
  toolName: string,
  block: StepToolCallBlock,
  cwd?: string,
  home?: string,
): ToolRowModel {
  const variant = classifyTool(toolName)
  const done = 'kind' in block
  const argsRaw = (done ? block.call?.argsRaw : block.argsRaw) ?? ''
  const state: ToolRowState = !done ? 'running'
    : block.error?.code === 'interrupted' ? 'stopped'
      : block.isError ? 'error' : 'ok'
  const base = argsRaw === ''
    ? block.callId
    : abbreviateHomePath(relativizeToCwd(deriveSummary(variant, argsRaw), cwd), home)
  const toolTitleKey = TOOL_TITLE_KEYS[toolName]
  // others 保持静态 "Tool call" 标题（figma 字面）；真实 tool 名骑在可变摘要槽，
  // 除非该 tool 拥有特定标题。
  const summary = variant === 'others' && toolName !== '' && toolTitleKey === undefined
    ? `${toolName} · ${base}`
    : base
  // 空串对两个派生结果字段都表示「无文本」：空 content 的结算 call 无物可展开；
  // 空首行会抹掉 error 行折叠摘要槽。
  const output = done ? (resultText(block) || null) : null
  const errorSummary = state === 'error' && output !== null ? firstLine(output) : null
  const bodyRaw = argsRaw === '' ? null : argsRaw
  return {
    variant,
    titleKey: toolTitleKey ?? VARIANT_TITLE_KEYS[variant],
    summary,
    filePath: deriveFilePath(variant, argsRaw),
    bodyRaw,
    output,
    errorSummary,
    state,
  }
}
