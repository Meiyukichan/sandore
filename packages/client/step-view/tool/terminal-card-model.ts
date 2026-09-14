/**
 * terminal-card-model（B2b step-view 版）：抄自 DSH 0.1.2-rc.1
 * `ui-tool/src/client/tool/models/terminal-card-model.ts`（只读参考 deepseek-harness）。
 *
 * 从原始 Tool call/result 字段纯派生 terminal 卡 props：把 shell（bash/pwsh）或
 * terminal_send 调用变成 {@link TerminalBlock} 所绘内容（命令、cwd、输出与退出状态）。
 * 逻辑逐字保留；适配：
 * - block 面为本地断言（StepToolCallBlock/StepToolResultNode，见 step-row-data）；
 * - `resolveWorkspacePath` 用 sandore workspace-path.ts 本地复刻（DSH runtime
 *   同源逻辑，语义一致）；未安装 dsh-util-workspace-path；
 * - locale 面为 sandore 命名空间（terminal.* 键已在 sandore 字典，另补
 *   terminal.sendInput/terminal.session 两个键，zh/en 对齐 rc.1）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/tool/terminal-card-model
 */
import type { TerminalBlockLabels, TerminalBlockProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { resolveWorkspacePath } from '../../workspace-path.ts'
import type { StepToolCallBlock } from '../step-row-data.ts'
import { parsedToolCall, singleResultText, validEscalationFields } from './raw-tool-call.ts'

/**
 * 从 sandore locale seat 构建 TerminalBlock 展示文案——该包的字典与 primitive 文案
 * 面配对的地方，terminal 的每个渲染位（chat 行、bash 行）共用。
 * @param t - sandore locale seat。
 * @returns {@link TerminalBlockProps} `labels` 的完整文案集。
 */
export function terminalBlockLabels(t: TranslateNS<'sandore'>): TerminalBlockLabels {
  return {
    signal: signal => t('terminal.signal', { signal }),
    exitCode: code => t('terminal.exitCode', { code }),
    running: t('terminal.running'),
    failed: t('terminal.failed'),
    done: t('terminal.done'),
    copy: t('copy'),
    copied: t('copied'),
    noOutput: t('terminal.noOutput'),
    collapseAria: t('terminal.collapseAria'),
    collapse: t('collapse'),
    expandAria: hidden => t('terminal.expandAria', { n: hidden }),
    expand: hidden => t('terminal.expandRest', { n: hidden }),
  }
}

/**
 * 该派生拥有的 {@link TerminalBlock} props。从 primitive props 拣出，使两者同步；
 * `maxLines`/`className` 属于各渲染位。
 */
export interface TerminalCardModel {
  /** {@link TerminalBlock} 所绘的 locale 中立 props。渲染位另加 command（locale 解析后）。 */
  card: Pick<TerminalBlockProps, 'cwd' | 'output' | 'exitCode' | 'signal' | 'running'>
  /**
   * 逐字的 Tool 数据或语义化 `terminal_send` 数据。产品文案保持未解析，
   * 直到渲染位提供 locale seat。
   */
  copy:
    | { readonly kind: 'shell'; readonly command: string; readonly description: string | undefined }
    | { readonly kind: 'terminal-send'; readonly text: string; readonly sessionId: string }
}

interface LocalizedTerminalCardModel {
  readonly card: Pick<TerminalBlockProps, 'command' | 'cwd' | 'output' | 'exitCode' | 'signal' | 'running'>
  readonly description: string | undefined
}

/**
 * 解析 locale 所有的 `terminal_send` 文案，同时逐字保留 Tool 撰写的 shell 命令
 * 与 description。
 * @param model - locale 中立 terminal 卡数据。
 * @param t - sandore locale seat。
 * @returns 可渲染的 terminal props 与 description。
 */
export function localizeTerminalCardModel(
  model: TerminalCardModel,
  t: TranslateNS<'sandore'>,
): LocalizedTerminalCardModel {
  if (model.copy.kind === 'shell') {
    return {
      card: { command: model.copy.command, ...model.card },
      description: model.copy.description,
    }
  }
  return {
    card: {
      command: model.copy.text === '' ? t('terminal.sendInput') : model.copy.text,
      ...model.card,
    },
    description: t('terminal.session', { sessionId: model.copy.sessionId }),
  }
}

/**
 * 结算 terminal 卡是否报告失败退出——非零 code 或终止 signal。bash tool 把失败命令
 * 结算为完成的 call（`isError` 保持 false：退出状态是结果数据），因此这是折叠行
 * 唯一的失败信号；没有它红色退出药丸只在展开卡后才可见。
 * @param model - 派生 terminal 卡。
 * @returns 卡退出状态是否失败。
 */
export function terminalFailed(model: TerminalCardModel): boolean {
  const { exitCode, signal, running } = model.card
  return running !== true && ((exitCode !== undefined && exitCode !== 0) || signal !== undefined)
}

/**
 * 解析 shell 调用的 workdir 以展示：绝对路径原样，相对路径在会话工作区下合并，
 * 省略则用会话工作区。没有会话 cwd 时相对路径保持原样、省略保持缺席。
 * @param workdir - 原始 call 的 workdir（如有）。
 * @param sessionCwd - 会话工作区根（调用方知道的话）。
 * @returns 提示标签的工作目录，或 undefined。
 */
function resolveTerminalCwd(workdir: string | undefined, sessionCwd: string | undefined): string | undefined {
  if (workdir === undefined || workdir === '') return sessionCwd
  if (sessionCwd === undefined || sessionCwd === '') return normalizeSegments(workdir)
  return normalizeSegments(resolveWorkspacePath(sessionCwd, workdir))
}

/**
 * 折叠 `.`/`..` 段，使提示标签命名命令实际运行的目录。bash executor 在运行前
 * 解析 workdir，因此合并的 `/w/app/..` 必须显示为 `w` 而非 `..`。分隔符按原样
 * 保留（Windows 路径保留反斜杠），因为该值只用于展示；越过根的 `..` 被丢弃——
 * 文件系统也如此。UNC 路径的 `server`/`share` 是根的一部分、不是可弹出的段：
 * Windows 不能越过共享目录，所以 `\\\\server\\share` 后的 `..` 停在那里。
 * @param path - 合并或绝对路径，可能携带 `.`/`..` 段。
 * @returns 解析过这些段的同一路径。
 */
function normalizeSegments(path: string): string {
  if (!/(?:^|[/\\])\.\.?(?:[/\\]|$)/.test(path)) return path
  const unc = /^[/\\]{2}([^/\\]+)[/\\]+([^/\\]+)/.exec(path)
  if (unc !== null) {
    const [matched, server, share] = unc
    const root = `\\\\${String(server)}\\${String(share)}`
    const rest = collapse(path.slice(matched.length), true)
    return rest === '' ? root : `${root}\\${rest}`
  }
  const backslashed = path.includes('\\') && !path.includes('/')
  const separator = backslashed ? '\\' : '/'
  const rooted = /^[/\\]/.test(path)
  const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? ''
  const body = collapse(path.slice(drive.length), rooted || drive !== '', separator)
  const leading = rooted ? separator : ''
  return drive === '' ? `${leading}${body}` : `${drive}${rooted ? leading : separator}${body}`
}

/**
 * 折叠路径正文的 `.`/`..` 段，相对已知根态。
 * @param body - 去 drive 字母或 UNC 根之后的路径。
 * @param rooted - 正文挂在根上：顶部的 `..` 像文件系统那样被丢弃；无根则保留
 *   `..`（它对本函数不可见的 cwd 仍有意义）。
 * @param separator - 重新拼接的分隔符（默认 `/`）。
 * @returns 折叠后的正文，不带首尾分隔符。
 */
function collapse(body: string, rooted: boolean, separator = '/'): string {
  const kept: string[] = []
  for (const segment of body.split(/[/\\]/)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (kept.length > 0 && kept[kept.length - 1] !== '..') kept.pop()
      else if (!rooted) kept.push(segment)
      continue
    }
    kept.push(segment)
  }
  return kept.join(separator)
}

