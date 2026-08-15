# Spec: branch-evaluation — 分支条件两阶段评估

## ADDED Requirements

### Requirement: BranchEvaluator 两阶段执行
系统 SHALL 以两阶段模式评估分支条件：`start(condition, contextMessage)` 启动评估（agent/prompt/skill/mcp 类型经 `ctx.llm.stream()` 临时会话发出提示词；shell 类型经 `ctx.shell.run()` 或 `ctx.subprocess.spawn()` 执行命令）；`collect(partial)` 收集结果（AI 会话聚合输出文本，shell 直接返回 stdout）。便捷方法 `evaluate()` SHALL 一步完成两阶段。

#### Scenario: AI 分支评估
- **WHEN** 分支节点 condition 为 agent/prompt/skill/mcp 类型
- **THEN** start 阶段创建临时会话并发送含分支列表与返回格式要求（JSON `{"branchExpectation": "..."}`）的评估提示词，collect 阶段聚合流式输出为文本，`sessionHandle` 为该临时会话标识

#### Scenario: shell 分支评估
- **WHEN** 分支节点 condition 为 shell 类型
- **THEN** shell 命令直接执行（`sessionHandle = null`），stdout 作为评估输出，无 AI 会话创建

### Requirement: shell 分支评估三注入
系统 SHALL 对 shell 类型分支条件依次执行：透传变量替换（`${xxx}` → `passThroughVars` 值）、环境变量注入（非空透传变量 + `in-loop-turn`/`all-loop-turn` 作为 env）、stdin 注入（当前 Step 的 output 内容 JSON 写入子进程 stdin，经 `ctx.subprocess.spawn()`）；简单命令（无注入需求）SHALL 走 `ctx.shell.run()`。

#### Scenario: 含透传变量的 shell 条件
- **WHEN** shell 分支条件命令含 `${env_name}` 且该透传变量有值
- **THEN** 命令先做变量替换，非空变量注入子进程环境，执行结果 stdout 用于 `extractExpectation`

### Requirement: extractExpectation 三级解析
系统 SHALL 按三级解析 `extractExpectation(raw)`：① JSON 解析取 `branchExpectation` 字段；② regex 回退 `/"branchExpectation"\s*:\s*"([^"]+)"/`；③ 原始输出 `raw.trim()`。

#### Scenario: 标准 JSON 输出
- **WHEN** AI 评估输出为 `{"branchExpectation": "lint-clean"}`
- **THEN** 提取结果为 `lint-clean`

#### Scenario: 输出夹带非 JSON 文本
- **WHEN** AI 输出为 `结果如下：\n{"branchExpectation": "build-ok"}\n请查收`
- **THEN** JSON 直接解析失败时经 regex 提取 `build-ok`

### Requirement: extractBreakResult 解析（public）
系统 SHALL 提供 public 的 `extractBreakResult(raw)`：① JSON 解析取 `shouldBreak`；② regex 回退 `/"shouldBreak"\s*:\s*(true|false)/i`（匹配后转小写）；③ `raw.trim()`。供 LoopManager `checkLoopBreak` 复用。

#### Scenario: shouldBreak 为 true
- **WHEN** 评估输出含 `"shouldBreak": true`
- **THEN** 提取结果为字符串 `'true'`

### Requirement: matchesExpectation 分支匹配
系统 SHALL 以 `matchesExpectation(result, expectation)` 判定分支匹配：`expectation` 为 regex 特征时做正则匹配，否则字符串相等比较。

#### Scenario: 字符串相等匹配
- **WHEN** 评估结果 `lint-clean` 与分支 `expectation: 'lint-clean'`
- **THEN** 匹配成功，路由到该分支的 `next`

### Requirement: 分支评估提示词结构
系统 SHALL 构建结构化分支评估提示词，包含：用户配置的分支提示词、前置 Step 输入/输出上下文、分支列表（名称 + expectation）、返回格式要求（JSON `{"branchExpectation": "..."}`）、红线规则（禁止编辑/创建/删除文件、禁止过度思考）。

#### Scenario: 提示词含分支列表
- **WHEN** 分支节点配置了两个带 expectation 的分支
- **THEN** 评估提示词列出两个分支的 label 与 expectation，并要求以 JSON `branchExpectation` 格式返回
