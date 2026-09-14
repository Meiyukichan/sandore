/**
 * M 层 e2e 的键控（keyless）mock LLM adapter —— 纯 JS Cordis 插件，零 import。
 *
 * ## 为什么零 import
 * 本包经临时 profile 的 `cordis.patch.yml` 以插件行挂载（行 `name` 从
 * `profiles/e2e/node_modules/@sandore-e2e/mock-llm` 解析）。**不 import
 * `@deepseek-ai/dsh-llm`** 是有意的：`ctx.llm.registerAdapter(providers, adapter)`
 * 只做结构消费（读 `providerInfo`/`stream`/`resolveModel`…，无 `instanceof` 检查），
 * 所以一个纯对象即可满足契约，从而让 mock 包不依赖宿主模块解析（也就不会因
 * 版本/hoist 差异而加载失败——DSH 侧 `LlmAdapter` 的抽象只在类型层强制）。
 *
 * ## 契约（照 `@deepseek-ai/dsh-llm` 的 `packages/llm/llm/src/{index,types}.ts`）
 * - `registerAdapter(['e2e-mock'], adapter)`：provider id 必须与 `providerInfo` 返回的
 *   `id` 一致，否则 `INVALID_ADAPTER`；重复注册 → `DUPLICATE_ADAPTER`。
 * - `providerInfo(provider)` → `{ id: provider, name }`（**id 必须恒等于 provider**）。
 * - `stream(options)` 是唯一必须实现的方法，产出 `StreamChunk` 序列：
 *   `block-start{index,blockType}` → `text-delta{index,text}`×N → `block-end{index,block}`
 *   →（可选）`usage{usage}` → 末尾 `finish{reason}`。适配器抛错会被 `LlmRuntime`
 *   归一为终止 chunk（`error`/`aborted`），但本包显式产出 `finish{kind:'error'}`，
 *   以便脚本化失败文案可控（M6 需要「step failed」可稳定复现）。
 * - `providerRetryPolicy(provider)`：返回值**已是解析态**（注册表直接采用，不再解析），
 *   这里给「不重试」，保证 `fail=1` 的失败不会被 `llm-retry` 静默重放成成功。
 *
 * ## 行为受控：**请求提示词里的指令**（不是 env）
 * 为什么不用 env：e2e 的 `dsh` fixture 是 **worker-scoped**（`workers: 1` → 全轮共享
 * 一个 3090 实例），boot 期 env 对同 worker 的所有用例是同一份；而不同 M 用例需要
 * 不同行为（慢分片 / 失败 / 长会话）。所以行为由**该 Step 提示词内嵌的指令**决定
 * ——提示词来自 YAML fixture，天然按用例隔离、确定性最强。
 *
 * 指令语法（可出现在提示词任意位置）：
 * ```
 * [[e2e-mock text=mock-ok chunks=3 delay=250 hold=5000 fail=0 tools=0 think=推理行]]
 * ```
 * | 键 | 默认 | 含义 |
 * |---|---|---|
 * | `text` | `mock-ok`（或 env `SANDBORE_E2E_MOCK_TEXT`） | 文本内容主体 |
 * | `chunks` | 1 | 文本分片数（>1 时切成多段 delta，便于观察流式） |
 * | `delay` | 0 | **内容分片之间**的延迟 ms |
 * | `hold` | 0 | **内容已完整**之后、终止 `finish` 之前再等 ms（撑出「文本可见 + step 仍 running」窗口；M1/M3/M5 的 UI 断言靠它，避免与 turn 结束赛跑） |
 * | `fail` | 0 | 1 = **每次**调用都不产出内容块，直接 `finish{kind:'error'}`（step → failed；不吃 `hold`，保证失败快且可复现） |
 * | `failfirst` | 0 | 1 = 只在**该会话第 1 次**调用失败，之后正常（重试类用例；`fail` 优先） |
 * | `tools` | 0 | K = 该会话**前 K 次**调用各返回 1 个 tool-call（`finish{kind:'tool-calls'}`），第 K+1 次返回文本 —— 把子代理会话撑成多轮/多消息 |
 * | `tool` | `read` | `tools>0` / `once=1` 时的工具名 |
 * | `toolargs` | `{"file_path":"package.json"}` | tool-call 的 arguments（JSON 字符串；`{n}` 替换为该会话调用序号；**可含空格**——以 `{` 开头时按花括号配平读取） |
 * | `once` | 0 | 1 = **一次性强制工具调用**：该指令文本一经出现在请求里，**下一次**调用就产出 `tool`/`toolargs` 指定的 tool-call（每个会话只服务一次），与「第几次调用」无关。用途见下方「宿主主代理的照办分支」的姊妹场景：e2e 往主代理会话里**投一条用户消息**（消息文本自带本指令）来驱动主代理调用某个工具时，「这条消息是该会话第几次调用」是不可预知的（工具结果回灌、终态通知都会占号），按次数写 `tools=K` 很脆 |
 * | `echo` | 0 | 1 = 把收到的 prompt（最后一条 user 消息）原样回显为答复（e2e 读 prompt 内容用） |
| `think` | 空 | 非空时在**文本轮**的文本块**之前**先产出一个 `reasoning` 块（`block-start{blockType:'reasoning'}` + `reasoning-delta` + `block-end`）——面板据此渲染「思考」折叠行（需求 2 的对齐断言需要一条真实的思考行）。值里不能含空格（同其它键的解析规则） |
 *
 * `text` / `toolargs` 里的 `{n}` 占位符会替换为**该会话的调用序号**（1 起）：文本可用
 * 它造「每轮不同」的答复，tool 参数可用它避免重复调用被判重。
 *
 * ## 宿主主代理的「照办」分支（e2e 基建；**三重门控**，见 {@link hostRunCallOf}）
 *
 * 架构决策 3 之后，工作流的**唯一启动入口**是宿主主代理（LLM）调用 `sandore_workflow_run`
 * 工具：overlay 新建流程只建会话 + `injectHostContext`（`packages/workflow/host-context.ts`
 * 的协作上下文文本），实例停在 `pending`，等主代理真的调工具才 `running`。mock adapter
 * 默认只会回文本 —— 于是 e2e 里**没有任何 step 会跑起来**（整层 M/F 挂在第一步）。
 * 本分支就是给「mock 宿主主代理」补上那一次 tool-call：识别出宿主协作上下文文本 → 原样
 * 解析出 `workflowId`（**不硬编码任何测试 id**）→ 产出一个 `sandore_workflow_run` 调用。
 *
 * 三重门控（缺一不可；保证 step 子代理**永不误命中**）：
 * 1. 该会话**尚未**服务过这条注入（`hostRunServed`；常态下就是该会话的**第 1 次**调用，
 *    若宿主会话在注入前已有别的模型调用（例如会话标题生成）也照办一次 —— 门 2/3 已足以
 *    判定这段文本是宿主协作上下文，诊断行里会记 `turn=` 便于核对）；
 * 2. 扫描文本里**没有任何** `[[e2e-mock …]]` 指令（step 子代理的提示词**总带**指令，
 *    故它们一律落到原有行为：指令驱动、或默认文本）；
 * 3. 扫描文本含宿主协作上下文标记（`请调用 sandore_workflow_run` + 可解析的
 *    `workflowId = "…"`）。
 *
 * 为什么不把指令塞进 requirement/originalInput 更省事：step 提示词
 * （`packages/microflow/step-runner.ts` 的 `buildPromptText`）里 `## 用户指令` = step 自己的
 * promptText，而「用户原始需求」（originalInput）排在其**之后**；`parseDirective` 的规则是
 * **后者覆盖前者同名键** —— 把宿主用的指令写进 requirement 会把每个 step 的指令覆盖掉。
 *
 * 未给指令时输出确定文本 `mock-ok`（env `SANDBORE_E2E_MOCK_TEXT` 可改默认），
 * 便于断言「子代理收到 mock 输出」。
 *
 * ## 诊断
 * 每次调用都往 **stderr** 打一行 `[e2e-mock] call#N …`：harness 把子进程
 * stdout/stderr 收进 `logTail()`，断言失败时可据此判断 adapter 是否真的被调用。
 * 宿主照办分支另打一行 `[e2e-mock] host-run session=… workflowId=… turn=…`——
 * e2e 用它锁「照办恰好一次、且发生在宿主会话（= instanceId）而不是任何 step 子代理上」。
 *
 * @module e2e/mock-llm
 */