interface ShellCall {
  kind: 'shell'
  command: string
  description: string | undefined
  workdir: string | undefined
  persistent: boolean
  background: boolean
}

function shellCall(name: string, args: Record<string, unknown>): ShellCall | null {
  if (name !== 'bash' && name !== 'pwsh') return null
  const { command, description, timeoutMs, workdir, run_in_background: background } = args
  if (typeof command !== 'string' || command.trim() === '') return null
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) return null
  if (workdir !== undefined && typeof workdir !== 'string') return null
  if (background !== undefined && typeof background !== 'boolean') return null
  if (!validEscalationFields(args)) return null
  if (description === undefined) {
    // 标准 dsh-tool-bash/dsh-tool-pwsh schema 要求 `description`；持久 shell provider
    // 省略它。它们的参数根保持开放，无关字段不改变 running 卡行为。
    return { kind: 'shell', command, description: undefined, workdir: undefined, persistent: true, background: false }
  }
  if (typeof description !== 'string' || description.trim() === '') return null
  return {
    kind: 'shell',
    command,
    description,
    workdir,
    persistent: false,
    background: background === true,
  }
}

/**
 * 从持久 Bash/PowerShell tool 识别结算的根 call。它的结果留在通用输入/输出路径，
 * 因为持久 shell 可以在没有单一进程退出状态时报告 reset 与部分输出。
 * @param block - running 或 settled Tool block。
 * @returns block 是否为结算的持久 shell call。
 */
