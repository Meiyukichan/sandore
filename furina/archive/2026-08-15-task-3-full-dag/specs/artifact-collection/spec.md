# Spec: artifact-collection — 产物收集与输入解析

## ADDED Requirements

### Requirement: glob→regex 转换
系统 SHALL 提供 `globToRegex(glob)`：`*` → `[^/]*`（单层通配）、`**` → `.*`（多层，自动跳过后续 `/`）、`?` → `[^/]`（单字符）、其他字符正则转义（`escapeRegexChar`）。

#### Scenario: 单层通配
- **WHEN** 转换 `artifacts/*.md`
- **THEN** 得到的 regex 匹配 `artifacts/report.md` 但不匹配 `artifacts/sub/report.md`

### Requirement: glob/regex 自动区分
系统 SHALL 自动区分 `outputTo[].path` 的模式类型：含 `*`/`?` 且无 regex 特征（如 `\d`、`(?`）→ glob；否则按字面路径（`regex` 字段存在时优先按 regex）。

#### Scenario: 识别 glob
- **WHEN** `outputTo.path = 'out/*.log'`
- **THEN** 按 glob 搜索文件

#### Scenario: 识别 regex 特征
- **WHEN** `outputTo.path` 含 `\\d+` 或 `outputTo.regex` 已配置
- **THEN** 按 regex 匹配文件路径

### Requirement: 文件搜索
系统 SHALL 提供 `findFilesByGlob(rootDir, pattern)` 与 `findFilesByRegex(rootDir, regex)`，经 `walkDir` 递归遍历目录，返回匹配文件的绝对路径数组。

#### Scenario: 递归搜索产物
- **WHEN** Step 完成后 `outputTo.path = 'build/**/report.md'` 且目录下存在 `build/a/report.md`
- **THEN** `findFilesByGlob` 返回含该文件绝对路径的数组

### Requirement: {uuid}_output.json 产物文件
系统 SHALL 在 Step 完成后收集产物并写入 `{stepMessageId}_output.json`：结构为 `{ sessionId, output: { returnPrompt, artifacts: [{id, value: string[]}] } }`（returnPrompt 为 AI 返回文本/shell stdout，artifacts 为各 outputTo 项匹配到的文件列表）。

#### Scenario: 写入产物文件
- **WHEN** agent Step 完成且 outputTo 匹配到 2 个文件
- **THEN** 工作目录生成 `{uuid}_output.json`，`artifacts[0].value` 为这 2 个文件路径，`returnPrompt` 为子代理最终输出文本

### Requirement: InputFrom 就近匹配
系统 SHALL 支持三种 `inputFrom.path`：`stg-xxx`（Stage 级：该 Stage 全部 Step 输出，倒序最近优先）、`stg-xxx.step-xxx`（Step 级：从当前 Step 往前搜索最近匹配，`idMatches` 支持后缀匹配 `actualId === targetId || actualId.startsWith(targetId + '-')`）、`stg-xxx.step-xxx.opt-xxx`（OutputTo 级：先定位 Step 再过滤特定 outputTo）。无 `inputFrom` 时 SHALL 回退使用前一个 Step（`currentFlatIdx - 1`）的输出。`regex` 模式 SHALL 遍历所有 Step/Stage 输出做正则匹配。

#### Scenario: Step 级就近匹配循环迭代
- **WHEN** 循环内 Step A（带后缀 id）完成两次迭代，当前 Step 的 `inputFrom.path = 'stg-1.step-a'`
- **THEN** 解析到最近一次迭代（后缀 id 匹配）的输出

#### Scenario: 无 inputFrom 回退
- **WHEN** Step 未配置 `inputFrom`
- **THEN** 自动使用前一个执行条目的输出作为输入

### Requirement: 透传变量替换工具
系统 SHALL 提供 `replacePassThroughVars(str, vars)`：将 `${xxx}` 替换为 vars 中对应值（含 `in-loop-turn`/`all-loop-turn` 特殊变量），未定义变量保留原文。

#### Scenario: 批量替换
- **WHEN** 字符串含 `${a}` 与 `${b}`，vars 定义 a、未定义 b
- **THEN** `${a}` 替换为值，`${b}` 保留原文
