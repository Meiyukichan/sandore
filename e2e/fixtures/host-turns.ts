/**
 * 宿主会话的 **turn 盘面**读取（e2e 取证/断言共用）。
 *
 * ## 为什么需要
 * 用户真机现象：主代理会话里 `turn-tail2 … turn-tail19` 全是**空壳**（各占一行 → 「巨大空白」）。
 * 要判定「被 park 的结算通知有没有留下空 turn」，唯一可靠的真值是**会话日志盘面**
 * （`$DSH_HOME` 下 `sessions` 目录里每个会话目录的 `session.jsonl.zstd`），按
 * `turn/start`..`turn/end` 切 turn，再看该 turn 里有没有内容事件。
 *
 * ## 空 turn 的 DSH 成因（源码为证）
 * 1. `Agent.turn()` **先**追加 `turn/start`（`core/agent-loop/src/agent.ts:264`）**再**走
 *    `preStep`（`:275`）；
 * 2. `preStep` 里 `Inbox.claim` 已把整批消息从 inbox 同步摘走（`agent.ts:238`），
 *    `agent/pre-step` waterfall 才拿到它们（`:243-249`）；
 * 3. 我们的监听器对「整批都是本实例子代理的结算通知」返回 `{kind:'reject'}`
 *    （`packages/workflow/workflow-engine.ts` 的 `registerHostSessionNoticeFilter`），
 *    DSH 于是 `turnEnds = {kind:'blocked'}` 并结束该 turn（`agent.ts:276-279`）——
 *    没有 `step/start`、没有 `user/message`、没有模型调用，只留下一个**空 turn**。
 *
 * 所以「被 park 的通知」与「空 turn」是**一一对应**的：这些 turn 在日志里写成
 * `turn/start` + `turn/end{reason:'blocked'}`，相邻两事件。
 * @module e2e/fixtures/host-turns
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** zstd 帧头 magic。 */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** 一个 turn 的盘面事实。 */
export interface HostTurnFacts {
  /** turn 序号（DSH `turn/start` 的 `turn`）。 */
  readonly turn: number
  /** 该 turn 结束时的事件类型直方图（不含 `turn/start`/`turn/end`）。 */
  readonly types: Readonly<Record<string, number>>
  /** `turn/end` 的原因（`blocked` = pre-step reject；`completed` = 正常结束）。 */
  readonly endReason: string | undefined
  /** 是否**空 turn**（无 `step/start`，也无任何内容事件）。 */
  readonly empty: boolean
}

/** 判定「有内容」的事件类型（出现任意一种即不算空 turn）。 */
const CONTENT_TYPES: ReadonlySet<string> = new Set([
  'step/start',
  'user/message',
  'assistant/message',
  'assistant/chunk',
  'tool/call',
  'tool/result',
  'reasoning-chunks',
  'text-chunks',
  'tool-call-chunks',
])

/** 按 magic 切出顶层 zstd 帧（与上游 `scanZstdFrames` 同法）。 */
function splitZstdFrames(buffer: Uint8Array): readonly Uint8Array[] {
  const starts: number[] = []
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (buffer[index] === ZSTD_MAGIC[0] && buffer[index + 1] === ZSTD_MAGIC[1]
      && buffer[index + 2] === ZSTD_MAGIC[2] && buffer[index + 3] === ZSTD_MAGIC[3]) {
      starts.push(index)
    }
  }
  return starts.map((start, index) => buffer.subarray(start, starts[index + 1] ?? buffer.length))
}

/** 读一份会话日志（zstd 分帧或明文）→ 行数组。 */
export function readSessionLines(path: string): string[] {
  const buffer = readFileSync(path)
  if (path.endsWith('.zstd')) {
    const parts: string[] = []
    for (const frame of splitZstdFrames(buffer)) parts.push(zstdDecompressSync(frame).toString('utf8'))
    return parts.join('').split('\n').filter(line => line.trim() !== '')
  }
  return buffer.toString('utf8').split('\n').filter(line => line.trim() !== '')
}

/** `JSON.parse` 但不抛。 */
function parseJson(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line) as unknown
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** 递归找出 `<root>` 下所有 `session.jsonl*`。 */
function findSessionLogs(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (/^session\.jsonl(\.zstd)?$/.test(entry.name)) found.push(path)
    }
  }
  if (statSync(root, { throwIfNoEntry: false })?.isDirectory() === true) walk(root)
  return found
}

/** 把一份会话日志的行切成 turn 盘面。 */
export function turnsOfLines(lines: readonly string[]): HostTurnFacts[] {
  const turns: HostTurnFacts[] = []
  let current: {
    readonly turn: number
    readonly types: Record<string, number>
    endReason: string | undefined
  } | null = null
  for (const line of lines.slice(1)) {
    const event = parseJson(line)
    if (event === undefined) continue
    const type = String(event['type'])
    const data = typeof event['data'] === 'object' && event['data'] !== null
      ? event['data'] as Record<string, unknown>
      : {}
    if (type === 'turn/start') {
      current = {
        turn: typeof data['turn'] === 'number' ? data['turn'] : turns.length + 1,
        types: {},
        endReason: undefined,
      }
      turns.push({ turn: current.turn, types: current.types, endReason: undefined, empty: true })
      continue
    }
    if (current === null) continue
    if (type === 'turn/end') {
      const reason = data['reason']
      current.endReason = typeof reason === 'object' && reason !== null
        ? String((reason as Record<string, unknown>)['kind'])
        : String(reason)
      const index = turns.length - 1
      turns[index] = {
        turn: current.turn,
        types: current.types,
        endReason: current.endReason,
        empty: !hasContent(current.types),
      }
      current = null
      continue
    }
    current.types[type] = (current.types[type] ?? 0) + 1
  }
  return turns
}

/** 事件直方图里是否含内容事件。 */
function hasContent(types: Readonly<Record<string, number>>): boolean {
  return Object.keys(types).some(type => CONTENT_TYPES.has(type))
}

/**
 * 读**宿主会话**（= instanceId）的 turn 盘面。
 *
 * @param home - 隔离实例的 `DSH_HOME`。
 * @param hostSessionId - 宿主会话 id（恒 ≡ instanceId）。
 * @returns turn 盘面（会话不存在时为空数组）。
 */
export function readHostTurns(home: string, hostSessionId: string): HostTurnFacts[] {
  for (const path of findSessionLogs(join(home, 'sessions'))) {
    const lines = readSessionLines(path)
    if (lines.length === 0) continue
    const header = parseJson(lines[0]!)
    if (header?.['type'] !== 'session' || header['id'] !== hostSessionId) continue
    return turnsOfLines(lines)
  }
  return []
}

/** 把 turn 盘面渲染成人类可读 dump（逐 turn：空/有内容 + 结束原因 + 事件直方图）。 */
export function renderHostTurns(turns: readonly HostTurnFacts[]): string {
  const empty = turns.filter(turn => turn.empty)
  return [
    '# 宿主会话 turn 盘面（空 turn = 被 park 的结算通知留下的空壳）',
    `turn 总数=${turns.length} 空 turn 数=${empty.length}（${empty.map(turn => `turn#${turn.turn}`).join(',') || '无'}）`,
    '',
    ...turns.map(turn => {
      const types = Object.entries(turn.types).map(([key, count]) => `${key}×${count}`).join(' ') || '(无事件)'
      return `- turn#${turn.turn} ${turn.empty ? '【空】' : '有内容'} end=${String(turn.endReason)} | ${types}`
    }),
    '',
  ].join('\n')
}
