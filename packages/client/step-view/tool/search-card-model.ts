/**
 * search-card-model（B2b step-view 版）：抄自 DSH 0.1.2-rc.1
 * `ui-tool/src/client/tool/models/search-card-model.ts`（只读参考 deepseek-harness）。
 * 从原始 grep/glob 结果元数据纯派生 search 卡。block 面为本地断言，其余逐字保留。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/tool/search-card-model
 */
import type { SearchBlockProps, SearchFileGroup } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StepToolCallBlock } from '../step-row-data.ts'
import { parsedToolCall } from './raw-tool-call.ts'

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

/** {@link SearchBlockProps} 联合减去各渲染位自有字段。 */
type SearchBlockModelProps = DistributiveOmit<SearchBlockProps, 'labels' | 'maxLines' | 'className'>

/** Chat 卡在折叠中部前保留的结果行。 */
export const CHAT_SEARCH_MAX_LINES = 8

/** Search 卡 props 加可选定位器（截断完整结果用）。 */
export interface SearchCardModel {
  /** {@link SearchBlock} 消费的 props。 */
  card: SearchBlockModelProps
  /** 含截断 search 完整结果定位器的原始结果文本。 */
  recovery: string | undefined
}

function validSearchCall(block: StepToolCallBlock): 'grep' | 'glob' | null {
  const call = parsedToolCall(block)
  if (call === null) return null
  const { pattern, path } = call.args
  if (typeof pattern !== 'string') return null
  if (call.name === 'grep' && pattern === '') return null
  if (call.name === 'glob' && pattern.trim() === '') return null
  if (call.name !== 'grep' && call.name !== 'glob') return null
  if (path !== undefined && (typeof path !== 'string' || path.trim() === '')) return null
  if (call.name === 'grep') {
    const { include } = call.args
    if (include !== undefined && (typeof include !== 'string' || !validInclude(include))) return null
  }
  return call.name
}

function validInclude(include: string): boolean {
  if (include.trim() === '' || include.startsWith('!')) return false
  let braceDepth = 0
  for (const character of include) {
    if (character === '{') braceDepth += 1
    else if (character === '}') braceDepth = Math.max(0, braceDepth - 1)
    else if (character === ',' && braceDepth === 0) return false
  }
  return true
}

function searchFiles(value: unknown): SearchFileGroup[] | null {
  if (!Array.isArray(value)) return null
  const files: SearchFileGroup[] = []
  for (const file of value) {
    if (typeof file !== 'object' || file === null || Array.isArray(file)) return null
    const { path, matches } = file as Record<string, unknown>
    if (typeof path !== 'string' || !Array.isArray(matches)) return null
    const narrowed: { lineNumber: number; line: string }[] = []
    for (const match of matches) {
      if (typeof match !== 'object' || match === null || Array.isArray(match)) return null
      const { lineNumber, line } = match as Record<string, unknown>
      if (typeof lineNumber !== 'number' || !Number.isInteger(lineNumber) || lineNumber < 1) return null
      if (typeof line !== 'string') return null
      narrowed.push({ lineNumber, line })
    }
    files.push({ path, matches: narrowed })
  }
  return files
}

function flattenContent(content: readonly unknown[]): string | undefined {
  const text = content
    .filter((block): block is { type: 'text'; text: string } => {
      if (typeof block !== 'object' || block === null) return false
      const record = block as { type?: unknown; text?: unknown }
      return record.type === 'text' && typeof record.text === 'string'
    })
    .map(block => block.text)
    .join('\n')
  return text === '' ? undefined : text
}

/**
 * 从持久化元数据派生结算根 grep/glob 卡。
 * @param block - running 或 settled Tool block。
 * @returns search 卡 props；通用路径 → null。
 */
export function searchCardModel(block: StepToolCallBlock): SearchCardModel | null {
  if (block.parentCallId !== undefined || !('kind' in block) || block.isError) return null
  const tool = validSearchCall(block)
  if (tool === null) return null
  if (typeof block.meta !== 'object' || block.meta === null || Array.isArray(block.meta)) return null
  const meta = block.meta as Record<string, unknown>
  if (typeof meta.truncated !== 'boolean') return null
  if (typeof meta.total !== 'number' || !Number.isInteger(meta.total) || meta.total < 0) return null
  const common = { truncated: meta.truncated, total: meta.total }
  const recovery = meta.truncated ? flattenContent(block.content) : undefined
  if (tool === 'grep') {
    if (meta.shape !== 'matches') return null
    const files = searchFiles(meta.files)
    return files === null ? null : { recovery, card: { kind: 'matches', files, ...common } }
  }
  if (meta.shape !== 'paths' || !Array.isArray(meta.paths)) return null
  if (!meta.paths.every((path): path is string => typeof path === 'string')) return null
  return { recovery, card: { kind: 'paths', paths: [...meta.paths], ...common } }
}
