/**
 * diff-card-model（B2b step-view 版）：抄自 DSH 0.1.2-rc.1
 * `ui-tool/src/client/tool/models/diff-card-model.ts`（只读参考 deepseek-harness）。
 * 从原始 file-mutation call 与结果元数据纯派生 diff 卡。block 面为本地断言，
 * 其余逐字保留。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/tool/diff-card-model
 */
import type { DiffBlockProps, DiffHunk } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StepToolCallBlock } from '../step-row-data.ts'
import { parsedToolCall, validEscalationFields } from './raw-tool-call.ts'

/**
 * chat 行在折叠中部前展示的 diff 正文行数——primitive 自身默认值的一半，详情面保留
 * 另一半。chat 行是消息流内的摘要面：流要在多个 call 间保持可扫读，详情面才是单
 * call 阅读面。这是该 UI 行几何的设计常量，不是部署选择。
 */
export const CHAT_DIFF_MAX_LINES = 8

/**
 * 该派生拥有的 {@link DiffBlock} props。从 primitive props 拣出，使两者同步；
 * `maxLines`/`className` 属于各渲染位。
 */
export interface DiffCardModel {
  /** {@link DiffBlock} 所绘 props。嵌套对象使渲染位展开 primitive 自身面。 */
  card: Pick<DiffBlockProps, 'diffs'>
}

/**
 * 把不透明结果元数据的 `diffs` 窄化为良构 hunks。
 * @param diffs - 待校验的元数据字段。
 * @returns 校验后的 hunks；payload 不可用 → null。
 */
function narrowDiffs(diffs: unknown): DiffHunk[] | null {
  if (!Array.isArray(diffs) || diffs.length === 0) return null
  const out: DiffHunk[] = []
  for (const hunk of diffs) {
    if (typeof hunk !== 'object' || hunk === null) return null
    const { path, oldText, newText } = hunk as Record<string, unknown>
    if (typeof path !== 'string') return null
    if (oldText !== null && typeof oldText !== 'string') return null
    if (typeof newText !== 'string') return null
    out.push({ path, oldText, newText })
  }
  return out
}

type IntendedDiff = { tool: 'write' | 'edit' | 'str_replace_editor'; diff: DiffHunk }

function intendedDiff(block: StepToolCallBlock): IntendedDiff | null {
  const parsed = parsedToolCall(block)
  if (parsed === null) return null
  if (parsed.name === 'str_replace_editor') {
    const { command, path, file_text: fileText, old_str: oldText, new_str: newText } = parsed.args
    if (typeof path !== 'string' || path.trim() === '') return null
    if (command === 'create') {
      if (fileText !== undefined && typeof fileText !== 'string') return null
      return {
        tool: 'str_replace_editor',
        diff: { path, oldText: null, newText: fileText ?? '' },
      }
    }
    if (command === 'str_replace') {
      if (oldText !== undefined && typeof oldText !== 'string') return null
      if (newText !== undefined && typeof newText !== 'string') return null
      return {
        tool: 'str_replace_editor',
        diff: { path, oldText: oldText ?? null, newText: newText ?? '' },
      }
    }
    return null
  }
  const { file_path: path } = parsed.args
  if (typeof path !== 'string' || path.trim() === '') return null
  if (!validEscalationFields(parsed.args)) return null
  if (parsed.name === 'write') {
    const { content } = parsed.args
    return typeof content === 'string'
      ? { tool: 'write', diff: { path, oldText: null, newText: content } }
      : null
  }
  if (parsed.name !== 'edit') return null
  const { old_string: oldText, new_string: newText, replace_all: replaceAll } = parsed.args
  if (typeof oldText !== 'string' || typeof newText !== 'string') return null
  if (replaceAll !== undefined && typeof replaceAll !== 'boolean') return null
  return { tool: 'edit', diff: { path, oldText: oldText || null, newText } }
}

function appliedDiffs(meta: unknown): DiffHunk[] | 'empty' | null {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null
  const diffs = (meta as Record<string, unknown>).diffs
  if (!Array.isArray(diffs)) return null
  if (diffs.length === 0) return 'empty'
  return narrowDiffs(diffs)
}

/**
 * 为根 write/edit 与 `str_replace_editor` create/replace call 派生 running diffs，
 * 为根 write/edit call 派生 applied settled diffs。成功的 write 携带合法空元数据时
 * 使用其参数派生的整文件 diff，与 create 和相同覆盖的展示一致；
 * `str_replace_editor` 经 Generic 结算（它没有结果视图）。
 * @param block - running 或 settled Tool block。
 * @returns diff 卡 props；通用路径 → null。
 */
export function diffCardModel(block: StepToolCallBlock): DiffCardModel | null {
  if (block.parentCallId !== undefined) return null
  const intended = intendedDiff(block)
  if (intended === null) return null
  if (!('kind' in block)) return { card: { diffs: [intended.diff] } }
  if (intended.tool === 'str_replace_editor') return null
  if (block.isError) return null
  const applied = appliedDiffs(block.meta)
  if (applied === null || applied === 'empty') {
    return intended.tool === 'write' ? { card: { diffs: [intended.diff] } } : null
  }
  return { card: { diffs: applied } }
}