/** `hold`（内容就绪后的窗口）等键的解析工具也导出：e2e fixture 级单测要直接锁它们。 */
export {
  hostRunCallOf,
  hostRunOriginalInputOf,
  parseDirective,
  scanText,
  textOfContent,
}

/** 本插件的 Cordis 插件名（插件行 id 用 `e2e-mock-llm`，二者独立）。 */
export const name = 'e2e-mock-llm'

/** 硬依赖 `llm` 服务（缺它就等价于没挂）。 */
export const inject = ['llm']

/** 插件行 config 的默认值（行 config 覆盖之）。 */
const DEFAULT_CONFIG = {
  /** 注册的 provider 路由（默认 `e2e-mock`）。 */
  provider: 'e2e-mock',
  /** 上报的 model id（默认 `mock-1`）。 */
  model: 'mock-1',
  /** 未命中指令时的默认文本。 */
  text: 'mock-ok',
}

/** 进程内单调递增的模型调用序号（唯一的全局跨调用状态；每个 boot 进程独立）。 */
let callIndex = 0

/**
 * **按会话**的模型调用计数（key = `GenerateOptions.sessionId`）。
 *
 * 为什么需要：同一会话在一个 turn 里会被调用多次（每轮 tool-call 后回灌再调），而
 * 「第几轮返回什么」只能按会话计数才稳定（全局 `callIndex` 会被并行实例/其它用例扰乱）。
 * `tools=K` 语义即建立在这上面：**该会话前 K 次调用返回 tool-call，第 K+1 次返回文本**。
 */
