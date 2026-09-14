/**
 * raw-tool-call（B2b step-view 版）：抄自 DSH 0.1.2-rc.1
 * `ui-tool/src/client/tool/models/raw-tool-call.ts`（只读参考 deepseek-harness）。
 * 卡片模型共用的原始 Tool call/result 字段窄化：block 面用本地断言
 * （StepToolCallBlock），其余逐字保留。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/tool/raw-tool-call
 */
import type { StepToolCallBlock, StepToolResultNode } from '../step-row-data.ts'

/** 已解析、窗口内的 Tool call，其参数为 JSON 对象。 */
export interface ParsedToolCall {
  name: string
  args: Record<string, unknown>
}

const parsedCalls = new WeakMap<StepToolCallBlock, ParsedToolCall | null>()

/**
 * 解析与一个不可变 Tool block 配对的调用头。
 * @param block - running 或 settled Tool block。
 * @returns Tool 名与对象参数；调用头或合法 JSON 对象不可用时 → null。
 */
export function parsedToolCall(block: StepToolCallBlock): ParsedToolCall | null {
  const cached = parsedCalls.get(block)
  if (cached !== undefined || parsedCalls.has(block)) return cached ?? null
  const call = 'kind' in block ? block.call : block
  if (call === null) {
    parsedCalls.set(block, null)
    return null
  }
  let value: unknown
  try {
    value = JSON.parse(call.argsRaw)
  } catch {
    parsedCalls.set(block, null)
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    parsedCalls.set(block, null)
    return null
  }
  const parsed = { name: call.name, args: value as Record<string, unknown> }
  parsedCalls.set(block, parsed)
  return parsed
}

/**
 * 读取第一方卡片派生消费的精确单文本块。
 * @param block - settled Tool result。
 * @returns 其文本；其它任何 content 布局 → undefined。
 */
export function singleResultText(block: StepToolResultNode): string | undefined {
  if (block.content.length !== 1) return undefined
  const only = block.content[0]
  const record = typeof only === 'object' && only !== null
    ? only as { type?: unknown; text?: unknown }
    : null
  return record?.type === 'text' && typeof record.text === 'string' ? record.text : undefined
}

/**
 * 校验第一方 shell 与文件变更工具共享的可选 escalation 对。
 * @param args - 解析后的 open-root Tool 参数。
 * @returns 声明的 escalation 字段是否构成合法对。
 */
export function validEscalationFields(args: Record<string, unknown>): boolean {
  const permission = args.sandbox_permissions
  const justification = args.justification
  if (permission === undefined && justification === undefined) return true
  if (permission !== 'workspace-write' && permission !== 'danger-full-access') return false
  return typeof justification === 'string' && justification.trim() !== ''
}
