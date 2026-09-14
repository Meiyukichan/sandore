/**
 * tool-call-model.spec：B2b 工具行纯模型回归测试——variant 分类 / 行状态派生 /
 * 摘要与正文 / 结果扁平文本 / 路径工具与 home 缩写；以及卡片材质派生（terminal
 * 退出状态标记解析、read/search 元数据门槛）。语义对齐 DSH 0.1.2-rc.1 ui-tool
 * models（只读参考 deepseek-harness）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/tool/tool-call-model.spec
 */
import { describe, expect, it } from 'vitest'

import type { StepToolCallBlock } from '../step-row-data.ts'
import { stepToolBlockOf } from '../step-row-data.ts'
import { diffCardModel } from './diff-card-model.ts'
import { readCardModel } from './read-card-model.ts'
import { searchCardModel } from './search-card-model.ts'
import { terminalCardModel, terminalFailed } from './terminal-card-model.ts'
import {
  classifyTool, formatToolBody, relativizeToCwd, resultText, toolRowModel,
} from './tool-call-model.ts'
import { webCardModel } from './web-card-model.ts'

/** 按运行中 head 的本地断言面构造 block（字段即断言后的形状）。 */
function head(partial: Partial<{
  callId: string
  parentCallId?: string
  name: string
  argsRaw: string
  subCalls: readonly StepToolCallBlock[]
}>): StepToolCallBlock {
  return {
    callId: 'c-1',
    name: '',
    argsRaw: '',
    subCalls: [],
    ...partial,
  }
}

/** 按结算 result 的本地断言面构造 block。 */
function result(partial: Partial<{
  callId: string
  call: { name: string; argsRaw: string } | null
  callTime: number | null
  content: readonly unknown[]
  isError: boolean
  error: { name: string; code: string }
  meta: unknown
  subCalls: readonly StepToolCallBlock[]
}>): StepToolCallBlock {
  return {
    kind: 'tool-result',
    callId: 'c-1',
    call: { name: 'bash', argsRaw: '{}' },
    callTime: 1,
    content: [],
    isError: false,
    subCalls: [],
    ...partial,
  }
}

describe('classifyTool / toolRowModel（variant 与行模型）', () => {
  it('classifies known tool names and falls back to others', () => {
    expect(classifyTool('bash')).toBe('bash')
    expect(classifyTool('pwsh')).toBe('bash')
    expect(classifyTool('web_fetch')).toBe('read')
    expect(classifyTool('web_search')).toBe('search')
    expect(classifyTool('grep')).toBe('search')
    expect(classifyTool('unknown_tool')).toBe('others')
  })

  it('derives running/ok/error/stopped states from the block lifecycle', () => {
    expect(toolRowModel('bash', head({ name: 'bash', argsRaw: '{}' })).state).toBe('running')
    expect(toolRowModel('bash', result({ content: [{ type: 'text', text: 'ok' }] })).state).toBe('ok')
    expect(toolRowModel('bash', result({ isError: true, error: { name: 'E', code: 'x' }, content: [{ type: 'text', text: 'bad' }] })).state).toBe('error')
    expect(toolRowModel('bash', result({ error: { name: 'Interrupted', code: 'interrupted' } })).state).toBe('stopped')
  })

  it('summaries follow variant key preference; others rows prefix the tool name', () => {
    expect(toolRowModel('bash', head({ name: 'bash', argsRaw: '{"description":"deploy","command":"npm run"}' })).summary).toBe('deploy')
    expect(toolRowModel('read', head({ name: 'read', argsRaw: '{"file_path":"/w/a.ts","limit":10}' })).summary).toBe('/w/a.ts')
    expect(toolRowModel('some_tool', head({ name: 'some_tool', argsRaw: '{"id":"p1"}' })).summary).toBe('some_tool · p1')
    expect(toolRowModel('bash', head({ name: 'bash', argsRaw: '' })).summary).toBe('c-1')
  })

  it('single-file tools expose filePath; bodyRaw keeps the raw args for card-less render sites', () => {
    const model = toolRowModel('read', head({ name: 'read', argsRaw: '{"file_path":"/w/a.ts"}' }))
    expect(model.filePath).toBe('/w/a.ts')
    // rc.1：bodyRaw 保留原始 JSON（GenericToolCard 对单文件行在传参时置 null）
    expect(model.bodyRaw).toBe('{"file_path":"/w/a.ts"}')
    expect(toolRowModel('bash', head({ name: 'bash', argsRaw: '{"command":"ls"}' })).filePath).toBeUndefined()
  })

  it('relativizes workspace-rooted summaries and abbreviates the POSIX home', () => {
    const summary = toolRowModel('read', head({ name: 'read', argsRaw: '{"file_path":"/workspace/src/a.ts"}' }), '/workspace').summary
    expect(summary).toBe('src/a.ts')
    expect(relativizeToCwd('src/a.ts', '/workspace')).toBe('src/a.ts')
    // Windows drive 路径不受 home 缩写影响
    const win = toolRowModel('read', head({ name: 'read', argsRaw: '{"file_path":"C:/repo/a.ts"}' }), undefined, '/home/user')
    expect(win.summary).toBe('C:/repo/a.ts')
    // POSIX home 后代 → ~ 前缀
    const home = toolRowModel('read', head({ name: 'read', argsRaw: '{"file_path":"/home/user/a.ts"}' }), undefined, '/home/user')
    expect(home.summary).toBe('~/a.ts')
  })

  it('error rows carry the first result line as the collapsed summary', () => {
    const model = toolRowModel('bash', result({
      isError: true,
      error: { name: 'ToolError', code: 'boom' },
      content: [{ type: 'text', text: 'Error: boom\nsecond' }],
    }))
    expect(model.state).toBe('error')
    expect(model.errorSummary).toBe('Error: boom')
    expect(model.output).toBe('Error: boom\nsecond')
  })
})