const sessionCalls = new Map()

/** 取（并自增）某会话的调用序号（从 1 开始）。 */
function nextSessionCall(key) {
  const next = (sessionCalls.get(key) ?? 0) + 1
  sessionCalls.set(key, next)
  return next
}

/**
 * 已经「照办过」宿主协作上下文的会话（见模块头「宿主主代理的照办分支」）。
 *
 * 为什么需要：门 2/3 判定的是「这段文本是宿主协作上下文」，但同一段文本会随会话历史
 * 出现在**后续每一次**调用里（历史不消失）——没有这个集合，主代理的回灌轮会反复要求调
 * run（引擎对非终态实例会拒绝重复 run，页面就会出现无谓的错误）。
 */
const hostRunServed = new Set()

/**
 * 已经「照办过」一次性强制工具调用的 `(sessionId, 工具名, 参数)` 三元组（`once=1`）。
 *
 * 与 {@link hostRunServed} 同因：指令文本会随会话历史留在后续每一次请求里，没有这个集合
 * 就会在工具结果回灌那一轮再发一次同样的 tool-call。
 */
const forcedCallServed = new Set()

/**
 * 一次性强制工具调用的判据（`once=1`；见模块头指令表）。
 *
 * 为什么需要它而不是用 `tools=K`：`tools` 按**该会话第几次调用**判定，而往主代理会话里投
 * 一条用户消息后，「这次调用是第几次」取决于此前有多少次调用（照办 run、工具结果回灌、
 * 终态通知都会占号）——按次数写死很脆。`once=1` 改为「指令文本出现即照办一次」，
 * 与调用序号无关。
 *
 * @param directive - 本次解析出的指令（`parseDirective` 的产物）。
 * @param sessionKey - 本会话 id（一次性判定的键）。
 * @param turn - 本会话调用序号（仅用于诊断行）。
 * @returns `{ name, argsJson, key }`；不是一次性指令 / 已服务过 → undefined。
 */
function forcedCallOf(directive, sessionKey, turn) {
  if (intOf(directive.once, 0) !== 1) return undefined
  const name = directive.tool ?? 'read'
  const argsJson = (directive.toolargs ?? '{}').replaceAll('{n}', String(turn))
  const key = `${sessionKey}::${name}::${argsJson}`
  if (forcedCallServed.has(key)) return undefined
  return { name, argsJson, key }
}

