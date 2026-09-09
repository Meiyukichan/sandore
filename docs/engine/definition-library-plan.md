# 工作流定义三级分离（Step 库 / Microflow 库 / Workflow 绑定）实施计划

> 状态：待实施（2026-08-29 定稿）｜范围：`D:\project-code\llm\sandore`（单包 dsh-sandore）

## 1. 目标与模型

```
Step 库（UI 名「Agent」）  —— 纯定义：command / outputTo / passThroughVars / timeout / rules / gates / defaultExpectation
Microflow 库（UI 名「微流程」）—— Step 引用（id）+ Step 级流程字段（inputFrom / branches）+ Stage 元数据
Workflow（definitions 表）  —— 自包含 YAML（与现状完全一致）
```

- **绑定 = 一次性导入展开（快照）**：从库拉详情嵌入工作流 yaml，展开后与现状格式**逐字节兼容**（解析/编排/执行/画布零改动）
- **流程字段只有上一层有**：Step 的 inputFrom/branches 在 Microflow yaml；Stage 的 branches 在 Workflow yaml
- **outputTo / passThroughVars 归 Step 定义**
- **同步语义（用户定稿）**：
  - **不识别来源**：yaml 无绑定标记；复制给别人再导入 = 普通定义，不判断新建/绑定
  - **自动入库仅一次**：新建的 stage/step 首次保存自动 upsert 库表；之后修改都是独立快照（不自动入库）
  - **【同步到库】按钮：新建与绑定模式都有**（用户主动点击才覆盖库）
- **元数据/合并原则参考现状**：rules 三级合并（`resolveStepRules`）、gates 三级合并（`mergeGates`）、timeout 等字段与现有 stage/step 设计一致

## 2. id 规范（三边一致）

| 实体 | id 格式 |
|---|---|
| Step 库条目 | `step-{uuid}`（同现状 step id） |
| Microflow 库条目 | `stg-{uuid}`（同现状 stage id） |
| Workflow | `wfl-{uuid}`（现状） |

三边 = 库表 key / workflow yaml 内 id / 运行时引用——同一字符串。**库中名称不可重复**（upsert 查重）。

## 3. YAML 形态与 zod schema

### 3.1 Step 库条目（纯定义）
```yaml
id: step-{uuid}
name: 构建
command: { type: shell, value: { command: "pnpm build" } }
outputTo: [{ id: "opt-{uuid}", path: "artifacts/**" }]
passThroughVars: [{ name: "artifactDir", value: "artifacts", description: "产物目录" }]
timeout: 30
defaultExpectation: "构建成功"
rules: ["禁止提交 node_modules"]
gates: { maxRetries: 1 }
```
- 字段 = `WorkflowStepSchema` 子集：`id/name/command/outputTo/passThroughVars/timeout/defaultExpectation/rules/gates`
- **不含** `inputFrom` 与 `branches`
- zod：`StepRecordSchema`（上述 + `version?` + `createdAt/updatedAt`），value 存 YAML 文本 + 元数据（同 WorkflowDefinitionRecord 模式）

### 3.2 Microflow 库条目（Step 引用 + Step 级流程字段）
```yaml
id: stg-{uuid}
name: 构建
rules: [...]
gates: {...}
defaultExpectation: "..."
steps:
  - id: step-{uuid}
    inputFrom: [{ id: "opt-{uuid}", path: "step-{uuid}" }]
    branches: [{ next: "step-{uuid}", label: "ok" }]
```
- 字段 = `WorkflowStageSchema` 的 `id/name/rules/gates/defaultExpectation/steps[]`；steps[] = 现有 `StageStepSchema`（id + branches）**扩展 `inputFrom?`**
- **不含** Stage 级 `branches`
- zod：`MicroflowRecordSchema`（上述 + `version?` + 时间戳）

### 3.3 绑定展开规则（库 → 工作流 yaml）
- Microflow 绑定：`stage = { id: stgId, name, rules?, gates?, defaultExpectation?, steps: [{id, branches}] }`；库 steps 的 `inputFrom` **合并进顶层 step 定义**
- Step 绑定：顶层 `steps[]` 补该 id 完整定义；`stage.steps` 加流控位
- 展开后序列化 = 现状 `WorkflowDefinition` 结构（deep-equal 兼容）

## 4. 存储层

### 4.1 sandoreDomainSpec（domain.ts）
现有 `definitions`/`state` 保留，新增两表：
```ts
steps: domainTable<string, StepRecord>(StepRecordSchema),        // key = step-{uuid}
microflows: domainTable<string, MicroflowRecord>(MicroflowRecordSchema),  // key = stg-{uuid}
```

### 4.2 persistence.ts
暴露 `steps`/`microflows` 句柄 + `upsertStep`/`upsertMicroflow` 便捷方法。

### 4.3 写库 / 同步 / 查重
- **自动入库（仅新建首次）**：createDefinition / updateYaml / importDefinitionFromYaml 解析成功后，内联 stages/steps upsert 库表（helper `writeDefinitionToLibraries(definition)`）——**注意**：每次保存都 upsert 会导致「后续修改也自动入库」，与「仅新建自动一次、后续独立快照」冲突——**实现**：upsert 仅在库中**无此 id** 时写入（`putIfAbsent`）；库中已有 → 跳过（除非显式同步）。即：新建首次 = 库无 id → 写入；之后修改 = 库已有 → 不动。**同步按钮 = 强制覆盖（upsert）**
- **同步按钮**：当前详情强制 upsert 覆盖库条目
- **名称查重**：upsert 时同 name 不同 id → 冲突错误（`DUPLICATE_NAME` + 已有条目 id）

## 5. RPC（remote.ts + wire.ts + typert 产物）