export function isSettledPersistentShellCall(block: StepToolCallBlock): boolean {
  if (!('kind' in block) || block.parentCallId !== undefined) return false
  const parsed = parsedToolCall(block)
  if (parsed === null) return false
  return shellCall(parsed.name, parsed.args)?.persistent === true
}

interface TerminalSendCall {
  kind: 'terminal-send'
  text: string
  sessionId: string
  background: boolean
}

function terminalSendCall(name: string, args: Record<string, unknown>): TerminalSendCall | null {
  if (name !== 'terminal_send') return null
  const { sessionId, text, submit, run_in_background: background } = args
  if (typeof sessionId !== 'string' || sessionId === '' || typeof text !== 'string') return null
  if (submit !== undefined && typeof submit !== 'boolean') return null
  if (background !== undefined && typeof background !== 'boolean') return null
  return {
    kind: 'terminal-send',
    text,
    sessionId,
    background: background === true,
  }
}

/**
 * 解析 `@deepseek-ai/dsh-shell/render` 拥有的标记字面量（不 import 那个 Host-only
 * 包进 Client 依赖图）。
 * @param text - 渲染后的 shell 结果文本。
 * @returns 提取尾部退出码或 signal 标记后的输出。
 */
function parseExitStatus(text: string): { output: string; exitCode?: number; signal?: string } {
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text)
  if (signal?.[1] !== undefined) return { output: text.slice(0, signal.index), signal: signal[1] }
  const exit = /\n\[exit code: (\d+)\]$/.exec(text)
  if (exit?.[1] !== undefined) return { output: text.slice(0, exit.index), exitCode: Number(exit[1]) }
  return { output: text, exitCode: 0 }
}

/**
 * 为受支持的根 shell 与 terminal-send call 派生 terminal props。标准 shell 结果
 * 解析其最终状态标记；持久 shell 结果、后台 call、错误、畸形输入或子 dispatch 走
 * 通用路径。{@link isSettledPersistentShellCall} 让通用持久结果在不发明进程状态
 * 的情况下保持可展开。
 * @param block - running 或 settled Tool block。
 * @param sessionCwd - 用于解析 workdir 的会话工作区根。
 * @returns locale 中立 terminal 卡数据；通用路径 → null。
 */
export function terminalCardModel(
  block: StepToolCallBlock,
  sessionCwd?: string,
): TerminalCardModel | null {
  if (block.parentCallId !== undefined) return null
  const parsed = parsedToolCall(block)
  if (parsed === null) return null
  const call = shellCall(parsed.name, parsed.args) ?? terminalSendCall(parsed.name, parsed.args)
  if (call === null || call.background) return null

  const copy: TerminalCardModel['copy'] = call.kind === 'shell'
    ? { kind: 'shell', command: call.command, description: call.description }
    : { kind: 'terminal-send', text: call.text, sessionId: call.sessionId }
  const cwd = resolveTerminalCwd(call.kind === 'shell' ? call.workdir : undefined, sessionCwd)
  if (!('kind' in block)) {
    return {
      copy,
      card: {
        cwd,
        output: undefined,
        exitCode: undefined,
        signal: undefined,
        running: true,
      },
    }
  }
  if (block.isError || (call.kind === 'shell' && call.persistent)) return null
  const output = singleResultText(block)
  if (output === undefined) return null
  const status = call.kind === 'terminal-send' ? { output } : parseExitStatus(output)
  return {
    copy,
    card: {
      cwd,
      output: status.output,
      exitCode: status.exitCode,
      signal: status.signal,
      running: false,
    },
  }
}
