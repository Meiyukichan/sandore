/**
 * read-card-model（B2b step-view 版）：抄自 DSH 0.1.2-rc.1
 * `ui-tool/src/client/tool/models/read-card-model.ts`（只读参考 deepseek-harness）。
 * 从原始结果 content 与元数据纯派生 read 卡。block 面为本地断言（含 `abbreviateHomePath`
 * 本地复刻——见 tool-call-model.ts），其余逐字保留。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/tool/read-card-model
 */
import type { ReadBlockLine, ReadBlockProps } from '@deepseek-ai/dsh-client-ui-primitives'
import { abbreviateHomePath, relativizeToCwd } from './tool-call-model.ts'
import type { StepToolCallBlock } from '../step-row-data.ts'
import { parsedToolCall, singleResultText } from './raw-tool-call.ts'

/**
 * chat 行常驻 read 正文在折叠中部前展示的行数——primitive 自身默认值的一半，详情面
 * 保留另一半。chat 行是消息流内的摘要面：流要在多个 call 间保持可扫读，详情面才是
 * 单 call 阅读面。设计常量（同 {@link CHAT_DIFF_MAX_LINES} 对 terminal 输出的划分）。
 */
export const CHAT_READ_MAX_LINES = 8

/**
 * 该派生拥有的 {@link ReadBlock} props。从 primitive props 拣出，使两者同步；
 * `maxLines`/`className` 属于各渲染位。
 */
export type ReadCardModel = Pick<ReadBlockProps, 'label' | 'lines' | 'totalLines' | 'lang'>

interface ReadMeta {
  path: string
  offset: number
  lines: ReadBlockLine[]
  totalLines: number
  lang?: string
}

function validReadCall(block: StepToolCallBlock): boolean {
  const call = parsedToolCall(block)
  if (call?.name !== 'read') return false
  const { file_path: path, offset, limit } = call.args
  if (typeof path !== 'string' || path.trim() === '') return false
  if (offset !== undefined && (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 1)) return false
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) return false
  return true
}

function readMeta(meta: unknown): ReadMeta | null {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null
  const { path, offset, lines, totalLines, lang } = meta as Record<string, unknown>
  if (typeof path !== 'string' || typeof offset !== 'number' || !Number.isInteger(offset) || offset < 1) return null
  if (typeof totalLines !== 'number' || !Number.isInteger(totalLines) || totalLines < 0 || !Array.isArray(lines)) return null
  if (lang !== undefined && typeof lang !== 'string') return null
  const narrowed: ReadBlockLine[] = []
  let previous = offset - 1
  for (const line of lines) {
    if (typeof line !== 'object' || line === null || Array.isArray(line)) return null
    const { number, text } = line as Record<string, unknown>
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number <= previous) return null
    if (number > totalLines || typeof text !== 'string') return null
    previous = number
    narrowed.push({ number, text })
  }
  return {
    path,
    offset,
    lines: narrowed,
    totalLines,
    ...lang === undefined ? {} : { lang },
  }
}

/**
 * 校验持久化元数据与模型面 read 信封后派生结算根 read 卡。
 * @param block - running 或 settled Tool block。
 * @param sessionCwd - 会话工作区根；工作区根绝对路径标签相对其显示。缺席保持原样。
 * @param home - host account home；遗留 POSIX home 路径显示为 `~`。
 * @returns read 卡 props；通用路径 → null。
 */
export function readCardModel(
  block: StepToolCallBlock,
  sessionCwd?: string,
  home?: string,
): ReadCardModel | null {
  if (block.parentCallId !== undefined || !('kind' in block) || block.isError) return null
  if (!validReadCall(block)) return null
  const meta = readMeta(block.meta)
  if (meta === null) return null
  const text = singleResultText(block)
  if (text === undefined) return null
  const body = /^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u.exec(text)?.[1]
  if (body === undefined) return null
  return {
    label: abbreviateHomePath(relativizeToCwd(meta.path, sessionCwd), home),
    lines: meta.lines,
    totalLines: meta.totalLines,
    lang: meta.lang,
  }
}