describe('resultText / formatToolBody', () => {
  it('flattens text blocks and pretty-prints the rest; failed empty content uses error line', () => {
    expect(resultText(result({ content: [{ type: 'text', text: 'a' }, { type: 'x', n: 1 }] }))).toBe('a\n{\n  "type": "x",\n  "n": 1\n}')
    expect(resultText(result({ content: [], isError: true, error: { name: 'ToolError', code: 'boom' } }))).toBe('ToolError: boom')
    expect(resultText(result({ content: [] }))).toBe('')
  })

  it('formats pretty JSON on expansion and the raw string when args are not JSON', () => {
    expect(formatToolBody('bash', '{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(formatToolBody('bash', 'not-json')).toBe('not-json')
    expect(formatToolBody('bash', '')).toBeNull()
    expect(formatToolBody('code', '{"code":"x => x","b":2}')).toBe('x => x')
  })
})

describe('card material derivations（rc.1 门槛）', () => {
  it('terminal card: running shell card; settled output parses the trailing exit marker', () => {
    const running = terminalCardModel(head({ name: 'bash', argsRaw: '{"description":"d","command":"ls"}' }))
    expect(running).not.toBeNull()
    expect(running?.card.running).toBe(true)
    expect(terminalFailed(running!)).toBe(false)
    const settled = terminalCardModel(result({
      content: [{ type: 'text', text: 'a.txt\n[exit code: 2]' }],
    }))
    // 结算卡需要 call 头（默认 result() 的 call = bash/{}，缺 description → 持久 shell 面，
    // 无进程状态可解析 → 通用路径），显式补齐标准 shell 参数验证退出标记解析。
    const settledShell = terminalCardModel(result({
      call: { name: 'bash', argsRaw: '{"description":"list","command":"ls"}' },
      content: [{ type: 'text', text: 'a.txt\n[exit code: 2]' }],
    }))
    expect(settled).toBeNull()
    expect(settledShell?.card.exitCode).toBe(2)
    expect(settledShell?.card.output).toBe('a.txt')
    expect(terminalFailed(settledShell!)).toBe(true)
  })

  it('read card requires a settled root with meta lines and the file envelope', () => {
    const withMeta = readCardModel(result({
      call: { name: 'read', argsRaw: '{"file_path":"/w/a.ts"}' },
      content: [{ type: 'text', text: '<path>/w/a.ts</path>\n<type>file</type>\n<content>\nbody\n</content>' }],
      meta: { path: '/w/a.ts', offset: 1, lines: [{ number: 1, text: 'body' }], totalLines: 1, lang: 'ts' },
    }), '/w')
    expect(withMeta?.label).toBe('a.ts')
    expect(withMeta?.totalLines).toBe(1)
    expect(readCardModel(head({ name: 'read', argsRaw: '{"file_path":"/w/a.ts"}' }))).toBeNull() // running 无卡
    expect(readCardModel(result({
      content: [{ type: 'text', text: 'x' }], meta: null,
    }))).toBeNull()
  })

  it('search/web/diff cards validate their meta and degrade to the generic path', () => {
    const search = searchCardModel(result({
      call: { name: 'grep', argsRaw: '{"pattern":"x","path":"/w"}' },
      meta: { truncated: false, total: 1, shape: 'matches', files: [{ path: '/w/a.ts', matches: [{ lineNumber: 1, line: 'x' }] }] },
    }))
    expect(search?.card.kind).toBe('matches')
    expect(searchCardModel(result({ meta: { truncated: 'no' } }))).toBeNull()
    const web = webCardModel(result({
      call: { name: 'web_search', argsRaw: '{"queries":["q"]}' },
      meta: { truncated: false, sources: [{ url: 'https://x', title: 'X' }] },
    }))
    expect(web?.kind).toBe('search')
    const diff = diffCardModel(result({
      call: { name: 'write', argsRaw: '{"file_path":"/w/a.txt","content":"new"}' },
      meta: { diffs: [{ path: '/w/a.txt', oldText: null, newText: 'new' }] },
    }))
    expect(diff?.card.diffs).toHaveLength(1)
  })
})

describe('stepToolBlockOf 深度防御', () => {
  it('round-trips the local payload shapes produced by the reader', () => {
    const raw = {
      kind: 'tool-result', seq: 1, callId: 'root', call: { name: 'bash', argsRaw: '{}' },
      callTime: 0, content: [], isError: false,
      subCalls: [{ callId: 'kid', name: 'read', argsRaw: '{}', subCalls: [] }],
    }
    const block = stepToolBlockOf(raw)
    expect(block).not.toBeUndefined()
    if (block === undefined || !('kind' in block)) throw new Error('expected result')
    expect(block.subCalls).toHaveLength(1)
    const model = toolRowModel('bash', block)
    expect(model.state).toBe('ok')
  })
})
