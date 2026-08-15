# Spec: agent-step-execution — agent/skill/mcp/shell Step 执行能力

## ADDED Requirements

### Requirement: agent 类型 Step 用可续接子代理执行
系统 SHALL 以 DSH 可续接子代理承载 agent 类型 Step：`ctx.subagents.startContinuable({ provider, label, request: { prompt, parent } })` 创建子代理，`ctx.agents.get(childId)` hold live Agent 引用，`await child.whenIdle()` 等待当前轮完成，`finalAssistantOutput(child.session.events)` 读取最终输出作为 Step `output`。provider 选择 SHALL 按 `command.providerId` > 引擎 `defaultProvider` 三层回退。

#### Scenario: agent Step 完整执行一轮
- **WHEN** 工作流执行 agent 类型 Step（promptText 已构建）
- **THEN** 系统调用 `startContinuable` 创建子代理并随 `request.prompt` 投递首条提示词，`whenIdle()` resolve 后立即以 `finalAssistantOutput` 读取子代理 session events 得到 `ContentBlock[]` 作为 Step 输出，`sessionMeta` 为 `{ childId: 真实SessionId, synthetic: false, command: 'agent' }`

#### Scenario: provider 回退
- **WHEN** agent Step 未配置 `providerId` 且 `defaultProvider` 指定的 provider 不存在
- **THEN** 系统按 Task 2 既有的 provider/model 三层回退逻辑选定可用 provider 后再创建子代理

### Requirement: agent Step 的 fillParams 参数填充
系统 SHALL 在 agent 类型 Step 定义了 `agentParamsTemplate` 时，先启动一次性临时会话（`ctx.llm.stream()`，含禁止编辑/创建/删除文件的红线规则提示词），输入为前置 Step 输出展开 + 参数模板 + 任务指令，将返回文本作为 `paramsText` 注入结构化提示词的「### 当前Step参数」子节，再投递给子代理。

#### Scenario: 填充成功
- **WHEN** agent Step 定义了 `agentParamsTemplate` 且临时会话正常返回
- **THEN** 填充结果文本进入提示词「### 当前Step参数」子节，子代理收到的 prompt 含该子节

#### Scenario: 填充失败回退
- **WHEN** 临时会话流式输出以 error/aborted 结束或抛错
- **THEN** Step 不中止，`paramsText` 回退为 `agentParamsTemplate` 原文并记录告警

### Requirement: skill/mcp 类型 Step 名称校验与 prompt 前缀
系统 SHALL 对 skill 类型校验 `command.promptText` 是否在工作流级 `skills` 数组中、mcp 类型校验是否在 `mcps` 数组中；匹配时提示词 SHALL 加前缀「使用 skill：{promptText}」/「使用 MCP：{promptText}」，不匹配时 SHALL 回退为纯提示词（不加前缀），不抛错。agent 类型同理校验 `workflow.agents` 数组。

#### Scenario: skill 名称在数组中
- **WHEN** skill Step 的 promptText 存在于 `workflow.skills` 数组
- **THEN** 提示词为「使用 skill：{promptText}」前缀 + 结构化提示词其余节

#### Scenario: mcp 名称不在数组中
- **WHEN** mcp Step 的 promptText 不在 `workflow.mcps` 数组
- **THEN** 回退为纯提示词执行，不报错，正常进入子代理/临时会话执行

### Requirement: skill/mcp/agent/prompt 会话承载
系统 SHALL 对 skill/mcp/agent 三类 Step 一律走可续接子代理（与 agent 相同路径）；prompt 类型 SHALL 保持 Task 2 的 `ctx.llm.stream()` 临时会话路径不变。

#### Scenario: skill Step 走子代理
- **WHEN** 执行 skill 类型 Step
- **THEN** 与 agent 类型相同的 startContinuable → whenIdle → finalAssistantOutput 路径执行，childId 为真实 SessionId

### Requirement: shell Step stdin 与环境变量注入
系统 SHALL 在 shell 类型 Step 存在 stdin 需求（`command.stdin` 配置、或 `inputFrom` 解析到内容）或需注入非空透传变量时，改用 `ctx.subprocess.spawn()`：stdin 以 `{ data }` 写入（`inputFrom` 解析结果 JSON 序列化），env 合并非空透传变量（含 `in-loop-turn`/`all-loop-turn`）；无上述需求时 SHALL 保持 `ctx.shell.run()` 简单路径。

#### Scenario: 有 inputFrom 的 shell Step
- **WHEN** shell Step 配置了 `inputFrom` 且解析到前置输出
- **THEN** 系统经 `ctx.subprocess.spawn()` 启动命令，前置输出 JSON 写入 stdin，stdout/stderr 按现有 `ShellRunResult` 形状返回

#### Scenario: 简单 shell 命令
- **WHEN** shell Step 无 stdin 需求且无透传变量注入
- **THEN** 走 `ctx.shell.run()`（`bash -c`）现有路径，行为与 Task 2 一致

### Requirement: 透传变量替换与循环上下文变量
系统 SHALL 在构建任何 Step 提示词/命令前，先用 `replacePassThroughVars` 将 `${xxx}` 替换为当前 `passThroughVars` 值；`${in-loop-turn}`/`${all-loop-turn}` SHALL 分别替换为当前迭代序号（1-based，不在循环中为 0）与活跃循环 `maxIterations`（不在循环中为 0）。未定义变量保留原文。

#### Scenario: 提示词变量替换
- **WHEN** Step 提示词含 `${projectName}` 且该透传变量已有值
- **THEN** 构建的提示词中 `${projectName}` 被替换为变量值；未定义的 `${unknown}` 保留原文