/** 宿主协作上下文的标记（`packages/workflow/host-context.ts` 的注入文案）。 */
const HOST_RUN_MARK = '请调用 sandore_workflow_run'

/** 注入文案里的启动参数行（`workflowId = "wfl-…"`）——**原样解析，不硬编码任何 id**。 */
const HOST_RUN_WORKFLOW_ID = /workflowId\s*=\s*"([^"]+)"/

/**
 * 从宿主协作上下文里解析「用户指令」那一段（= `originalInput`）。
 *
 * 依据注入文案的固定结构（host-context.ts）：
 * ```
 * 用户选择用工作流「<name>」执行下面这个任务，请调用 sandore_workflow_run 启动它：
 * <originalInput 原文（可能多行）>
 * <空行>
 * （启动参数：workflowId = "…"，originalInput = 上面这段任务原文；…）
 * ```
 * @param scan - 扫描文本（全部消息 + system 拼接）。
 * @returns 原文（空/缺失 → undefined；调用方此时放弃照办、回落默认文本行为）。
 */
function hostRunOriginalInputOf(scan) {
  const lines = String(scan).split('\n')
  const at = lines.findIndex(line => line.includes(HOST_RUN_MARK))
  if (at < 0) return undefined
  const parts = []
  for (let index = at + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || line.startsWith('（启动参数：')) break
    parts.push(line)
  }
  const text = parts.join('\n').trim()
  return text === '' ? undefined : text
}

/**
 * 判定本次调用是否该由 mock「替宿主主代理照办」一次 run（三重门控，见模块头）。
 *
 * @param scan - 扫描文本（全部消息 + system 拼接）。
 * @param hasDirective - 扫描文本里是否存在 `[[e2e-mock …]]` 指令（门 2）。
 * @param sessionKey - 本会话 id（一次性判定的键）。
 * @param turn - 本会话调用序号（诊断 + 门 1 的常态判据）。
 * @returns `{ workflowId, originalInput }`；任一门不满足 → undefined（走原有行为）。
 */
function hostRunCallOf(scan, hasDirective, sessionKey, turn) {
  // 门 2：step 子代理的提示词总带指令 → 永不误命中（也永不抢走指令驱动行为）。
  if (hasDirective) return undefined
  // 门 1（一次性）：本会话已经照办过 → 不再重复（历史里那段文本还在）。
  if (hostRunServed.has(sessionKey)) return undefined
  // 门 3：确实是宿主协作上下文（标记 + 可解析的 workflowId + 用户指令原文）。
  if (!String(scan).includes(HOST_RUN_MARK)) return undefined
  const workflowId = HOST_RUN_WORKFLOW_ID.exec(String(scan))?.[1]
  if (workflowId === undefined || workflowId === '') return undefined
  const originalInput = hostRunOriginalInputOf(scan)
  if (originalInput === undefined) return undefined
  // 门 1 的常态说明：宿主会话的第 1 次调用就是这次注入；若注入前另有调用（turn>1，
  // 例如会话标题生成），仍然照办一次并在诊断行里记 `turn=` —— 门 2/3 已足以定性。
  return { workflowId, originalInput, toleratedTurn: turn }
}

/** `sleep`（可被 abort 打断：直接 resolve，由调用方检查 aborted）。 */
function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', finish)
      resolve()
    }
    signal?.addEventListener?.('abort', finish, { once: true })
  })
}

/** 取一个 content 块数组的纯文本（只认 `text` 块，防御式）。 */
function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** 取最后一条 user 消息的纯文本（`echo=1` 回显用：把收到的 prompt 原样回给调用方）。 */
function lastUserText(options) {
  const messages = Array.isArray(options?.messages) ? options.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const text = textOfContent(message.content)
    if (text !== '') return text
  }
  return ''
}

