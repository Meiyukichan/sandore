# Task 3 — 完整 DAG 能力设计文档

> 版本: 0.1.0 | 状态: 设计草案 | 最后更新: 2025-07-20
> 源文档: [dsh-workflow.md](../../engine/dsh-workflow.md)（引擎插件化设计）、[dynamic-workflow-engine.md](../../engine/dynamic-workflow-engine.md)（引擎 v2.6 技术设计）

## 本文档范围

本文档从上述两份源设计文档中**提取与 Task 3「完整 DAG」直接相关的设计内容**，重新组织为自包含的 Task 3 设计规格。

**Task 3 定位**：在 Task 2 线性执行基础上补齐完整 DAG 能力。具体包括：
- agent/skill/mcp Step（`ctx.subagents.startContinuable` 可续接子代理会话）
- 分支评估（BranchEvaluator）
- 循环 / 嵌套循环
- Finalize 拆分（FinalizeAssessor fork 会话 + GateEvaluator 独立 session + 透传变量 + 完成判定/ask + 门禁）

**验证标准**：能执行带分支 / 循环 / 门禁 / 透传变量的完整 DAG 工作流。

---

## 目录

1. [agent/skill/mcp Step 会话模式](#1-agentskillmcp-step-会话模式)
2. [Step 会话生命周期（DSH 可续接子代理）](#2-step-会话生命周期dsh-可续接子代理)
3. [SDK 能力全量映射（零 @codeagent/sdk 依赖）](#3-sdk-能力全量映射零-codeagent-sdk-依赖)
4. [输入消息构建 — InputFrom 解析](#4-输入消息构建--inputfrom-解析)
5. [产物收集 — OutputTo 解析](#5-产物收集--outputto-解析)
6. [Step 完成判定与 askUserQuestion 转换](#6-step-完成判定与askuserquestion-转换)
7. [分支评估器 — BranchEvaluator](#7-分支评估器--branchevaluator)
8. [循环与嵌套循环](#8-循环与嵌套循环)
9. [Finalize 拆分 — WorkflowFinalizeManager](#9-finalize-拆分--workflowfinalizemanager)
10. [关键类型定义](#10-关键类型定义)
11. [验证标准](#11-验证标准)

---

## 1. agent/skill/mcp Step 会话模式

> 来源：dynamic-workflow-engine.md §6.2

引擎支持五种 Command 类型，其中 agent / prompt / skill / mcp 四种走 AI 会话模式，shell 走进程执行模式。

### 1.1 Command 类型映射（DSH 实现）

| Command 类型 | sandore 实现 | DSH 实现 |
|---|---|---|
| `agent`（AI Agent + 参数模板） | `@codeagent/sdk` createSession + sendChat + SSE | `ctx.agents.create({ sessionId, ... })` 创建子 agent，`send()` 发送提示词，事件经 DSH 事件系统 |
| `prompt`（纯提示词） | 同上 | `ctx.llm.stream()` 或 `ctx.agents.create()` |
| `skill`（技能调用） | SDK 技能名 | DSH `ctx.skill`（技能注册表）或保持为 prompt 前缀 |
| `mcp`（MCP 工具调用） | SDK MCP 名 | DSH `ctx.mcp`（如有）或保持为 prompt 前缀 |
| `shell`（简单命令） | `child_process.exec` | `ctx.shell.resolve()` + `ctx.shell.run()`（`bash -c`，返回 stdout/stderr 文本） |
| `shell`（需 stdin 注入/流式/终端，v2.4.2 特性） | `child_process.exec` + stdin 写入 | `ctx.subprocess.spawn()`（底层进程，支持原始 stdio/进程树/终端会话） |

> **决策 D3**：Step 的「AI 会话」用 `ctx.subagents.startContinuable()` 创建的**可续接子代理**承载，而非临时 `ctx.llm.stream()` 调用。理由：① Step 需要完整的多轮会话（工具调用、权限、问答、暂停/恢复、崩溃恢复），可续接子代理原生支持 `followup`/`interrupt`/`reportFrom`，且带 parent 归属 + 持久化；② 权限/问答通过 DSH 的交互 seam（`packages/interaction`）自动接入；③ 崩溃恢复用 `ctx.agents.resume({ resumeSessionId })`（冷恢复可续接子代理）。
>
> 而**分支评估 / finalize 的临时 AI 会话**（一次性、只读、红线约束）用 `ctx.llm.stream()` 或一次性 `ctx.subagents.start()`，避免为临时评估创建长期会话。

### 1.2 Agent 会话执行流程

```
1. buildStepInputMessages() ── 构建输入消息
   ├── jobRequirement (原始需求)
   ├── 前置 Step 输出 (returnPrompt + artifacts)
   └── 其他输入信息

2. writeInputJson() ── 写入 {stepMessageId}_input.json

3. fillParams() [仅 agent 类型]
   ├── 启动临时 AI 会话
   ├── 根据 agentParamsTemplate + 输入信息填充参数
   └── 返回填充后的参数文本

4. createSession() ── 创建 SDK 会话

5. 构建结构化提示词 (V2.5: 单一 text part, sections 拼接; V2.3: 结构化标题, V2.4: skill/mcp 类型支持, V2.4.2: promptText 先进行 ${xxx} 替换):
   ├── [主头部] "你是严谨准确的Step执行Agent..." — 角色定位说明
   ├── [## 你的任务] — 根据 commandType 构建 promptText:
   │     V2.4.2: promptText 先通过 replacePassThroughVars() 替换 ${xxx} 透传变量
   │     ├── agent:  "使用 Agent：{promptText}" (校验是否在 workflow.agents 数组中, 不匹配则回退为纯提示词)
   │     ├── skill:  "使用 skill：{promptText}" (校验是否在 workflow.skills 数组中, 不匹配则回退)
   │     ├── mcp:    "使用 MCP：{promptText}"   (校验是否在 workflow.mcps 数组中, 不匹配则回退)
   │     ├── prompt: {promptText} (纯提示词)
   │     └── shell:  {command} (Shell 命令)
   ├── [## 参考信息] — 含多个 ### 子标题 (V2.5: 4 个子节):
   │     ├── ### 用户原始需求 — _jobRequirement
   │     ├── ### 当前Step参数 — paramsText (仅 agent 类型有 agentParamsTemplate 时)
   │     ├── ### 其他输入信息 — _otherValues (列表)
   │     └── ### 用户补充信息【仅供参考】 — _userSupplementMessages (列表)
   ├── [## 前置Steps输出与产物] — 每个前置 Step 一个 ### 子标题 (V2.5: 格式重构):
   │     └── ### 前置Step: {name} ({id}) + <{id}><output>缩进</output><artifacts>文件列表</artifacts></{id}>
   └── [## 任务规则] — V2.5: Record<string,string> 键值列表 "- **{key}**: {content}" (仅当有规则时)

   注意: V2.5 将所有 sections 拼接为单一 text part (非多 part 数组); V2.3 使用结构化标题替代旧版前缀包装

6. writePartsJson() ── 写入 {stepMessageId}_parts.json

7. sendChat() ── 发送 parts 到 SDK (fire-and-forget, V2.3: 传递 permission_mode)

8. listenForEvents() ── 等待 session.idle
   └── 使用引擎共享 SSE (sessionIdleWaiter)

9. 暂停检查: 如果执行期间被暂停, 等待 _resumePromise (循环: resume → re-listenForEvents → 再检查)
   └── 暂停循环结束后 emit interaction_resolved

10. readOutput() ── V2.5: 优先从 jsonl 读取（readLastTextFromJsonl）；回退到 SDK messages API（从后往前搜索 assistant 消息, stripThinkTags 后取非空文本）

11. collectOutputArtifacts() ── 根据 outputTo 收集产物 → emit completed → _status='completed'

> **V2.4 变更**：在 retry/recover/resume 模式下，步骤 1-9 由 runner 的对应方法处理（`retry()`/`recoverFromSession()`/`waitForResumeAndComplete()`），步骤 10-11 由独立的 `collectOutput()` 方法执行。引擎的 `executeStepNode` 在调用 runner 方法后调用 `collectOutput()`，再调用 `runPostStepPipeline()` 完成后处理。
```

### 1.3 Agent 参数填充（fillParams）

仅 `agent` 类型且定义了 `agentParamsTemplate` 时执行。使用 `runTempSession()` 临时 AI 会话，parts 先展开 `_stepInputMessages` 再追加参数模板和任务指令，提示词模板：

```
## 参数模板
{agentParamsTemplate}

## 你的任务
你的唯一任务是根据这个参数模板，然后根据（## 输入信息）中的信息，
或者你可以进行一定程度的探索后，将参数模板的内容按照模板格式填充后返回这个结果！

## 红线规则
- 禁止编辑或者创建或者删除任何文件
- 禁止过度探索，你的任务是根据已有信息，做足够探索后尽快返回这个参数模板结果
- 不要过度思考，你的职责不是设计或者开发
```

### 1.4 权限自动回复（notifyPermission）

收到 `permission.asked` 事件时，先尝试 `autoReplyPermission()`（V2.3: 通过 `_getPermissionMode()` 动态获取权限模式）：
- `bypassPermissions` → 自动允许
- `acceptEdits` → 允许除 Bash 外的所有权限
- 自动回复成功 → 不 emit permission 事件（静默处理）
- 自动回复失败 → 设置 `interacting` + emit `permission`

### 1.5 shell Step 的 stdin 注入与沙箱

> v2.4.2 的 `resolveRawInputOutputs()` 将 `inputFrom` 解析的 Step 输出 JSON 数组写入子进程 stdin。DSH 中 `ctx.shell.run()` 是高层 `bash -c`（无 stdin 注入），需改用 `ctx.subprocess.spawn()`（提供原始 stdio 流）。简单命令用 `ctx.shell.run()`，需 stdin 交互/流式输出/终端会话用 `ctx.subprocess.spawn()`。

> **shell Step 的沙箱**：DSH 的 shell 执行受沙箱约束（`ctx.sandbox`，`SandboxMode = 'read-only'|'workspace-write'|'danger-full-access'`；`ctx.shell.get sandboxMode()`）。工作流 Step 的 shell 命令默认走当前组合的沙箱模式，产物写入需 `workspace-write` 及以上。这与 sandore 引擎的 `permissionMode` 是正交的两个维度：`permissionMode` 控制 AI Agent 的权限自动回复，`sandboxMode` 控制 shell/fs 的系统级限制。

---

## 2. Step 会话生命周期（DSH 可续接子代理）

> 来源：dsh-workflow.md §5.3

### 2.1 生命周期时序

```
Step 开始（agent/prompt/skill/mcp 类型）
    │
    ▼
const started = await ctx.subagents.startContinuable({ ... })  // 返回 { childId, messageId }
    │  （parent = 工作流宿主 agent，origin: 'subagent'；首条提示词随 request.prompt 投递）
    ▼
const child = ctx.agents.get(started.childId)                  // hold 住 live Agent 引用
    │
    ▼
await child.whenIdle()                                          // ★ 等待当前轮完成（权威 per-turn 原语）
    │
    ▼
读取输出：finalAssistantOutput(child.session.events)            // 最后一条非空 assistant（child 引用先 hold）
    │
    ▼ 暂停 / 恢复 / 重试
ctx.subagents.interrupt(childId, {kind:'ancestor', agent:hostAgent})  // 暂停
ctx.subagents.followup(hostAgent, childId, content, {source,signal})  // 恢复 / 重试 continue
ctx.sessions.fork(childId, turn边界) + ctx.agents.create({seed})      // 重试 revert/fork（产生新 session id）
```

> **等待轮完成的机制（经探索确认）**：`child.whenIdle()` 是权威 per-turn 原语（one-shot driver 内部同源）。坑位：①「先 followup 再 whenIdle」（idle 可能「未开始」）；② hold 住 child 引用（叶子子代理 settle 后被 dispose）；③ `subagent/end` 是 settle（销毁）时发、非每轮，复用 childId 多轮须用 `turn/end` 关联；④ settlement notice 会 `parent.followup` 唤醒主代理（消耗 token，需处理副作用）。

### 2.2 DSH 组件映射

| DSH Service（ctx key） | 核心方法 | 用途 |
|---|---|---|
| `ctx.llm` | `stream(options)` / `prepareCall()` / `listProviders()` / `listModels()` / `resolveModelInfo()` | 模型推理（分支/finalize 临时会话）；waterfall `llm/stream` |
| `ctx.subagents` | `startContinuable(spec)` / `start(name, req)` / `followup()` / `interrupt()` / `reportFrom()` / `listChildren()` | 可续接子代理（Step 执行）+ 一次性子代理 |
| `ctx.sessions` | `create(id, {seed})` / `append` / `flush` / `list` | Session 事件日志（chat.json 替代） |
| `ctx.sessionPersistence` | `create` / `append` / `load` / `inspect` / `prepare` / `readFrom` / `list` | 会话持久化（崩溃恢复） |
| `ctx.storageDomain` | `open(spec)` → schema 验证 KV（tables/global） | work.json 状态快照 |
| `ctx.shell` | `resolve(request)` / `run(spec)` / `start(spec)` / `get sandboxMode()` | Shell 执行（高层 `bash -c`） |
| `ctx.subprocess` | `resolveExecutable()` / `spawn()` / `spawnTerminal()` | 底层进程（stdin 注入/流式/终端） |
| `ctx.fs` | `readText` / `writeText` / `editText` / `listDir` / `stat` / `resolve` / `streamText` | 产物/文件；waterfall `fs/write-intent`/`fs/edit-intent` |
| `ctx.sandbox` | `confine(argv, policy)` | 沙箱约束（`read-only`/`workspace-write`/`danger-full-access`） |
| `ctx.sessionProjections` | `register(unit)`（event 折叠） | 前端状态推送（`session/projection` 帧） |
| `ctx.agents` | `create()` / `resume()` / `get(id)` | 底层 agent 工厂（崩溃恢复用 `resume`） |

---

## 3. SDK 能力全量映射（零 @codeagent/sdk 依赖）

> 来源：dsh-workflow.md §5.3A

原 sandore 引擎的 `engine/internal/sdk/` 有 4 个文件，每个能力逐一映射到 DSH 组件。**映射后 `engine/internal/sdk/` 整层删除。**

### 3.1 `client.ts`（SDK 客户端）→ 删除

| sandore `client.ts` 能力 | DSH 等价组件 | 说明 |
|---|---|---|
| `getClient()`（TTL 缓存 + Auto-Start/Connect + 单例 Promise） | **不需要** | DSH 的 `ctx.llm`/`ctx.agents`/`ctx.subagents` 已内置 provider 路由、模型解析、适配器注册（`ctx.llm.registerAdapter`），无「连接客户端」概念 |
| `discoverBinaryPath()`（Linux 二进制发现） | **删除** | DSH 无独立 codeagent 二进制 |
| `ensureWorkspace(directory, mode)` | `ctx.fs` + workspace 服务（`ctx.workspaces`） | 工作流实例目录用 `ctx.fs` 创建；权限模式见下行 |
| `setPermissionMode`/`getPermissionMode`（bypassPermissions/acceptEdits/default） | `packages/interaction` 权限 seam + 实例级 Config | 权限模式作为 `DagStartRequest` 或实例级状态，由交互 seam 的自动回复策略执行 |
| `setExternalClient`/`invalidateClient`/`connectClient` | **删除** | 无外部 SDK 客户端可注入 |

### 3.2 `session.ts`（SDK 会话）→ 替换

| sandore `session.ts` 能力 | DSH 等价组件 | 说明 |
|---|---|---|
| `createSession()` | `ctx.subagents.startContinuable()` / `ctx.agents.create()` | Step 会话（可续接）；临时会话用一次性子代理或 `ctx.llm.stream()` |
| `sendChat()`（fire-and-forget） | `ctx.subagents.followup()` / `agent.send()` | 发送消息 |
| `subscribeEvents()`（目录级 SSE） | DSH Cordis 事件（`ctx.on('subagent/*')` + `session/event`）+ apiproxy SSE | 见 §5.5 |
| `getSessionMessages()`（jsonl 优先 + SDK 回退） | `ctx.sessions`（Session 日志派生历史）/ `ctx.sessionQuery` | DSH 消息历史是**从事件日志派生**的，无需 jsonl 文件 |
| `getCommands()`/`listHooks()` | `ctx.commands` / `ctx.mcp`（如引擎支持 skill/mcp 命令类型） | skill/mcp 命令类型的名称校验 |
| `abortSession()` | `ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: hostAgent })` | 中止当前提示（会话保留） |
| `deleteSession()` | `ctx.sessions` 生命周期 / session 删除 | 清理 |
| `revertSession()`/`unrevertSession()` | **DSH 无 revert 原语**——`ctx.sessions.fork(childId, turn边界)` + `ctx.agents.create({seed})` 续跑 | 重试 revert 模式，产生新 session id，回退粒度 turn 边界 |
| `forkSession()` | `ctx.sessions.fork(childId, boundary?)`（现成原语） | 重试 fork 模式 + finalize fork 会话 |
| `buildPermissionRules()`/`autoReplyPermission()` | **DSH permission presets（子代理继承父级，approval `never`= 自动拒绝提权）** | 不再手写权限规则；普通 sandbox 内文件/shell 正常执行 |
| `stripThinkTags()`/`readLastTextFromJsonl()`/`reconstructMessagesFromJsonl()`/`appendMessagesToJsonl()` | DSH 历史派生 + `ctx.sessionQuery`（全文检索） | think 标签剥离复用 `llm-streaming` 的既有处理；jsonl 持久化由 `ctx.sessionPersistence` 承担 |

### 3.3 `sse-manager.ts`（SdkSseManager 单例）→ 删除

| sandore `sse-manager.ts` 能力 | DSH 等价组件 | 说明 |
|---|---|---|
| per-directory ref-counted SSE 连接 | apiproxy 双 SSE 流（`/api/events.mux` + `/api/events.host`） | DSH 统一 SSE 架构，无需自建 |
| `normalizeEvent()`（messageID/partId 修复） | **删除** | DSH 的 session 事件已是规范化事件，无此需求 |
| 事件规范化 + jsonl 持久化 | `ctx.sessionPersistence`（JSONL/SQLite 后端） | 会话事件持久化由 seam 负责 |
| 指数退避重连（1s→30s） | apiproxy SSE 的重连机制 | 由 DSH 前端 SSE 客户端处理 |
| 子 Agent sessionId 追踪 | `ctx.subagents`（`subagent/start`/`subagent/end` + `listChildren`） | 原生支持 |
| `setEventPublisher`/`resolveDirectory` | **删除** | 事件发布用 `ctx.emit`；目录解析无需（DSH 无 directory 概念） |

### 3.4 `utils.ts`（临时会话工具）→ 替换

| sandore `utils.ts` 能力 | DSH 等价组件 | 说明 |
|---|---|---|
| `startTempSession()` | `ctx.llm.prepareCall()` + `ctx.llm.stream()`（或一次性 `ctx.subagents.start()`） | 分支评估/finalize 的一次性推理 |
| `collectTempSession()` | 收集 `ctx.llm.stream()` 的 AsyncIterable 输出 | 读取临时推理结果 |
| `runTempSession()` | 上面两步的组合 | 便捷方法 |
| `waitForSessionIdle()` | `ctx.on('subagent/end')` / 子代理 Session 事件等待 | 等待一次性子代理结算 |

> **结论**：`engine/internal/sdk/` 的四个文件**全部删除或替换**，引擎零外部 SDK 依赖。唯一保留的是引擎对「会话/推理/Shell/文件」的**抽象调用点**——它们的实现由 DSH 的 `ctx.*` 服务提供。

---

## 4. 输入消息构建 — InputFrom 解析

> 来源：dynamic-workflow-engine.md §6.3、§8.2

### 4.1 InputFrom 路径格式

支持三种路径格式：

| 格式 | 含义 | 示例 |
|------|------|------|
| `stg-xxx` | Stage 级 | 该 Stage 所有 step 输出（倒序，最近优先） |
| `stg-xxx.step-xxx` | Step 级 | 最近匹配 Step 的所有输出 |
| `stg-xxx.step-xxx.opt-xxx` | OutputTo 级 | 特定 outputTo 的产物 |

还支持 `regex` / `glob` 模式匹配文件路径，以及 `${xxx}` 透传变量替换。

### 4.2 就近匹配算法（`resolvePathSegments`）

1. 扁平化 `executedSteps`（递归展开循环容器），得到带索引的 `flatEntries`
2. 找到当前 Step 的 `currentFlatIdx`
3. **Stage 级**：返回该 Stage 下所有 Step（倒序，最近优先）
4. **Step 级**：从当前 Step 往前搜索，找到最近的匹配 ID（`idMatches` 辅助函数支持后缀匹配 `actualId === targetId || actualId.startsWith(targetId + '-')`）
5. **OutputTo 级**：从当前 Step 前一个位置往前搜索，找到匹配 Step 后过滤特定 outputTo

**回退机制**：无 `inputFrom` 时，自动使用前一个 Step（`currentFlatIdx - 1`）的输出。

### 4.3 InputFrom 路径解析实现（`resolveFromInputFrom`）

```typescript
resolveFromInputFrom(workState, inputFromItems): any[]
```

- `path` 模式：按 `.` 分割，逐级定位到 Stage / Step / OutputTo
- `regex` 模式：遍历所有 step/stage 输出，正则匹配

### 4.4 结构化提示词模板（`executeAgentSession`）— V2.5 重构

```
[主头部]
你是严谨准确的Step执行Agent，你的任务是参考`## 参考信息`和`## 前置Steps输出`中的信息，
准确完成`## 你的任务`中的要求。

## 你的任务
{promptText — agent/skill/mcp/prompt 类型的任务描述}

## 参考信息
### 用户原始需求
{_jobRequirement}
### 当前Step参数
{paramsText — 仅 agent 类型有 agentParamsTemplate 时}
### 其他输入信息
- {_otherValues[0]}
- {_otherValues[1]}
### 用户补充信息【仅供参考】
- {_userSupplementMessages[0]}
- {_userSupplementMessages[1]}

## 前置Steps输出与产物
### 前置Step: {name} ({id})
<{id}>
  <output>
    {returnPrompt — 逐行缩进}
  </output>
  <artifacts>
    - {artifactFile1}
    - {artifactFile2}
  </artifacts>
</{id}>

## 任务规则
- **{ruleKey1}**: {ruleContent1}
- **{ruleKey2}**: {ruleContent2}
```

---

## 5. 产物收集 — OutputTo 解析

> 来源：dynamic-workflow-engine.md §6.4、§8.3

### 5.1 OutputTo 定义

```typescript
outputTo: Array<{ id: string; path?: string; regex?: string }>
```

- `path`：文件路径（支持 glob 模式如 `artifacts/*.md`）
- `regex`：正则表达式匹配文件路径
- 引擎自动区分 glob 与 regex：包含 `*`/`?` 且无 regex 特征（如 `\d`、`(?`）→ 视为 glob

### 5.2 output.json 结构

产物收集结果写入 `{stepMessageId}_output.json`：

```json
{
  "sessionId": "...",
  "output": {
    "returnPrompt": "AI 返回的文本",
    "artifacts": [
      { "id": "opt-xxx", "value": ["/abs/path/to/file1.md", "/abs/path/to/file2.md"] }
    ]
  }
}
```

### 5.3 OutputTo 路径解析函数

```typescript
findFilesByGlob(rootDir, pattern, cwd): string[]  // glob 模式文件搜索
findFilesByRegex(rootDir, regex, cwd): string[]    // 正则文件搜索
walkDir(dir, regex, results, cwd): void            // 递归目录遍历（被上述两者调用）
globToRegex(glob): RegExp                          // glob→RegExp 转换（private）
escapeRegexChar(ch): string                        // 单字符正则转义（private）
```

**Glob→Regex 转换规则**：
- `*` → `[^/]*`（单层通配）
- `**` → `.*`（多层通配，自动跳过后续 `/`）
- `?` → `[^/]`（单字符通配）
- 其他字符 → 正则转义

---

## 6. Step 完成判定与 askUserQuestion 转换

> 来源：dynamic-workflow-engine.md §6.7

### 6.1 完成判定类型（V2.6 新增）

V2.6 的 `FinalizeAssessResult.completionType` 支持两种值：

| 类型 | 含义 | Step 后续行为 |
|------|------|--------------|
| `completed` | 任务已正确完成，无遗留问题 | 继续门禁审查（如配置）→ 推进下一节点 |
| `ask` | 存在疑问或需要用户确认才能继续 | 注入 askUserQuestion → Step 进入 `interacting` → 等待用户回复 |

### 6.2 askUserQuestion 转换流程

```
FinalizeAssessor 判定 completionType='ask'
    │
    ▼
提取 askQuestion 字段（JSON 解析 → regex 回退）
    │
    ▼
构造 AskUserQuestionPayload:
    { questions: [{ id, question, header?, options?, multi_select? }] }
    │
    ▼
注入 WorkflowInteractionManager:
    ├── 构造 PendingQuestion { id: requestId, questions: askQuestion.questions }
    ├── addPendingQuestion() → emit workflow.question + workflow.chat_updated
    └── updateStepStatusInExecutedSteps(stepId, 'interacting')
    │
    ▼
Step 进入 interacting 状态，等待用户回复
    │
    ▼
用户回复 → POST /question/reply
    │
    ▼
engine.replyQuestion() → interactionManager.replyQuestion()
    ├── runner.replyQuestion(requestId, answers) → SDK client.reply()
    ├── 更新 pending.status = 'replied'
    ├── updateStepStatusInExecutedSteps(stepId, 'running')
    └── emit workflow.question_replied
    │
    ▼
Step 恢复执行:
    ├── 若配置了门禁 → gateEvaluator.evaluate() 继续第 2 部分
    └── finalize 完成 → 推进下一节点
```

### 6.3 askUserQuestion 与 SDK 原生 question 的统一

V2.6 的 `askUserQuestion` 与 V2.5 的 SDK 原生 `question.asked` 事件统一走同一套交互管道（`WorkflowInteractionManager`）：

| 来源 | 触发方式 | 数据结构 | 回复路径 |
|------|---------|---------|---------|
| SDK 原生 `question.asked` | SDK Agent 执行中遇到问答需求 | `PendingQuestion.questions`（SDK 原生格式） | `replyQuestion()` |
| V2.6 `askUserQuestion` | FinalizeAssessor 判定 `completionType='ask'` | `PendingQuestion.questions`（对齐 DSH harness schema） | `replyQuestion()` |

> **区别**：SDK 原生 question 在 Step **执行中**触发（Agent 主动提问），askUserQuestion 在 Step **收尾时**触发（FinalizeAssessor 判定需确认）。两者统一走 `WorkflowInteractionManager`，前端无需区分处理。

### 6.4 AskUserQuestionPayload Schema（对齐 DSH harness）

```typescript
AskUserQuestionPayload {
  questions: Array<{
    id: string                             // stable id，用于路由回复（echoed in answer）
    question: string                       // 具体问题
    header?: string                        // 可选短标题（如 "Confirm" / "Choose Mode"）
    options?: Array<{
      label: string                        // 选项标签（推荐选项可加 "(Recommended)"）
      description?: string                 // 一句话说明选项的权衡或影响
    }>
    multi_select?: boolean                 // 是否允许多选，默认 false
  }>
}
```

> **对齐说明**：此 schema 对齐 DSH harness 的 `ask_user_question` 工具参数结构。`id` 为 stable id（回复时 echo），`question` 为具体问题，`options` 为可选选项列表，`multi_select` 控制是否多选。这使 V2.6 引擎的 askUserQuestion 可直接对接 DSH harness 的交互 UI。

---

## 7. 分支评估器 — BranchEvaluator

> 来源：dynamic-workflow-engine.md §7

### 7.0 接口与构造函数

```typescript
interface BranchEvalResult {
  output: string;                            // 提取的期望/输出字符串
  sessionHandle: TempSessionHandle | null;   // 会话句柄（Bash 为 null）
}

// V2.4.2: 构造函数新增 jobId/taskId/stepId 参数
constructor(directory: string, defaultTimeoutMs?: number, jobId?: string, taskId?: string, stepId?: string)
```

> **V2.4.2 变更**：构造函数新增 `jobId`、`taskId`、`stepId` 可选参数，用于在 Bash 模式下读取 work.json 和当前 Step 的 output.json。`DagNavigator.evaluateBranches()` 和 `LoopManager.checkLoopBreak()` 构造 BranchEvaluator 时传入这三个参数。

### 7.1 两阶段执行

```
Phase 1: start(condition, contextMessage)
  ├── shell: V2.4.2 增强 exec() — 透传变量替换 + 环境变量注入 + stdin 注入，无会话
  └── agent/prompt/skill/mcp: startTempSession() → 返回 { output: '', sessionHandle }

Phase 2: collect(partial)
  ├── shell: 直接返回 partial（已在 start 中完成）
  └── agent/prompt/skill/mcp: collectTempSession(handle, {keepSession: true}) → extractExpectation()
```

便捷方法 `evaluate(condition, contextMessage?)` 一步完成 start + collect。

**startAgentSession 细节**：
- 会话标题格式：`[condition] {promptText前40字符}`
- 传递 `providerId` / `modelId` 到临时会话（从 condition.value 继承）
- parts 数组：`[{ type: 'text', text: contextMessage ?? promptText }]`

**collect() 的 keepSession: true**：保留评估会话，前端可点击查看详情。

**evaluateBash 细节**（V2.4.2 增强）：
- **透传变量替换**：`replacePassThroughVars()` 将命令中的 `${xxx}` 替换为 work.json 中 `passThroughVars` 的值
- **环境变量注入**：非空值的 `passThroughVars` 作为环境变量注入子进程
- **stdin 注入**：`readStepOutputForStdin()` 从当前 Step 的 output.json 读取完整内容，作为 JSON 写入子进程 stdin
- 新增私有方法：`readWorkState()`（加载 work.json）、`replacePassThroughVars()`、`readStepOutputForStdin()`

### 7.2 输出解析

**分支判断** — `extractExpectation(raw)`：

```
1. JSON 解析 → json.branchExpectation
2. Regex 回退 → /"branchExpectation"\s*:\s*"([^"]+)"/
3. 原始输出 → raw.trim()
```

**循环跳出** — `extractBreakResult(raw)`（**public** 方法，由引擎 `checkLoopBreak()` 调用）：

```
1. JSON 解析 → json.shouldBreak
2. Regex 回退 → /"shouldBreak"\s*:\s*(true|false)/i（大小写不敏感，匹配后转小写）
3. 原始输出 → raw.trim()
```

### 7.3 AI 评估提示词模板

分支评估器构建的上下文消息包含：

- 用户配置的分支提示词（condition prompt）
- 之前步骤的输入/输出
- 分支列表（每个分支的名称 + 期望值）
- 返回格式要求（JSON `{"branchExpectation": "..."}`）
- 红线规则（禁止编辑/创建/删除文件、禁止过度思考）

---

## 8. 循环与嵌套循环

> 来源：dynamic-workflow-engine.md §16、§5.6

> **V2.3 重大变更**：循环容器扁平化 — `ExecutedStepLoop` 类型完全移除。循环迭代通过扁平 `ExecutedStepDefault[]` + `loopIteration: number[]` + `loopMeta: BranchMeta` 字段表示。`migrateToLoop()`/`appendToLoop()`/`findInnermostLoopContainer()` 方法删除。新增 `activeLoopIterationStack` + `buildLoopIterationPath()`。
>
> **V2.4.2 变更**：`checkLoopBreak()` 新增 artifacts XML 块注入 AI 提示词 — 读取当前 Step 产物文件列表，构建 `<artifacts>` XML 块注入跳出判断上下文。`BranchEvaluator` 构造函数新增 `jobId`/`taskId`/`stepId` 参数，支持 stdin 注入与环境变量注入。

### 8.1 WorkflowLoopManager 管理器

**职责**：循环扁平化迭代管理、跳出检测、ID 后缀机制。

**字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `activeLoopStack` | `string[]` | 活跃循环栈（嵌套循环用） |
| `activeLoopIterationStack` | `number[]` | V2.3 新增：嵌套循环迭代路径栈 |
| `pendingLoopNodeId` | `string \| null` | V2.3 新增：待处理的循环节点 ID |
| `pendingLoopMeta` | `BranchMeta \| null` | 待应用的循环评估元数据 |
| `stepIdSuffixMap` | `Map<string, string>` | 原始 ID → 后缀 ID |

**方法清单**：

| 方法 | 签名 | 说明 |
|------|------|------|
| `activeLoopNodeId` (getter) | `: string \| null` | 栈顶循环节点 ID |
| `getActiveLoopStack` / `setActiveLoopStack` | — | 循环栈 getter/setter |
| `pushActiveLoop` / `popActiveLoop` | `(loopToNodeId): void` / `(): string \| undefined` | 栈操作（V2.3: push 同时初始化迭代计数） |
| `getStepIdSuffixMap` | `(): Map<string, string>` | 后缀映射 getter |
| `getActualStepId` | `(originalStepId): string` | 获取带后缀的实际 ID |
| `static loopIdSuffix` | `(): string` | 生成 4 位 hex 后缀 |
| `stripIdSuffix` | `(id): string` | 去除 4 位 hex 后缀 |
| `getActiveLoopIterationStack` / `setActiveLoopIterationStack` | — | V2.3 新增：迭代路径栈 getter/setter |
| `incrementLoopIteration` | `(): void` | V2.3 新增：递增当前循环迭代计数 |
| `buildLoopIterationPath` | `(): number[]` | V2.3 新增：构建嵌套循环迭代路径（如 [1, 2]） |
| `pushEntryToActiveLoop` | `(entry: ExecutedStepDefault): void` | V2.3: 直接推入扁平 `executedSteps` 数组（不再推入循环容器） |
| `setLoopIterationMeta` | `(meta: BranchMeta, nodeId): boolean` | V2.3: 新增 `nodeId` 参数 — 设置最新迭代的 loopMeta |
| `applyPendingLoopMeta` | `(): void` | 应用待处理的 loopMeta |
| `resetLoopVisitCounts` | `(nodeId?): void` | V2.3: 新增可选 `nodeId` 参数 — 重置循环内节点访问计数 |
| `checkLoopBreak` | `async (node: DagNodeRef): Promise<boolean>` | 循环跳出检测：maxIterations + AI breakCondition。V2.4.2: BranchEvaluator 构造传入 jobId/taskId/node.id；使用 `engine.readStepOutputText(node.id)` 获取当前 Step 输出；新增 artifacts XML 块注入 AI 提示词 |

### 8.2 循环触发条件

当 `DagNodeRef.loop` 存在时，`resolveNextNodes()` 触发循环逻辑。循环的 `loopTo` 目标通过以下优先级确定：

1. `loop.next`（最高优先级）
2. 分支评估结果
3. `node.next`（仅同阶段）

### 8.3 循环执行流程

```
首次进入循环 (activeLoopNodeId === null):
  1. V2.3: 不再迁移步骤到循环容器 — 已执行步骤保留在扁平 executedSteps 中
  2. pushActiveLoop(loopToNodeId) — 内部执行 activeLoopStack.push + activeLoopIterationStack.push(1)
  3. checkLoopBreak(node) — 检查是否应该跳出
     ├── 跳出: resetLoopVisitCounts(nodeId) + popActiveLoop() + 入队 exitTo
     └── 继续: 创建新迭代 + 入队 loop.next 或分支目标

循环继续 (activeLoopNodeId 匹配):
  1. 步骤通过 pushEntryToActiveLoop(entry) 直接推入扁平 executedSteps 数组
     ├── V2.3: 设置 entry.id = 原始ID-后缀, entry.stepId = 原始ID, entry.loopIteration = buildLoopIterationPath()
     └── loopMeta 不在此设置 — 由 checkLoopBreak() 中 setLoopIterationMeta() 单独写入
  2. checkLoopBreak(node)
  3. 不跳出 → incrementLoopIteration() + 入队 loop.next

嵌套循环 (activeLoopNodeId 不匹配):
  1. V2.3: 不再创建嵌套循环容器 — 直接 pushActiveLoop() 压入新循环
  2. pushActiveLoop(loopToNodeId) — activeLoopStack.push + activeLoopIterationStack.push(1)
  3. 同上
```

### 8.4 ID 后缀机制

循环内每次迭代，Step ID 添加 4 位 hex 后缀以避免冲突：

```
原始 ID: step-xxx → 循环第1次: step-xxx-49aa → 循环第2次: step-xxx-7f2b
```

`stepIdSuffixMap` 维护原始 ID → 后缀 ID 的映射，用于：

- 将 Runner 的事件（使用原始 ID）映射到前端期望的后缀 ID（`getActualStepId(originalStepId)`）
- 将前端的回复（使用后缀 ID）映射回 Runner 的原始 ID（`stripIdSuffix(id)`）

### 8.5 扁平循环数据结构（V2.3 重构）

**旧结构（已移除）**：
```typescript
// ExecutedStepLoop — V2.3 完全移除
{ type: 'loop', loops: [{ count: 1, steps: [...], loopMeta?: BranchMeta }, ...] }
```

**新结构（V2.3）**：
```typescript
// 循环迭代直接作为扁平 ExecutedStepDefault 存在于 executedSteps 数组中
ExecutedStepDefault {
  type: 'default',
  id: 'step-xxx-49aa',           // 带后缀的 ID（pushEntryToActiveLoop 生成）
  stepId: 'step-xxx',            // V2.3 新增：原始未带后缀的 ID（用于事件映射）
  stageId: 'stg-xxx',
  name: '步骤名称',
  status: 'completed',
  loopIteration?: number[],       // V2.3 新增：嵌套循环路径，如 [1, 2] = 外层第1次迭代 + 内层第2次迭代
  loopMeta?: BranchMeta,          // V2.3 新增：循环评估元数据（由 setLoopIterationMeta 写入）
  // ... 其他标准字段
}
```

- `id` / `stepId`：`pushEntryToActiveLoop()` 生成后缀 ID 写入 `id`，原始 ID 保留到 `stepId`，`stepIdSuffixMap` 记录映射
- `loopIteration`：嵌套循环的迭代路径，如 `[1, 2]` 表示外层循环第 1 次迭代、内层循环第 2 次迭代
- `loopMeta`：循环评估元数据（status: evaluating/completed、sessionId、directory、result），由 `checkLoopBreak()` 两阶段写入
- 前端通过 `loopIteration` 字段分组显示迭代选项卡

### 8.6 循环跳出检测

```typescript
checkLoopBreak(node: DagNodeRef): Promise<boolean>
```

**判断优先级**：

1. **硬上限**：`visitCount >= maxIterations` → 立即跳出（直接返回 `true`）
2. **breakCondition 评估**（若配置了 `loop.breakCondition`）：

   构造 `BranchEvaluator(cwd, defaultTimeoutMs, jobId, taskId, node.id)`（V2.4.2: 传入 jobId/taskId/stepId），收集当前 Step 上下文：

   | 上下文 | 来源 | 处理 |
   |--------|------|------|
   | Step 输入 | `readStepInputForFinalize(currentStepDef)` 或 `getRecentStepInput()` | 缩进 4 格写入 `<input>` 块 |
   | Step 输出 | `readStepOutputText(node.id)` | 截取前 4000 字符，缩进 4 格写入 `<output>` 块 |
   | Step 产物 | `collectStepArtifacts(currentStepDef)` → `flatMap(a => a.value)` | **V2.4.2 新增**：构建 `<artifacts>` XML 块注入提示词 |

   构建结构化 `contextMsg` 提示词，包含用户配置的跳出条件提示词 + `<input>`/`<output>`/`<artifacts>` XML 块 + 返回 JSON 样式 + 红线事项。

   **两阶段评估**（agent/prompt/skill/mcp 类型）：

   - **Phase 1 `start()`**：创建临时会话 + 发送提示词，返回 `partial`（含 `sessionHandle`）
     - 写入 `evaluating` loopMeta（`status: 'evaluating'`, `sessionId`, `directory`）到循环源 Step，通过 `setLoopIterationMeta()` 或暂存到 `pendingLoopMeta`
   - **Phase 2 `collect()`**：等待会话空闲，读取输出
     - `extractBreakResult(result.output)` 提取 `shouldBreak` 值（JSON 解析 → regex 回退 → 原始输出）
     - 写入 `completed` loopMeta（`status: 'completed'`, `result: breakResult`, `sessionId`, `directory`）

   **跳出判定**：

   - **Shell 模式**（`breakCondition.type === 'shell'`）：`matchesExpectation(breakResult, breakExpectation)` → 跳出
   - **Agent/Prompt/Skill/MCP 模式**：`breakResult === 'true'` → 跳出

**跳出后**：`resetLoopVisitCounts(nodeId)` 重置循环内所有节点的访问计数，`popActiveLoop()` 弹出循环栈（先 `activeLoopIterationStack.pop()` 再 `activeLoopStack.pop()`）。

### 8.7 跨阶段循环排除

V2.3: 不再需要 `migrateToLoop()` 的跨阶段排除逻辑，因为循环迭代直接以扁平条目存在于 `executedSteps` 中，每个条目自带 `stageId`，天然不会混淆跨阶段步骤。

### 8.8 循环迭代上下文注入（V2.4.2 新增）

引擎在 `executeStepNode` normal/retry 模式创建 Runner 时，从 `loopManager` 注入循环迭代上下文：

| Runner 属性 | 来源 | 说明 |
|------------|------|------|
| `loopIteration` | `loopManager.buildLoopIterationPath()?.slice(-1)[0] ?? 0` | 最内层循环的当前迭代序号（1-based），0 表示不在循环中 |
| `loopMaxIterations` | 活跃循环节点的 `loop.maxIterations ?? 0` | 最内层循环的最大迭代数，0 表示不在循环中 |

**Shell 模式**：注入为环境变量 `in-loop-turn`（当前迭代）和 `all-loop-turn`（最大迭代），Shell 命令可直接引用。

**Agent 会话模式**：`replacePassThroughVars()` 支持这两个特殊变量替换，promptText 中的 `${in-loop-turn}` 和 `${all-loop-turn}` 会被替换为对应值。

> **设计意图**：让循环内的 Step 感知当前迭代进度，例如 Shell 命令可以根据迭代序号执行不同逻辑，Agent 提示词可以引用当前迭代信息。

---

## 9. Finalize 拆分 — WorkflowFinalizeManager

> 来源：dynamic-workflow-engine.md §5.5

### 9.1 总体设计（V2.6 重构）

> **V2.6 重构**：将原 `finalizeStepVars()` 的"透传变量提取 + 门禁检查"一体化逻辑，拆分为**两个独立的收尾阶段**，各自使用不同的会话策略。

- **Finalize 第 1 部分 — 完成判定 + 透传变量提取（FinalizeAssessor）**：
  - 从当前 Step 所在分支 **fork 一个会话分支**（仅 session 类型 Step；shell 类型启动临时 AI 会话）
  - 在 fork 会话中做两件事：① 处理透传变量（提取 `${xxx}` 值）；② 判断 Step 完成类型（`completed` / `ask`）
  - 若判定为 `ask`（有疑问需提问），将问题转换为 `askUserQuestion` 类型的 JSON（对齐 DSH harness 的 `ask_user_question` 工具 schema），Step 进入 `interacting` 状态等待用户回复
  - 两部分结果合并为一个 JSON 返回
- **Finalize 第 2 部分 — 门禁审查（GateEvaluator）**：
  - 单独开一个新 session，按原有门禁逻辑审查（primary/secondary gate）
  - 与第 1 部分完全独立，可并行或串行执行

> **设计理由**：V2.5 的 `finalizeStepVars` 将透传变量提取和门禁检查耦合在同一个 AI 会话中，导致①门禁 prompt 污染变量提取、②无法独立重试、③shell 类型 Step 无法利用 session 上下文。拆分后各部分职责单一，且 fork 会话模式与 V3 的"收尾在 fork session 中进行"完全一致。

### 9.2 WorkflowFinalizeManager 字段与方法

**字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `passThroughVars` | `Map<string, {value, description, refresh?}>` | 全局透传变量（V2.4.2: 新增 `refresh` 标志） |
| `finalizeMeta` | `Map<string, FinalizeMeta>` | Step 收尾元数据（V2.6: 扩展为含 `assessResult` + `gateResult`） |
| `assessor` | `FinalizeAssessor` | V2.6 新增：收尾第 1 部分执行器（fork 会话） |
| `gateEvaluator` | `GateEvaluator` | V2.6 新增：收尾第 2 部分执行器（独立 session） |

**方法清单**：

| 方法 | 签名 | 说明 |
|------|------|------|
| `initPassThroughVars` | `(definition, jobId, taskId): void` | 从定义收集（V2.4.2: 保留 `refresh` 标志）+ 从持久化状态恢复透传变量 |
| `getPassThroughVars` / `getFinalizeMeta` | — | Getter |
| `replaceVars` | `(str): string` | 替换 `${xxx}` 透传变量 |
| `hasUnresolvedVars` | `(str): boolean` | 检查未解析变量 |
| `findFilesByGlob` / `findFilesByRegex` | `(rootDir, pattern/regex): string[]` | 文件搜索（委托 file-utils） |
| `collectStepArtifacts` | `(stepDef): Array<{id, value: string[]}>` | 收集 outputTo 产物 |
| `resolveOutputToVars` | `(stepDef): OutputToItem[]` | 解析 outputTo 中的透传变量，返回延迟项 |
| `finalizeStep` | `async (stepDef, stageId, stepId, stepRunner, resolvedGates?): Promise<FinalizeOutcome>` | V2.6 新增：编排两部分收尾 |
| `readStepInputForFinalize` | `(stepDef): string` | 读取 parts.json 构建 finalize 上下文 |
| `extractVarValues` | `(output, vars): {taskStatus, errorDetail?}` | 从 AI 输出提取变量值（V2.6: 由 `assessor` 内部调用） |
| `updateStepFinalizeInExecutedSteps` | `(stepId): void` | 同步 finalizeMeta 到 executedSteps |

### 9.3 FinalizeAssessor — 收尾第 1 部分（V2.6 新增）

**职责**：在 fork 会话中完成①透传变量提取②Step 完成判定，两部分合并为一个 JSON 返回。

**会话策略**（经探索修正：DSH fork 原语）：
- **Session 类型 Step**（agent/prompt/skill/mcp）：`ctx.sessions.fork(stepSessionId, boundary?)` 创建会话分支（boundary = 最近一个 turn 边界，不能落在未闭合 turn 内），在 fork 会话上执行评估
- **Shell 类型 Step**：启动临时 AI 会话（`ctx.llm.stream()`），将 shell stdout 作为输入

**方法清单**：

| 方法 | 签名 | 说明 |
|------|------|------|
| `assess` | `async (stepDef, stageId, stepId, stepRunner): Promise<FinalizeAssessResult>` | 主入口：fork 会话 → 发送评估 prompt → collect → 解析结果 |
| `forkSessionForAssess` | `async (stepSessionId: string): Promise<string>` | Session 类型：`ctx.sessions.fork(stepSessionId)` 返回 fork sessionId |
| `buildAssessPrompt` | `(stepDef, input, output, artifacts, vars): string` | 构建评估提示词（含透传变量列表 + 完成判定要求 + askUserQuestion 格式说明） |
| `parseAssessResult` | `(raw: string, vars: string[]): FinalizeAssessResult` | 解析 AI 输出：JSON → regex 回退 → 原始输出。提取 `completionType` + `passThroughVars` + `askQuestion` |

**评估提示词结构**：

```
你是严谨准确的Step执行后处理Agent，在当前Step的会话分支中进行收尾评估。

<stepContext>
  <input>{step 输入}</input>
  <output>{step 输出 returnPrompt}</output>
  <artifacts>{产物文件列表}</artifacts>
</stepContext>

## 你的任务
1. 判断当前 Step 是否真正完成（completionType: 'completed' 或 'ask'）
   - completed: 任务已正确完成，无遗留问题
   - ask: 存在疑问或需要用户确认才能继续，需生成 askUserQuestion
2. 提取透传变量值（如有未解析变量）

## 透传变量
- {varName1}: {description1}
- {varName2}: {description2}

## 返回格式（JSON）
{
  "completionType": "completed" | "ask",
  "passThroughVars": { "varName1": "value1", "varName2": "value2" },
  "askQuestion": {                          // 仅 completionType='ask' 时
    "questions": [
      {
        "id": "stable-id",
        "question": "具体问题",
        "header": "可选标题",
        "options": [{"label": "选项A", "description": "说明"}],
        "multi_select": false
      }
    ]
  }
}

## 红线规则
- 禁止编辑或创建或删除任何文件
- 禁止过度探索
- askQuestion 的 questions 数组每项必须有稳定的 id 和具体的 question
```

> **askUserQuestion 对齐 DSH harness**：`askQuestion` 的 schema 对齐 DSH harness 的 `ask_user_question` 工具参数结构（`questions[]` 含 `id`/`question`/`header?`/`options?`/`multi_select?`）。当 `completionType='ask'` 时，引擎将 `askQuestion` 注入 `WorkflowInteractionManager` 作为 `PendingQuestion`，Step 进入 `interacting` 状态。用户回复后 Step 恢复执行。

### 9.4 GateEvaluator — 收尾第 2 部分（V2.6 新增）

**职责**：单独开一个新 session，按原有门禁逻辑审查（primary/secondary gate）。

**会话策略**：始终启动**独立新 session**（`startTempSession`），与第 1 部分的 fork 会话完全隔离。

**方法清单**：

| 方法 | 签名 | 说明 |
|------|------|------|
| `evaluate` | `async (stepDef, stageId, stepId, resolvedGates): Promise<GateEvalResult>` | 主入口：新 session → 发送门禁 prompt → collect → 解析结果 |
| `buildGatePrompt` | `(stepDef, input, output, artifacts, gates): string` | 构建门禁审查提示词（V2.5: primary/secondary 双门逻辑） |
| `parseGateResult` | `(raw: string, gates): GateEvalResult` | 解析 AI 输出：`gateStatus`/`gateDetail`（secondary）或 `taskStatus`/`errorDetail`（primary） |

**门禁审查提示词**（继承 V2.3 双门模式）：

- **Primary Gate**（默认）：校验产物文件是否存在 + 基本完成度检查，返回 `{"taskStatus": "done|error", "errorDetail": "..."}`
- **Secondary Gate**（`secondaryEnabled=true`）：完整门控审查，注入 `secondaryPrompt`，返回 `{"gateStatus": "done|error", "gateDetail": "..."}`

**产物验证**：`gateResult.gatesPassed === true` 时，验证所有 outputTo 文件是否存在。失败则覆盖为 `gatesPassed = false`。

### 9.5 finalizeStep 收尾编排流程（V2.6）

```
finalizeStep(stepDef, stageId, stepId, stepRunner, resolvedGates):

  1. 检查是否可跳过 finalize（无未解析变量 + 无 secondary 门禁 + 无 primary 门禁）
     → 跳过：返回 { type: 'done', assessResult: { completionType: 'completed', passThroughVars: {} } }

  2. 第 1 部分：assessor.assess(stepDef, stageId, stepId, stepRunner)
     ├── Session 类型 → forkSessionForAssess(stepSessionId)
     ├── Shell 类型 → startTempSession()
     ├── 发送评估 prompt（透传变量 + 完成判定）
     ├── collect → parseAssessResult()
     └── 写入 finalizeMeta: { status: 'evaluating' → 'completed'/'ask', assessResult }
     
  3. 判断 completionType:
     ├── 'ask' → 注入 askQuestion 到 InteractionManager
     │         → Step 进入 interacting 状态
     │         → 返回 { type: 'ask', assessResult }
     │         → 用户回复后，Step 恢复，gateEvaluator 继续第 2 部分（如配置了门禁）
     └── 'completed' → 继续第 2 部分

  4. 第 2 部分（仅当 resolvedGates 有 enabled 的门禁时）：
     gateEvaluator.evaluate(stepDef, stageId, stepId, resolvedGates)
     ├── startTempSession()（独立新 session）
     ├── 发送门禁 prompt
     ├── collect → parseGateResult()
     └── 写入 finalizeMeta: { gateResult }
     
  5. 判断 gateResult.gatesPassed:
     ├── true → 返回 { type: 'done', assessResult, gateResult }
     └── false → 返回 { type: 'error', errorDetail: gateResult.errorDetail, assessResult, gateResult }

  6. 更新 passThroughVars（assessResult.passThroughVars → passThroughVars Map，保留 refresh 标志）
  7. updateStepFinalizeInExecutedSteps(stepId)
  8. persistState()
```

> **与 V2.5 的差异**：
> - V2.5 的 `finalizeStepVars()` 将变量提取和门禁检查耦合在一个 AI 会话中，Normal 模式不做 taskStatus 判断、Secondary 模式才做完整审查
> - V2.6 拆分后，第 1 部分始终做完成判定 + 变量提取（fork 会话），第 2 部分独立做门禁审查（新 session），两者可独立重试
> - V2.6 新增 `ask` 完成类型：Step 可能因疑问进入 interacting，用户回复后继续

---

## 10. 关键类型定义

> 来源：dynamic-workflow-engine.md §3

### 10.1 DagLoop — 循环定义

```typescript
{ breakCondition?: CommandConfig; breakExpectation?: string; next?: string; maxIterations: number; exitTo?: string }
```

- `breakCondition`：AI 评估是否跳出循环
- `next`：循环内跳转目标（优先级高于 `step.next` 和分支评估结果）
- `maxIterations`：最大迭代次数（硬上限）
- `exitTo`：跳出后跳转的目标节点 ID（V2.4.2: 改为可选，省略时由 `tryAdvanceStage()` 自然推进）

### 10.2 DagBranch — 分支定义

```typescript
{ expectation?: string; next: string; label?: string }
```

- `expectation`：分支期望值，AI 输出的 `branchExpectation` 与之匹配。**省略 `expectation` 表示并行分支**，该分支始终执行
- `next`：匹配后跳转的目标节点 ID

### 10.3 BranchMeta — 分支/循环评估元数据

```typescript
BranchMeta {
  result?: string        // 评估输出
  sessionId?: string     // 评估会话 ID
  directory?: string     // 评估会话目录
  status: 'evaluating' | 'completed'
  expectation?: string   // 匹配的期望值
}
```

### 10.4 FinalizeAssessResult — 收尾第 1 部分结果（V2.6 新增）

```typescript
FinalizeAssessResult {
  completionType: 'completed' | 'ask'     // 完成判定
  passThroughVars: Record<string, string>  // 提取的透传变量值（name → value）
  askQuestion?: AskUserQuestionPayload     // completionType='ask' 时存在
  errorDetail?: string                     // 评估失败原因
  forkSessionId: string                    // fork 会话 ID
  assessmentRaw: string                    // AI 原始输出
}
```

### 10.5 GateEvalResult — 收尾第 2 部分结果（V2.6 新增）

```typescript
GateEvalResult {
  gatesPassed: boolean                    // 门禁是否通过
  primaryPassed: boolean                  // primary gate 结果
  secondaryPassed?: boolean               // secondary gate 结果（仅 enabled 时）
  gateDetails?: {
    primary: { enabled: boolean; passed: boolean }
    secondary: { enabled: boolean; passed: boolean; prompt?: string }
  }
  errorDetail?: string                    // 门禁失败原因
  gateSessionId: string                   // 门禁审查 session ID
  assessmentRaw: string                   // AI 原始输出
}
```

### 10.6 FinalizeOutcome — 收尾最终结果（V2.6 新增）

```typescript
type FinalizeOutcome = 
  | { type: 'done'; assessResult: FinalizeAssessResult; gateResult?: GateEvalResult }
  | { type: 'ask'; assessResult: FinalizeAssessResult }
  | { type: 'error'; errorDetail: string; assessResult?: FinalizeAssessResult; gateResult?: GateEvalResult }
```

### 10.7 FinalizeMeta — Step 收尾元数据（V2.6 扩展）

```typescript
FinalizeMeta {
  status: 'evaluating' | 'completed' | 'ask'
  sessionId?: string                      // fork 会话 ID（第 1 部分）
  gateSessionId?: string                  // 门禁会话 ID（第 2 部分，V2.6 新增）
  directory?: string
  errorDetail?: string
  // V2.6 新增字段
  completionType?: 'completed' | 'ask'    // 完成判定结果
  assessResult?: FinalizeAssessResult     // 第 1 部分完整结果
  gateResult?: GateEvalResult             // 第 2 部分完整结果
}
```

### 10.8 StepStatus — Step 状态枚举

```typescript
type StepStatus = 'blocked' | 'ready' | 'interacting' | 'running' | 'completed' | 'failed' | 'paused'
```

### 10.9 PassThroughVar — 透传变量

```typescript
{ name: string; value: string; description: string; refresh?: boolean }
```

> V2.4.2 新增 `refresh` 标志：标记为 `refresh=true` 的透传变量在 normal 模式执行前会被清空（空值），由当前 Step 的 finalize 重新提取。

---

## 11. 验证标准

Task 3 的验证标准为：**能执行带分支 / 循环 / 门禁 / 透传变量的完整 DAG 工作流**。

具体验证点：

| 能力 | 验证要点 |
|------|---------|
| **agent/skill/mcp Step** | `ctx.subagents.startContinuable()` 创建可续接子代理，首条提示词投递后监听 idle 事件，读取输出 |
| **分支评估** | `BranchEvaluator` 两阶段执行（start/collect），`extractExpectation` 正确解析 branchExpectation，`evaluateBranches` 正确路由到匹配分支 |
| **循环** | `loop.next` 优先级正确，`pushEntryToActiveLoop` 扁平入队 + ID 后缀 + `loopIteration` 路径正确 |
| **嵌套循环** | `activeLoopStack` / `activeLoopIterationStack` 嵌套压栈，`loopIteration` 为数组（如 `[1, 2]`） |
| **循环跳出** | `checkLoopBreak` 硬上限 → breakCondition 两阶段评估 → `shouldBreak` 正确解析 |
| **循环迭代上下文** | Shell 模式 `in-loop-turn`/`all-loop-turn` 环境变量注入；Agent 模式 `${in-loop-turn}`/`${all-loop-turn}` 变量替换 |
| **透传变量** | `initPassThroughVars` 初始化 + `replaceVars` 替换 + finalize 提取 + `refresh` 清空 |
| **Finalize 第 1 部分** | FinalizeAssessor fork 会话 → `buildAssessPrompt` → `parseAssessResult` → `completionType` + `passThroughVars` + `askQuestion` |
| **Finalize 第 2 部分** | GateEvaluator 独立 session → `buildGatePrompt` → `parseGateResult` → `gatesPassed` + 产物验证 |
| **ask 完成类型** | `completionType='ask'` → 注入 `AskUserQuestionPayload`（对齐 DSH `ask_user_question` schema）→ Step 进入 `interacting` → 用户回复 → 恢复 → 门禁继续 |
| **门禁** | Primary Gate（产物存在 + 基本完成度）+ Secondary Gate（`secondaryPrompt` 完整审查），两门独立 |
| **完整 DAG 端到端** | 定义含分支 + 循环 + 门禁 + 透传变量的工作流 YAML → 执行 → 分支正确路由 → 循环正确迭代/跳出 → finalize 正确提取变量/判定/门禁 → 工作流完成 |