| RPC | 入参 | 返回 |
|---|---|---|
| `listSteps` | — | StepRecord[] 摘要（含被引用数） |
| `getStep` | `{ id }` | StepRecord |
| `upsertStep` | `{ yaml }` | StepRecord（查重；覆盖模式） |
| `deleteStep` | `{ id }` | `{ deleted }`（被引用 → `REFERENCED` + 引用方列表） |
| `listMicroflows` | — | MicroflowRecord[] 摘要（含被引用数） |
| `getMicroflow` | `{ id }` | MicroflowRecord |
| `upsertMicroflow` | `{ yaml }` | MicroflowRecord |
| `deleteMicroflow` | `{ id }` | `{ deleted }`（被引用 → 拒绝） |

**⚠️ 关键**：remote.ts 新 `@Remote` 方法后，**必须同步手写生成物** `packages/workflow/typert/typert.remote-client.js/.d.ts`（新增方法描述符/schema/TS 类型），client 侧 `ctx.remote.sandore` 才有新方法。引用检查：扫描 definitions 表全部记录（读 YAML 收集 stages/steps id）。

## 6. UI（packages/client）

### 6.1 左列表三分区（WorkflowOverlay）
分区标签：「工作流」「Microflow 库」「Agent 库」；库条目列表（名称 + 类型徽标 + 被引用数 + 时间）+ 打开（YAML 编辑弹窗）/ 删除（引用保护提示）。

### 6.2 库条目编辑弹窗
YAML 文本区（粘贴/编辑，复用导入弹窗 Modal+textarea 模式）+ 元数据（name/version）+ 保存（upsert，解析失败内联错误）。

### 6.3 详情面板三段式名称行（Stage/Step 共用——核心交互）
点击 Stage/Step 后右侧详情面板，名称行：
```
[绑定 ▾]  [名称输入框]  [同步到库]
```
- **左下拉「绑定/新建」**：新建 = 空白开始（`newId` 生成 id，名称可编辑）；绑定 = 打开库列表弹窗 → 选中 → 详情展开嵌入 → **名称只读**（库中名称不可重复）。切换需确认丢弃当前编辑
- **中间名称**：新建可编辑；绑定只读
- **右侧【同步到库】按钮：两个模式都有**（不识别来源——主动同步）：点击确认（「将覆盖库中的同名条目」）→ 当前详情 upsert 回库 → 成功提示
- 打开已有 stage/step（编辑已存在定义）：不识别来源，下拉默认「新建」，名称可编辑，同步按钮可点

### 6.4 新建 Stage / 新建 Step（画布「+ 添加」）
「+ 添加 Stage」→ 弹窗：新建空白 / 从库绑定（搜索选择）；Stage 内「+ 添加 Step」同理（新建选命令类型 / 从库绑定）。

### 6.5 详情面板现有 UI 修复（用户反馈）
1. **补标题与名称输入框**：Stage 详情顶部标题「**微流程详情**」、Step「**Agent 详情**」；名称输入框 = 6.3 三段式行
2. **中文输入（IME）无法输入**：排查详情/字段受控输入框的 composition 处理，确保中文可输入（DSH Input 支持则确认未绕过；自绘输入框补 onCompositionStart/End 守卫）
3. **prompt 提示词输入框改 textarea**：CommandEditor 中 prompt/agent/skill/mcp 类型提示词输入框从单行改多行 textarea（可大段输入）

### 6.6 face 扩展（workflow-face.ts + index.ts）
`listSteps/getStep/upsertStep/deleteStep/listMicroflows/getMicroflow/upsertMicroflow/deleteMicroflow`——接线 `unwrap(await sandore.xxx())`。

## 7. 兼容与迁移
- definitions 表零迁移（yaml 格式不变）；旧定义首次保存自动补写库表（putIfAbsent）；旧实例 state 不受影响；现有测试基线保持全绿

## 8. 实施阶段

| 阶段 | 内容 | 文件 |
|---|---|---|
| P0 模型 | StepRecordSchema / MicroflowRecordSchema；StageStepSchema 加 inputFrom? | schema.ts |
| P1 存储 | 两表 + 句柄 + putIfAbsent/upsert + writeDefinitionToLibraries + 名称查重 | domain.ts、persistence.ts、remote.ts |
| P2 RPC | wire schema + @Remote 方法 + **typert 产物同步** + 引用检查 | wire.ts、remote.ts、typert/* |
| P3 UI-库 | 三分区 + 库列表 + 库编辑弹窗 + face 接线 | WorkflowOverlay、新组件、workflow-face.ts、index.ts |
| P4 UI-编排 | 三段式名称行（绑定/新建/同步）+ 新建绑定弹窗 + 绑定展开 | DagEditor、DefinitionDetail、CommandEditor、dag-editor-model |
| P5 UI 修复 | 详情标题 + IME 中文输入 + prompt textarea | 上述 + css |
| P6 测试 | schema/存储/绑定展开/同步/引用保护/查重/UI + 全量回归 | 各 spec |

## 9. 验证链（必须全绿）
```bash
cd D:\project-code\llm\sandore
pnpm typecheck && pnpm vitest run && pnpm run build
```

## 10. 手工验证点（dev 3090）
1. 详情面板：点 Stage → 「微流程详情」+ 三段式名称行；点 Step → 「Agent 详情」
2. 新建模式名称可编辑；绑定模式名称只读；**同步按钮两种模式都有**
3. 绑定 Microflow/Agent → 画布出现 → 保存 → yaml 与现状格式一致
4. 新建 stage 首次保存 → 库分区出现；再修改保存 → 库条目不变；点同步 → 库更新
5. 中文输入正常；prompt 提示词 textarea 可大段输入
6. 库删除被引用条目 → 拒绝 + 引用方列表