/**
 * 从请求里抽取「行为指令」的扫描文本：优先**最后一条 user/其它消息**（Step 提示词
 * 就是首条 user 消息；多轮工具回灌后最后一条是 tool-result，因此这里拼接**全部**
 * 消息文本再做指令匹配，确保指令一定被看到）。
 */
function scanText(options) {
  const messages = Array.isArray(options?.messages) ? options.messages : []
  const parts = []
  for (const message of messages) parts.push(textOfContent(message?.content))
  if (typeof options?.system === 'string') parts.push(options.system)
  return parts.join('\n')
}

/**
 * 解析 `[[e2e-mock k=v …]]` 指令（可多处出现，后者覆盖前者同名键）。
 *
 * 值里**可以带空格**：值以 `{` 开头时按**花括号配平**一直读到配平收尾（JSON 载荷，
 * 例如 `toolargs={"file_path":"a b.txt","content":"x"}`）；其余按下一个空白分词。
 * 这条规则是实测踩坑后加的：早期按空白裸分词会把带空格的 JSON 截断，导致工具收到
 * `invalid arguments: "arguments" must be an object`。
 *
 * **收尾判据也必须配平**（本次修复）：早期用正则 `/\[\[e2e-mock\s*([^\]]*)\]\]/` 取指令体，
 * `[^\]]*` 会在**第一个 `]`** 处停下——于是 `toolargs={"targets":["<stepId>"]}` 这类**载荷里
 * 带 `]`** 的指令直接整条匹配失败（表现：mock 完全看不到指令、按默认文本回复；宿主主代理
 * 那次「照办 send_message」因此永不发生）。现在改为手写扫描：只有花括号**配平**（depth 0）
 * 时的 `]]` 才算指令收尾。
 */
function parseDirective(text) {
  const found = {}
  const source = String(text)
  const OPEN = '[[e2e-mock'
  let at = source.indexOf(OPEN)
  while (at >= 0) {
    // 扫描到配平收尾的 `]]`（大括号内的 `]` 不计）。
    let scan = at + OPEN.length
    let depth = 0
    let close = -1
    for (; scan < source.length; scan += 1) {
      const char = source[scan]
      if (char === '{') depth += 1
      else if (char === '}') depth = Math.max(0, depth - 1)
      else if (depth === 0 && char === ']' && source[scan + 1] === ']') { close = scan; break }
    }
    if (close < 0) break
    const body = source.slice(at + OPEN.length, close)
    let cursor = 0
    while (cursor < body.length) {
      while (cursor < body.length && /\s/.test(body[cursor])) cursor += 1
      if (cursor >= body.length) break
      let end = cursor
      while (end < body.length && !/\s/.test(body[end]) && body[end] !== '=') end += 1
      const key = body.slice(cursor, end)
      if (body[end] !== '=') {
        found[key] = '1'
        cursor = end
        continue
      }
      cursor = end + 1
      let value
      if (body[cursor] === '{') {
        let braceDepth = 0
        let inner = cursor
        for (; inner < body.length; inner += 1) {
          if (body[inner] === '{') braceDepth += 1
          else if (body[inner] === '}') {
            braceDepth -= 1
            if (braceDepth === 0) { inner += 1; break }
          }
        }
        value = body.slice(cursor, inner)
        cursor = inner
      } else {
        let plain = cursor
        while (plain < body.length && !/\s/.test(body[plain])) plain += 1
        value = body.slice(cursor, plain)
        cursor = plain
      }
      if (key !== '') found[key] = value
    }
    at = source.indexOf(OPEN, close + 2)
  }
  return found
}

/** 读非负整数（非法值回退默认）。 */
function intOf(raw, fallback) {
  if (raw === undefined) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

/** 把 N 个 `text-delta` + 1 个 `block-end` 的纯文本块按 `chunks` 切分（保证可观察的流式）。 */
function splitText(text, chunks) {
  if (chunks <= 1 || text.length <= 1) return [text]
  const size = Math.max(1, Math.ceil(text.length / chunks))
  const parts = []
  for (let at = 0; at < text.length; at += size) parts.push(text.slice(at, at + size))
  return parts
}

/**
 * 组装一次成功响应的 chunk 序列（文本块 + 可选前置 reasoning 块）。
 *
 * 返回**两段**：`content`（block-start + 分片 delta + block-end）与 `tail`（usage + finish）。
 * 中间留给调用方插入 `delay`（分片间）与 `hold`（内容就绪后的「运行中」窗口）——
 * 这样「完整文本已可见」与「step 仍在 running」可同时成立，UI 断言不再和 turn 结束赛跑。
 * @param text - 完整文本。
 * @param chunks - 分片数（>1 时切分）。
 * @param think - 非空时先产出一个 reasoning 块（面板渲染为「思考」折叠行）。
 * @returns `{ content, tail }`。
 */
function textChunks(text, chunks, think = '') {
  const parts = splitText(text, chunks)
  const content = []
  // reasoning 块占 **独立 index**（流式协议按 index 配平 block-start/delta/block-end，
  // 同一 index 混两种类型会被 Assembler 判为非法）。
  let index = 0
  if (think !== '') {
    content.push({ type: 'block-start', index, blockType: 'reasoning' })
    content.push({ type: 'reasoning-delta', index, text: think })
    content.push({ type: 'block-end', index, block: { type: 'reasoning', text: think } })
    index += 1
  }
  content.push({ type: 'block-start', index, blockType: 'text' })
  for (const part of parts) content.push({ type: 'text-delta', index, text: part })
  content.push({ type: 'block-end', index, block: { type: 'text', text } })
  return {
    content,
    tail: [
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  }
}

/**
 * 组装 tool-call 响应的 chunk 序列（`tools>0`，用于把子代理会话撑到多轮/多消息）。
 * @param count - 工具调用个数（每个一个块）。
 * @param toolName - 工具名。
 * @param argsJson - 每个调用的 arguments（原始 JSON 字符串）。
 * @returns `{ content, tail }`，终止 reason 为 `tool-calls`。
 */
function toolCallChunks(count, toolName, argsJson) {
  const content = []
  for (let index = 0; index < count; index += 1) {
    const id = `e2e-mock-call-${callIndex}-${index}`
    content.push({ type: 'block-start', index, blockType: 'tool-call' })
    content.push({ type: 'tool-call-delta', index, id, name: toolName, argumentsDelta: argsJson })
    content.push({ type: 'block-end', index, block: { type: 'tool-call', id, name: toolName, arguments: argsJson } })
  }
  return { content, tail: [{ type: 'finish', reason: { kind: 'tool-calls' } }] }
}

/**
 * 挂载 mock adapter。
 * @param ctx - Cordis Context（`ctx.llm` 由 `inject` 保证存在）。
 * @param config - 插件行 config（见 {@link DEFAULT_CONFIG}）。
 */
export function apply(ctx, config) {
  // 加载分叉诊断（stderr → harness 收集进 logTail）：这行出现 = 插件行被 profile 加载了；
  // 不出现 = patch 行没生效（分辨率/包名/patch 位置问题），与「加载了但没被调用」严格区分。
  console.error('[e2e-mock] applied')
  const resolved = { ...DEFAULT_CONFIG, ...(config ?? {}) }
  if (typeof process !== 'undefined' && process.env?.SANDBORE_E2E_MOCK_TEXT) {
    resolved.text = process.env.SANDBORE_E2E_MOCK_TEXT
  }
  const provider = String(resolved.provider)
  const model = String(resolved.model)

  const adapter = {
    /** 必须回 `{id: provider, name}`，且 `id` 恒等于注册时传入的 provider。 */
    providerInfo(route) {
      return { id: route, name: 'E2E Mock' }
    },

    /**
     * 解析态的重试策略：**不重试**。注册表把返回值直接当已解析策略用，
     * 所以这里必须给全字段（mode/maxRetries/retryableCodes/backoff 三项）。
     */
    providerRetryPolicy() {
      return { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }
    },

    /** 目录（L3 兜底与 UI 模型选择器都会读）。 */
    listModels(route) {
      // 第二个模型（`mock-2`）专供「运行页模型下拉真的切换了主代理会话模型」这条 e2e 断言：
      // 只上报一个模型时下拉里只有一个选项，「切换」在 UI 上是 no-op，无法证明功能为真。
      // 两个 id 的行为完全一致，差别只体现在调用日志的 `model=` 上（可观测证据）。
      return Promise.resolve([
        { provider: route, id: model, name: 'E2E Mock' },
        { provider: route, id: `${model}-2`, name: 'E2E Mock 2' },
      ])
    },

    /** 精确模型元数据：给一个足够大的上下文窗口，避免 compaction 阈值告警。 */
    resolveModel(route, id) {
      return Promise.resolve({ provider: route, id, name: 'E2E Mock', context: { contextWindow: 200_000 } })
    },

    /**
     * **必须显式实现**：`prepareCall` 在基类 `LlmAdapter` 上是具体方法，而本 adapter 是
     * **纯对象**（不继承基类）→ 少这一条，`LlmRuntime.prepareCall()` /
     * `adapterStream()` 会以 `adapter.prepareCall is not a function` 抛 TypeError，
     * 表现为「子代理 turn 连一次模型调用都没有就 settle error」（实测 m0 现场：
     * `[e2e-mock] applied` 有、`llm/stream` 与 `call#` 都没有）。实现与基类默认实现同形：
     * 解析精确模型元数据 + 绑定一次 stream 分发。
     */
    async prepareCall(route, id, signal) {
      return {
        model: await adapter.resolveModel(route, id, signal),
        stream: options => adapter.stream(options),
      }
    },

    /**
     * 流式产出一次 mock 响应（见模块头「行为受控」的指令语法）。
     *
     * 取消语义：`options.signal` 在分片之间检查；一旦 abort，立刻以
     * `finish{kind:'aborted'}` 结束（对齐真实适配器对取消的处理）。
     */
    async *stream(options) {
      callIndex += 1
      const sequence = callIndex
      // 会话身份：`sessionId` 由 loop 盖在请求上（每会话独立 cursor）；缺省退化到 'anonymous'。
      const sessionKey = String(options?.sessionId ?? 'anonymous')
      const turn = nextSessionCall(sessionKey)
      const scan = scanText(options)
      const directive = parseDirective(scan)
      const chunks = intOf(directive.chunks, 1)
      const delayMs = intOf(directive.delay, 0)
      const holdMs = intOf(directive.hold, 0)
      const fail = intOf(directive.fail, 0)
      const failFirst = intOf(directive.failfirst, 0)
      // `tools=K` = 本会话前 K 次调用返回 tool-call，第 K+1 次返回文本（见 sessionCalls 注释）。
      const toolRounds = intOf(directive.tools, 0)
      const isToolRound = toolRounds > 0 && turn <= toolRounds
      const toolName = directive.tool ?? 'read'
      // `{n}` 占位符 → 本会话调用序号：让每轮 tool 调用**参数不同**（避免被去重/提醒逻辑
      // 影响，也让 tool 结果可逐轮区分）。
      const toolArgs = (directive.toolargs ?? '{"file_path":"package.json"}').replaceAll('{n}', String(turn))
      const text = (directive.text ?? resolved.text).replaceAll('{n}', String(turn))
      // `think=…`：文本轮先产出一个 reasoning 块（面板渲染「思考」折叠行）。
      const think = (directive.think ?? '').replaceAll('{n}', String(turn))

      // stderr 诊断（harness 收进 logTail）：证明 adapter 被调用 + 本次指令解析结果。
      console.error(
        `[e2e-mock] call#${sequence} sessionTurn=${turn} provider=${String(options?.provider)} model=${String(options?.model)}`
        + ` text=${JSON.stringify(text)} chunks=${chunks} delay=${delayMs} hold=${holdMs} fail=${fail}`
        + ` failfirst=${failFirst} tools=${toolRounds} toolRound=${isToolRound} think=${JSON.stringify(think)}`,
      )

      // 宿主主代理的「照办」分支（三重门控；见模块头）。
      const hasDirective = Object.keys(directive).length > 0
      const hostRun = hostRunCallOf(scan, hasDirective, sessionKey, turn)
      if (hostRun !== undefined) {
        hostRunServed.add(sessionKey)
        const argsJson = JSON.stringify({
          workflowId: hostRun.workflowId,
          originalInput: hostRun.originalInput,
        })
        console.error(
          `[e2e-mock] host-run session=${sessionKey} workflowId=${hostRun.workflowId}`
          + ` turn=${turn} originalInput=${JSON.stringify(hostRun.originalInput)}`,
        )
        for (const chunk of toolCallChunks(1, 'sandore_workflow_run', argsJson).content) {
          yield chunk
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }

      // 一次性强制工具调用（`once=1`；e2e 往主代理会话投消息来驱动某个工具时用）。
      const forced = forcedCallOf(directive, sessionKey, turn)
      if (forced !== undefined) {
        forcedCallServed.add(forced.key)
        console.error(
          `[e2e-mock] forced-call session=${sessionKey} tool=${forced.name}`
          + ` turn=${turn} args=${forced.argsJson}`,
        )
        for (const chunk of toolCallChunks(1, forced.name, forced.argsJson).content) {
          yield chunk
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }

      if (fail === 1 || (failFirst === 1 && turn === 1)) {
        // 纯失败：不产出任何内容块，直接终止为 error（子代理 settle → step failed）。
        // 不吃 `hold`：失败要可复现地快（M6 靠它造 failed 段）。
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: `e2e-mock scripted failure (call#${sequence})`, code: 'MOCK_FAIL' } },
        }
        return
      }

      // `echo=1`：把**收到的 prompt**（最后一条 user 消息）原样回显成答复文本。
      // 用途：e2e 需要读「引擎实际喂给子代理的 prompt」（例如 `## 参考信息` 里注入了哪些
      // 前置 Step）——答复文本会落进子代理会话 → 经 `getInstanceState` 的
      // `sessionMessages` 可读，比读 DOM 稳。
      if (intOf(directive.echo, 0) === 1) {
        const echoed = lastUserText(options).slice(0, 20_000)
        console.error(`[e2e-mock] echo session=${sessionKey} length=${echoed.length}`)
        for (const chunk of textChunks(echoed, 1).content) {
          if (options?.signal?.aborted === true) {
            yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } }
            return
          }
          yield chunk
        }
        for (const chunk of textChunks(echoed, 1).tail) yield chunk
        return
      }

      const plan = isToolRound
        ? toolCallChunks(1, toolName, toolArgs)
        : textChunks(text, chunks, think)
      for (const chunk of plan.content) {
        if (options?.signal?.aborted === true) {
          yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } }
          return
        }
        yield chunk
        // 内容分片之间睡 `delay`（流式观感）；block-end 之后再睡没意义（内容已完整）。
        if (chunk.type !== 'block-end') await sleep(delayMs, options?.signal)
      }
      // ★ `hold`：**内容已完整可见**之后仍保持 turn 未结束的窗口（M1/M3/M5 的 UI 断言
      // 都靠它避开「面板随 turn 结束卸载」的赛跑）。只作用于**最终文本轮**：tool 轮
      // 不吃 hold，否则一个 K 轮会话会被拉成 K×hold。
      if (holdMs > 0 && !isToolRound) {
        await sleep(holdMs, options?.signal)
        if (options?.signal?.aborted === true) {
          yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } }
          return
        }
      }
      for (const chunk of plan.tail) yield chunk
    },
  }

  ctx.llm.registerAdapter([provider], adapter)
  // 全量 stream 观测（waterfall 最外层）：任何一次模型调用都会在这里留下 provider/model，
  // 与 adapter 内部的 `[e2e-mock] call#…` 配合即可区分「没发起调用」与「发起但没路由到本
  // adapter」（例如路由到 deepseek-official → 缺凭据 → 子代理 settle error 却无 call# 行）。
  ctx.on('llm/stream', (options, next) => {
    console.error(`[e2e-mock] llm/stream provider=${String(options?.provider)} model=${String(options?.model)} purpose=${String(options?.purpose)}`)
    return next()
  })
  ctx.logger?.info?.(`[e2e-mock] registered provider "${provider}" model "${model}"`)
}
