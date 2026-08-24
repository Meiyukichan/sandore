# Sandore 收尾四阶段 Bug 修复计划（第三轮·全量合并）

> 日期：2026-08-17 | 状态：计划中 | 前序：bugfix-2026-08-17-4issues.md → bugfix-2026-08-17-3issues-round2.md

---

## 概览

本轮合并 round2 计划 A/B/C（已定位根因）+ 用户新提 D/E/F（本次新增设计），共 6 个问题：

| # | 问题 | 类型 | 风险 |
|---|------|------|------|
| A | Phase B 收尾 JSON 解析失败反复重试 | 已定位根因 | 低 |
| B | 中间阶段显示不及时 | 已定位根因 | 中 |
| C | fork 子代理历史读取失败 | 已定位根因 | 低 |
| D | sessionId 格式改为纯 UUID | 用户新要求 | 中 |
| E | finalizeMeta 字段重组 | 用户新要求 | 中 |
| F | phase 显示时序（UI 精确序列） | 用户新要求 | 中 |

---

## 问题 A：Phase B 收尾 JSON 解析失败反复重试

### 现象

模型返回合法 JSON（可能带前导说明文字或围栏），`parseFinalizeResult` 经 `parseJsonObject(raw) ?? parseJsonObject(stripJsonFence(raw))` 仍失败 → 重试 3 次超限，Step 落 failed。

### 根因

**文件**：`packages/sandore/microflow/src/finalize-manager.ts`

1. **`stripJsonFence` 正则锚定行首**（L222-225）：`[ \t]*``` ` 要求围栏行首只有空白，不认围栏前有说明文字（如 `好的，以下是结果：\n\n```json\n{...}\n``` `），匹配失败返回原始 `raw`。
2. **`FINALIZE_JSON_RETRY_HINT` 未要求围栏**（L423-424）：重试提示只说"请仅返回 JSON"，模型可能继续带文字。
3. **`buildPhaseBFinalizePrompt` 返回格式示例未要求围栏**（L412-413）：只展示裸 JSON 对象，未指示模型用围栏包裹。

### 修复方案

#### 改动 1：增强 `stripJsonFence`（finalize-manager.ts L222-225）

```typescript
// 改后：容忍围栏前任意文字，优先匹配 ```json 围栏，多个取第一个
function stripJsonFence(raw: string): string {
  const fenced = raw.match(/```[ \t]*json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/i);
  if (fenced?.[1] !== undefined) {
    return fenced[1].trim();
  }
  const generic = raw.match(/```\r?\n([\s\S]*?)\r?\n[ \t]*```/);
  if (generic?.[1] !== undefined) {
    return generic[1].trim();
  }
  return raw;
}
```

#### 改动 2：提示词明确要求围栏包裹（finalize-manager.ts L412-413 + L423-424 + L376-377）

- `buildPhaseBFinalizePrompt` 返回格式节改为：
  ```
  你必须用 ```json ``` 代码围栏包裹完整的 JSON 输出，围栏内只放 JSON。
  示例：
  ```json
  {"passThroughVars": {}, "compressedOutput": "..."}
  ```
  ```
- `FINALIZE_JSON_RETRY_HINT` 改为：
  ```
  未能从你的输出中解析出合法的收尾处理 JSON。请严格按以下格式返回（用 ```json ``` 代码围栏包裹，围栏内只放 JSON）：
  ```json
  {"passThroughVars": {}, "compressedOutput": "..."}
  ```
  ```
- `buildAssessPrompt`（Phase A）同步更新返回格式节。

#### 测试影响

- `finalize-manager.spec.ts`：新增 `stripJsonFence` 对「围栏前有文字」场景测试；更新 mock 输出为带围栏格式。
- `stage-executor.spec.ts`：Phase B fork 测试 `createFollowupHandler` 返回值适配围栏格式。

#### 风险

- **低**：`stripJsonFence` 只扩大识别范围，不影响已有合法输入。
- **中**：提示词增加围栏要求后模型行为变化——围栏增强兜底保证解析。

#### DSH 配合

无需 DSH 改动。

---

## 问题 B：中间阶段显示不及时

### 现象

`completeAfterFinalize` 中 `commitFinalize('routing')` → `resolveNextNodes`（纯代码极快）→ `commitFinalize('completed')` 几乎同步，UI 收到事件刷新时已 completed，中间阶段不可见。

### 根因

**文件**：`packages/sandore/microflow/src/stage-executor.ts` L1107-1150 + `packages/sandore/ui/src/client/step-phase.ts` + `packages/sandore/ui/src/client/UnifiedTimeline.tsx`

1. **`routing → completed` 时间间隔极短**（L1123 `commitFinalize('routing')` → L1125 `resolveNextNodes()` → L1139 `commitFinalize('completed')`）：纯代码路由无 AI 调用时，两阶段在同一次 event loop 内完成。
2. **UI `refresh()` 是异步 RPC**：两次 `sandore/step-phase` 事件几乎同时到达，第一个 `refresh()` 还在飞行中时 `completed` 已写入，两次都读到 `completed`。
3. **`previousPhase` 灰显已到位**（L591-608 `buildFinalizeMeta` + L228-234 `PhaseBadge` 渲染），但只保存上一阶段（`previousPhase` 会被后继阶段覆盖），且 CSS 可能不够醒目。

### 修复方案

#### 改动 1：`buildFinalizeMeta` 增加 `phaseHistory` 数组（finalize-manager.ts L591-608）

```typescript
// 改后：记录所有阶段到达历史（去重）
function buildFinalizeMeta(...): FinalizeMeta {
  const previousPhase = existing?.currentPhase;
  const history = [...(existing?.phaseHistory ?? [])];
  if (history.length === 0 || history[history.length - 1] !== currentPhase) {
    history.push(currentPhase);
  }
  return {
    currentPhase,
    ...(previousPhase !== undefined ? { previousPhase } : {}),
    ...(history.length > 0 ? { phaseHistory: history } : {}),
    ...（其余不变）
  };
}
```

#### 改动 2：`FinalizeMetaSchema` 增加 `phaseHistory`（schema.ts L311-324）

```typescript
phaseHistory: z.array(z.enum(['ask-detect', 'finalizing', 'gating', 'routing', 'completed'])).optional(),
```

#### 改动 3：UI `PhaseBadge` 渲染完整阶段链（UnifiedTimeline.tsx L207-253）

当 `phaseHistory` 存在时，渲染 badge 列表（如 `收尾中✓ → 门禁中✓ → 判断中✓ → 已完成`），而非仅显示当前 + 前一。每个已完成阶段用灰色对勾，当前阶段用可点击按钮。

#### 改动 4：`run-view-model.ts` 增加 `phaseHistory` 映射

```typescript
// TimelineStepItem 增加
readonly finalizePhaseHistory?: readonly string[] | undefined
```

`buildTimeline` 中映射 `step.finalizeMeta?.phaseHistory`。

#### 测试影响

- `finalize-manager.spec.ts`：新增 `buildFinalizeMeta` 的 `phaseHistory` 测试。
- `run-view-model.spec.ts`：新增 `phaseHistory` 映射测试。
- `workflow-engine.spec.ts`：收尾四阶段集成测试验证 `phaseHistory` 内容。

#### 风险

- **中**：`phaseHistory` 侵入 schema + UI 映射 + 事件链路，需全面回归测试。

#### DSH 配合

无需 DSH 改动。

---

## 问题 C：fork 子代理历史读取失败

### 现象

点击 PhaseBadge 打开 fork 子代理会话时，UI 报「历史加载失败：subagent disappeared during history read（subagent-not-found）」「会话记录损坏」。

### 根因

**文件 1**：`packages/sandore/microflow/src/fork-session.ts` L286-294（`forkStepSubagent` 的 `agents.create` 调用）

**文件 2**：`packages/sandore/microflow/src/finalize-manager.ts` L929-936（`evaluateSecondary` 的 `createAgent` 调用）

**文件 3**：`packages/sandore/microflow/src/branch-evaluator.ts` L485-492 / L600-606（Phase D `dispatchAi`/`runRoutingAi` 的 `forkStepSubagent` 调用）

**DSH 依赖**：`D:\project-code\llm\deepseek-harness\packages\api\remotes\src\agent-lookup.ts` L102-110

**机制**：

1. `forkStepSubagent`（L290）和 `evaluateSecondary`（L932）中 `meta.cwd` 是**条件写入**（`opts.cwd === undefined` 时不写入）。
2. DSH `inspectApiRemoteSession`（agent-lookup.ts L103）**强制要求 `cwd` 非 undefined**：`meta.cwd === undefined` 时抛 `ApiRemoteSessionNotFound`。
3. 当 `workdir` 为 `undefined`（单元测试裸配置 / 异常路径 / 旧快照恢复）时，fork 子代理会话持久化记录无 `cwd` → 历史读取失败。

### 修复方案

#### 改动 1：`forkStepSubagent` 强制写入 `cwd`（fork-session.ts L289-290）

```typescript
// 改前
meta: {
  ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
  ...

// 改后：cwd 必须写入（DSH inspectApiRemoteSession 强制要求），未传时回退 '/'
meta: {
  cwd: opts.cwd ?? '/',
  ...
```

#### 改动 2：`evaluateSecondary` 强制写入 `cwd`（finalize-manager.ts L931-932）

```typescript
// 改前
meta: {
  ...(input.workdir === undefined ? {} : { cwd: input.workdir }),
  ...

// 改后
meta: {
  cwd: input.workdir ?? '/',
  ...
```

#### 改动 3：确认 `branch-evaluator.ts` 的 `dispatchAi`/`runRoutingAi` 无需额外改动

这两个调用传入 `options.workdir` 给 `ForkStepSubagentOptions.cwd`，由 `forkStepSubagent` 内部的改动 1 兜底。

#### 测试影响

- `fork-session.spec.ts`：新增「`opts.cwd` 为 `undefined` 时 meta.cwd 回退 `/`」测试。
- `finalize-manager.spec.ts`：新增「secondary gate `workdir` 为 `undefined` 时 meta.cwd 回退 `/`」测试。
- `workflow-engine.spec.ts`：收尾真 fork 集成测试验证 fork 子代理持久化记录含 `cwd`。

#### 风险

- **低**：`cwd` 回退 `/` 只在异常路径生效，正常路径 `workdir` 一定有值。fork 子代理本身不执行文件操作（只做 AI 评估/判断），`cwd` 仅用于 DSH 会话归属校验。

#### DSH 配合

**不需要改 DSH**。sandore 侧 `cwd ?? '/'` 回退已规避 DSH 的 `cwd` 强制要求。

---

## 问题 D：sessionId 格式改为纯 UUID

### 现象

用户实测 state 中各类合成 id 带有前缀：
- `forkSessionId: "finalize-step-1846d923-...-3445cb1f"`
- `assessSessionId: "finalize-step-..."`
- `gateSessionId: "gate-step-...-9ecd88c9"`
- `branchMeta.sessionId: "finalize-step-...-0985dac9"`

用户要求：**全部用纯 UUID（`crypto.randomUUID()` 原生格式），与子代理 childId（UUID）保持一致，不要 `finalize-`/`gate-`/`eval-`/`step-` 前缀。**

### 根因

**文件与函数定位**：

| 合成函数 | 文件 | 行号 | 当前格式 | 示例 |
|----------|------|------|---------|------|
| `synthesizeFinalizeChildId` | fork-session.ts | L230-233 | `finalize-{stepId}-{8hex}` | `finalize-step-a-1846d923` |
| `synthesizeJudgeChildId` | fork-session.ts | L58-61 | `judge-{stepSessionId}-{8hex}` | `judge-child-123-abc45678` |
| `synthesizeGateChildId` | finalize-manager.ts | L313-316 | `gate-{stepId}-{8hex}` | `gate-step-a-9ecd88c9` |
| `newSessionHandle` | finalize-manager.ts | L307-310 | `eval-{8hex}` | `eval-11aa2ff0` |
| `synthesizeChildId` (recovery) | recovery-manager.ts | L101-104 | `step-{stepId}-{8hex}` | `step-step-a-abc12345` |
| `synthesizeChildId` (stage-executor) | stage-executor.ts | L160-163 | `step-{stepId}-{8hex}` | `step-step-a-abc12345` |

### 修复方案

#### 改动 1：`synthesizeFinalizeChildId` 改为纯 UUID（fork-session.ts L230-233）

```typescript
// 改前
function synthesizeFinalizeChildId(stepId: string): string {
  const execId = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return `finalize-${stepId}-${execId}`;
}

// 改后
function synthesizeFinalizeChildId(_stepId: string): string {
  return globalThis.crypto.randomUUID();
}
```

注：保留 `_stepId` 参数签名以减少调用方改动（调用方仍传 `opts.stepId`）。

#### 改动 2：`synthesizeJudgeChildId` 改为纯 UUID（fork-session.ts L58-61）

```typescript
// 改前
function synthesizeJudgeChildId(stepSessionId: string): string {
  const execId = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return `judge-${stepSessionId}-${execId}`;
}

// 改后
function synthesizeJudgeChildId(_stepSessionId: string): string {
  return globalThis.crypto.randomUUID();
}
```

#### 改动 3：`synthesizeGateChildId` 改为纯 UUID（finalize-manager.ts L313-316）

```typescript
// 改前
function synthesizeGateChildId(stepId: string): string {
  const random = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return `gate-${stepId}-${random}`;
}

// 改后
function synthesizeGateChildId(_stepId: string): string {
  return globalThis.crypto.randomUUID();
}
```

#### 改动 4：`newSessionHandle` 改为纯 UUID（finalize-manager.ts L307-310）

```typescript
// 改前
function newSessionHandle(): string {
  const random = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return `eval-${random}`;
}

// 改后
function newSessionHandle(): string {
  return globalThis.crypto.randomUUID();
}
```

#### 改动 5：`synthesizeChildId`（recovery-manager.ts L101-104）改为纯 UUID

```typescript
// 改前
export function synthesizeChildId(stepId: string): string {
  const execId = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return `step-${stepId}-${execId}`;
}

// 改后
export function synthesizeChildId(_stepId: string): string {
  return globalThis.crypto.randomUUID();
}
```

#### 改动 6：`synthesizeChildId`（stage-executor.ts L160-163）改为纯 UUID

```typescript
// 改前
function synthesizeChildId(stepId: string): string {
  const execId = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return `step-${stepId}-${execId}`;
}

// 改后
function synthesizeChildId(_stepId: string): string {
  return globalThis.crypto.randomUUID();
}
```

#### 测试影响

需同步更新所有断言 id 前缀/格式的测试：

| 文件 | 需更新的断言 | 改动 |
|------|------------|------|
| `recovery-manager.spec.ts` L379 | `expect(newChildId).toMatch(/^step-step-1-[0-9a-f]{8}$/)` | 改为 UUID 正则 `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/` |
| `recovery-manager.spec.ts` L603-604 | `synthesizeChildId('step-1')` 断言 `step-step-1-` 前缀 | 改为 UUID 正则 |
| `finalize-manager.spec.ts` L1346 | `assessSessionId` 匹配 `/^eval-/` | 改为 UUID 正则 |
| `finalize-manager.spec.ts` L1350 | `gateSessionId` 匹配 `/^eval-/` | 改为 UUID 正则 |
| `finalize-manager.spec.ts` L1567 | `assessSessionId` 匹配 `/^eval-/` | 改为 UUID 正则 |
| `finalize-manager.spec.ts` L1618 | `forkSessionId` 匹配 `/^eval-/` | 改为 UUID 正则 |
| `stage-executor.spec.ts` L888 | `assessSessionId` 匹配 `/^eval-/` | 改为 UUID 正则 |
| `stage-executor.spec.ts` L984 | `assessSessionId` 匹配 `/^finalize-step-a-[0-9a-f]{8}$/` | 改为 UUID 正则 |
| `stage-executor.spec.ts` L1038 | `assessSessionId` 匹配 `/^eval-/` | 改为 UUID 正则 |
| `workflow-engine.spec.ts` L4248 | `assessSessionId` 匹配 `/^finalize-step-p-[0-9a-f]{8}$/` | 改为 UUID 正则 |
| `workflow-engine.spec.ts` L4137 | `gateSessionId` 查 agents map | 需适配新格式 |
| `schema.spec.ts` L285, 290, 300 | 硬编码 `finalize-step-a-abc` / `eval-1` | 改为 UUID 格式字符串 |

**建议提取公共 UUID 正则常量**（测试工具）：
```typescript
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
```

#### 风险

- **中**：所有合成 id 格式统一为 UUID，与 childId（真实子代理 id）格式一致，语义更清晰。但失去前缀后，日志/debug 中难以一眼区分 id 类型——可通过 `finalizeMeta` 的 `assessSessionId`/`gateSessionId`/`routingSessionId` 字段名区分。
- **需用户拍板**：`synthesizeChildId`（recovery-manager / stage-executor）的 `step-{stepId}-{8hex}` 格式在日志中可读性好（一眼看出是哪个 step 的子代理）。改为纯 UUID 后可读性下降。用户明确要求统一纯 UUID，此处照做。

#### DSH 配合

无需 DSH 改动。DSH `agents.create` 的 `sessionId` 接受任意字符串，不限格式。

---

## 问题 E：finalizeMeta 字段重组

### 现象

用户发现 state 中各 phase 结果混杂：

1. **Phase A 结果误写入 `assessResult`**：`parallel1`（shell step）的 `assessResult` 含 `hasAsk:true` + `askQuestion` + `compressedOutput` + `forkSessionId:"eval-11aa2ff0"`——这是 Phase A 的结果，不该进 `assessResult`。
2. **Phase B 结果的 `assessResult` 含 `hasAsk`**：`sce1` 的 `assessResult` 含 `hasAsk:false` + `passThroughVars` + `compressedOutput` + `forkSessionId`——Phase B 不该有 `hasAsk`。
3. **Phase D 结果挂在顶层**：`branchMeta`/`loopMeta` 挂在 `executed` 顶层（`sce1.branchMeta`），未纳入 `finalizeMeta`。

用户要求：**各 phase 结果全部纳入 `finalizeMeta`，字段语义明确。**

### 根因

**文件**：`packages/sandore/workflow/src/schema.ts` L267-324 + `packages/sandore/microflow/src/finalize-manager.ts` L584-608 + `packages/sandore/microflow/src/stage-executor.ts`

#### 机制 1：Phase A 结果写入 `assessResult` 字段

`runPhaseA`（stage-executor.ts L996-1001）调用 `commitFinalize('ask-detect', assessResult, ...)`，`buildFinalizeMeta` 把 `assessResult` 写入 `finalizeMeta.assessResult`。但 Phase A 的结果含 `hasAsk`/`askQuestion`（ask 判定字段），这些是 Phase A 专属，不是 Phase B 的 `assessResult`。

#### 机制 2：Phase B `assessForked` 返回结构仍带 `hasAsk`

`assessForked`（finalize-manager.ts L754-760）返回 `{ hasAsk: false, ... }`——Phase B 不该有 `hasAsk`，但 `FinalizeAssessResultSchema` 强制要求 `hasAsk` 字段（L270：`hasAsk: z.boolean().default(false)`）。

#### 机制 3：Phase D 结果写在 executed 顶层

`completeAfterFinalize`（stage-executor.ts L1126-1131）把 `routed.branchMeta`/`routed.loopMeta` 写入 `executed.branchMeta`/`executed.loopMeta`，而非 `finalizeMeta`。

### 修复方案

#### 设计：新的 `FinalizeMeta` 字段结构

```typescript
// 重组后的 finalizeMeta
export const FinalizeMetaSchema = z.object({
  currentPhase: z.enum(['ask-detect', 'finalizing', 'gating', 'routing', 'completed']).optional(),
  previousPhase: z.enum(['ask-detect', 'finalizing', 'gating', 'routing', 'completed']).optional(),
  phaseHistory: z.array(z.enum(['ask-detect', 'finalizing', 'gating', 'routing', 'completed'])).optional(),

  // Phase A 结果（ask 判定）
  askResult: FinalizeAskResultSchema.optional(),

  // Phase B 结果（收尾：透传变量 + 输出压缩）
  assessResult: FinalizeAssessResultSchema.optional(),

  // Phase C 结果（门禁）
  gateResult: GateEvalResultSchema.optional(),

  // Phase D 结果（路由）
  routingResult: RoutingResultSchema.optional(),

  // 会话 id（各 phase fork 的子代理 id，供 UI 打开）
  assessSessionId: z.string().optional(),
  gateSessionId: z.string().optional(),
  routingSessionId: z.string().optional(),

  directory: z.string().optional(),
  errorDetail: z.string().optional(),
});
```

#### 新增 Schema：`FinalizeAskResultSchema`（Phase A 专用）

```typescript
export const FinalizeAskResultSchema = z.object({
  hasAsk: z.boolean(),
  askQuestion: AskUserQuestionPayloadSchema.optional(),
  /** Phase A 临时会话 id（不持久化会话本身，id 仅供日志/debug）。 */
  forkSessionId: z.string(),
  assessmentRaw: z.string(),
});
```

#### 修改 `FinalizeAssessResultSchema`（Phase B 专用，去掉 `hasAsk`）

```typescript
export const FinalizeAssessResultSchema = z.object({
  // 移除 hasAsk（Phase B 不做 ask 判定）
  // hasAsk: z.boolean().default(false),  ← 删除
  passThroughVars: z.record(z.string(), z.string()),
  compressedOutput: z.string().optional(),
  errorDetail: z.string().optional(),
  forkSessionId: z.string(),
  assessmentRaw: z.string(),
});
```

#### 新增 Schema：`RoutingResultSchema`（Phase D 专用）

```typescript
export const RoutingResultSchema = z.object({
  branchMeta: BranchMetaSchema.optional(),
  loopMeta: BranchMetaSchema.optional(),
  /** Phase D fork 子代理会话 id（供 UI 打开查看路由判断过程）。 */
  routingSessionId: z.string().optional(),
});
```

#### 改动清单

| 文件 | 改动 |
|------|------|
| `workflow/src/schema.ts` | 新增 `FinalizeAskResultSchema`、`RoutingResultSchema`；修改 `FinalizeAssessResultSchema`（去掉 `hasAsk`）；修改 `FinalizeMetaSchema`（新增 `askResult`、`routingResult`、`routingSessionId`、`phaseHistory`） |
| `microflow/src/finalize-manager.ts` | `buildFinalizeMeta` 根据 `currentPhase` 写入对应字段（`ask-detect` → `askResult`，`finalizing` → `assessResult`，`gating` → `gateResult`）；`assessForked` 返回结构去掉 `hasAsk` |
| `microflow/src/stage-executor.ts` | `runPhaseA` 的 `commitFinalize` 调用改传 `askResult`（新参数/新重载）；`completeAfterFinalize` 把 `branchMeta`/`loopMeta` 写入 `finalizeMeta.routingResult`（而非 `executed` 顶层）；`processRoutingNode` 的路由条目保持写入 `executed.branchMeta`（路由节点无 finalizeMeta，保持兼容） |
| `ui/src/client/run-view-model.ts` | `TimelineStepItem` 增加 `finalizeAskResult`、`finalizeRoutingResult` 映射 |
| `ui/src/client/UnifiedTimeline.tsx` | `PhaseBadge` 读取 `finalizeRoutingSessionId` 作为 Phase D 点击目标 |

#### `commitFinalize` 签名变更

```typescript
// 改后：新增 askResult 参数（替代 assessResult 在 ask-detect 阶段的用途）
async commitFinalize(
  request: FinalizeStepRequest,
  assessResult: FinalizeAssessResult | undefined,
  gateResult: GateEvalResult | undefined,
  currentPhase: NonNullable<FinalizeMeta['currentPhase']>,
  options?: { readonly recordAssessSession?: boolean; readonly askResult?: FinalizeAskResult; readonly routingResult?: RoutingResult },
): Promise<void>
```

#### `buildFinalizeMeta` 改动

```typescript
function buildFinalizeMeta(
  existing: FinalizeMeta | undefined,
  assessResult: FinalizeAssessResult | undefined,
  gateResult: GateEvalResult | undefined,
  currentPhase: NonNullable<FinalizeMeta['currentPhase']>,
  options?: { readonly recordAssessSession?: boolean; readonly askResult?: FinalizeAskResult; readonly routingResult?: RoutingResult },
): FinalizeMeta {
  const previousPhase = existing?.currentPhase;
  const history = [...(existing?.phaseHistory ?? [])];
  if (history.length === 0 || history[history.length - 1] !== currentPhase) {
    history.push(currentPhase);
  }
  return {
    currentPhase,
    ...(previousPhase !== undefined ? { previousPhase } : {}),
    ...(history.length > 0 ? { phaseHistory: history } : {}),
    // Phase A → askResult
    ...(options?.askResult === undefined ? {} : { askResult: options.askResult }),
    // Phase B → assessResult（不含 hasAsk）
    ...(assessResult === undefined ? {} : {
      assessResult,
      ...(options?.recordAssessSession === false ? {} : { assessSessionId: assessResult.forkSessionId }),
    }),
    // Phase C → gateResult
    ...(gateResult === undefined ? {} : { gateResult, gateSessionId: gateResult.gateSessionId }),
    // Phase D → routingResult
    ...(options?.routingResult === undefined ? {} : {
      routingResult: options.routingResult,
      ...(options.routingResult.routingSessionId !== undefined ? { routingSessionId: options.routingResult.routingSessionId } : {}),
    }),
  };
}
```

#### 测试影响

- `schema.spec.ts`：`FinalizeAssessResultSchema` 测试去掉 `hasAsk` 断言；新增 `FinalizeAskResultSchema`/`RoutingResultSchema` 测试。
- `finalize-manager.spec.ts`：`commitFinalize` 测试适配新签名；`assessResult` 不再含 `hasAsk`；Phase A 结果改写入 `askResult`。
- `stage-executor.spec.ts`：Phase A ask 中断测试断言 `askResult` 而非 `assessResult`。
- `workflow-engine.spec.ts`：收尾集成测试适配新字段名。
- `run-view-model.spec.ts`：新增 `finalizeAskResult`/`finalizeRoutingResult` 映射测试。

#### 风险

- **中**：schema 变更是破坏性变更（旧持久化快照的 `assessResult` 含 `hasAsk`，新 schema 去掉后校验失败）。**需向后兼容**：`FinalizeAssessResultSchema` 保留 `hasAsk: z.boolean().default(false).optional()` 但不写入新数据。
- **需用户拍板**：`branchMeta` 从 `executed` 顶层移入 `finalizeMeta.routingResult` 后，路由节点（无 `finalizeMeta`）仍保持写入 `executed.branchMeta`（`processRoutingNode` 不变），只有命令节点的 Phase D 路由结果写入 `finalizeMeta.routingResult`。两者共存是否可接受？

#### DSH 配合

无需 DSH 改动。所有 schema 变更在 sandore 侧完成。

---

## 问题 F：phase 显示时序（UI 精确序列）

### 现象

用户要求精确的阶段显示序列：
- Phase A：**不显示**（临时的）
- Phase B：显示「**收尾中**」→ 点击进入子代理（`assessSessionId`）
- Phase B 完成：显示「**已收尾**」
- Phase C：显示「**门禁中**」→ 点击进入子代理（`gateSessionId`）
- Phase D：显示「**分支判断中/循环跳出判断中**」→ 点击进入子代理（`routingSessionId`）
- 全部完成：显示「**已完成**」（不是「已收尾」）

### 根因

**文件**：`packages/sandore/ui/src/client/UnifiedTimeline.tsx` L38-53（`finalizePhaseKey`）+ L207-253（`PhaseBadge`）

#### 机制 1：当前 `finalizePhaseKey` 映射

```typescript
case 'completed': return 'run.step.finalize.phase.done'  // 「已收尾」
```

用户要求 `completed` 显示「**已完成**」，而「**已收尾**」= Phase B 完成态（`finalizing` 终结）。

#### 机制 2：Phase A 不显示

当前 `ask-detect` 映射为 `run.step.finalize.phase.askDetect`，用户要求不显示。

#### 机制 3：Phase D 点击目标

当前 Phase D（routing）点击打开 Step 本身子代理会话（`item.childId`），用户要求打开 Phase D 的 fork 子代理会话（需持久化 `routingSessionId`）。

### 修复方案

#### 改动 1：修改 `finalizePhaseKey` 映射（UnifiedTimeline.tsx L38-53）

```typescript
function finalizePhaseKey(phase: string | undefined): SandoreKey | undefined {
  switch (phase) {
    case 'ask-detect':
      return undefined  // Phase A 不显示
    case 'finalizing':
      return 'run.step.finalize.phase.finalizing'  // 「收尾中」
    case 'gating':
      return 'run.step.finalize.phase.gating'  // 「门禁中」
    case 'routing':
      return 'run.step.finalize.phase.routing'  // 「分支判断中」
    case 'completed':
      return 'run.step.finalize.phase.completed'  // 「已完成」（新 key）
    default:
      return undefined
  }
}
```

#### 改动 2：新增/修改本地化 key

| key | 文案 | 说明 |
|-----|------|------|
| `run.step.finalize.phase.finalizing` | `收尾中` | Phase B 进行中 |
| `run.step.finalize.phase.done` | `已收尾` | Phase B 完成态（保留，用于 `phaseHistory` 中已完成的 Phase B） |
| `run.step.finalize.phase.gating` | `门禁中` | Phase C 进行中 |
| `run.step.finalize.phase.routing` | `判断中` | Phase D 进行中 |
| `run.step.finalize.phase.completed` | `已完成` | 全部完成（新 key，区别于「已收尾」） |

#### 改动 3：`PhaseBadge` 渲染完整阶段链（配合问题 B 的 `phaseHistory`）

当 `phaseHistory` 存在时，渲染 badge 列表：
```
[收尾中✓] → [门禁中✓] → [判断中✓] → [已完成]
```

- 已完成阶段：灰色对勾 + 阶段名（不可点击）
- 当前阶段：可点击按钮（打开对应 `assessSessionId`/`gateSessionId`/`routingSessionId`）
- Phase A（`ask-detect`）：跳过不渲染

#### 改动 4：Phase D 点击目标改为 `routingSessionId`

```typescript
// 改前（L222-225）
const routingTarget = item.finalizePhase === 'routing' && item.childId !== undefined
  ? item.childId
  : undefined

// 改后：Phase D 点击打开 routing fork 子代理会话
const routingTarget = item.finalizePhase === 'routing' && item.finalizeRoutingSessionId !== undefined
  ? item.finalizeRoutingSessionId
  : undefined
```

#### 改动 5：`run-view-model.ts` 增加 `finalizeRoutingSessionId` 映射

```typescript
// TimelineStepItem 增加
readonly finalizeRoutingSessionId?: string | undefined

// buildTimeline 中映射
finalizeRoutingSessionId: step.finalizeMeta?.routingSessionId,
```

#### 改动 6：Phase D routing fork 子代理持久化 session id

当前 Phase D 的 `resolveNextNodes` 内部调用 `dispatchAi`/`runRoutingAi`（branch-evaluator.ts），fork 子代理的 `sessionHandle` 已返回（`handle.agent.id`），但未持久化到 `finalizeMeta`。

需要在 `completeAfterFinalize`（stage-executor.ts L1125）中，从 `resolveNextNodes` 的返回值中提取 routing fork 子代理 id，写入 `finalizeMeta.routingResult.routingSessionId`。

检查 `resolveNextNodes` 返回类型（`ResolveNextNodesResult`）：

```typescript
// step-navigator.ts 的 resolveNextNodes 返回
interface ResolveNextNodesResult {
  nextNodeIds: string[];
  branchMeta?: BranchMeta;
  loopMeta?: BranchMeta;
}
```

`BranchMeta` 已有 `sessionId` 字段（schema.ts L329），所以 `routed.branchMeta?.sessionId` 即 Phase D fork 子代理 id。

**改动**：`completeAfterFinalize` 中提取 `routed.branchMeta?.sessionId` 写入 `finalizeMeta.routingResult.routingSessionId`。

```typescript
// completeAfterFinalize 改动
const routingResult = routed.branchMeta !== undefined || routed.loopMeta !== undefined
  ? {
      branchMeta: routed.branchMeta,
      loopMeta: routed.loopMeta,
      routingSessionId: routed.branchMeta?.sessionId ?? routed.loopMeta?.sessionId,
    }
  : undefined;
if (hasFinalize) {
  await this.options.finalizeManager.commitFinalize(
    buildRequest(), phaseBResult, gateResult, 'completed',
    { routingResult },
  );
}
```

#### 改动 7：`executed.branchMeta`/`executed.loopMeta` 保持兼容

命令节点的 Phase D 路由结果仍写入 `executed.branchMeta`/`executed.loopMeta`（保持兼容），同时写入 `finalizeMeta.routingResult`（新增）。路由节点（`processRoutingNode`）保持写入 `executed.branchMeta`（无 `finalizeMeta`）。

#### 测试影响

- `run-view-model.spec.ts`：新增 `finalizeRoutingSessionId` 映射测试。
- `UnifiedTimeline` 相关测试（如有）：适配新 `finalizePhaseKey` 映射。
- `stage-executor.spec.ts`：`completeAfterFinalize` 测试验证 `routingResult` 写入。
- 本地化 key 测试（如有）：新增 `run.step.finalize.phase.completed` key。

#### 风险

- **低**：`finalizePhaseKey` 映射改动只影响 UI 展示文案。
- **中**：`phaseHistory` badge 列表需要 CSS 样式支持（badge 容器布局、overflow 处理）。
- **需用户拍板**：「已收尾」= Phase B 完成态 vs 「已完成」= 全部完成态——这两个文案是否需要在 badge 中同时出现？（当 `phaseHistory` 渲染 badge 列表时，已完成的 Phase B 显示「已收尾✓」，最终态显示「已完成」。）

#### DSH 配合

无需 DSH 改动。

---

## Schema 变更清单

| Schema | 变更 |
|--------|------|
| `FinalizeMetaSchema` | 新增 `phaseHistory`、`askResult`、`routingResult`、`routingSessionId`；保留 `assessResult`/`gateResult`/`assessSessionId`/`gateSessionId` |
| `FinalizeAssessResultSchema` | `hasAsk` 改为 `z.boolean().default(false).optional()`（向后兼容：旧数据保留，新数据不写） |
| 新增 `FinalizeAskResultSchema` | `hasAsk` + `askQuestion` + `forkSessionId` + `assessmentRaw` |
| 新增 `RoutingResultSchema` | `branchMeta?` + `loopMeta?` + `routingSessionId?` |

## UI 变更清单

| 文件 | 变更 |
|------|------|
| `UnifiedTimeline.tsx` | `finalizePhaseKey`：`ask-detect` → 不显示；`completed` → 新 key「已完成」。`PhaseBadge`：渲染 `phaseHistory` badge 列表。Phase D 点击目标改为 `finalizeRoutingSessionId` |
| `run-view-model.ts` | `TimelineStepItem` 增加 `finalizeAskResult`、`finalizeRoutingResult`、`finalizeRoutingSessionId`、`finalizePhaseHistory`。`buildTimeline` 映射新字段 |
| `step-phase.ts` | 无需改动（事件通道保持原样） |
| 本地化文件 | 新增 `run.step.finalize.phase.completed`（「已完成」）；保留 `run.step.finalize.phase.done`（「已收尾」用于 badge 列表中已完成的 Phase B） |

---

## 需要 DSH 配合的改动

**本次无需要 DSH 配合的改动**。所有修复均在 sandore 侧完成：

- 问题 A/B/D/E/F：纯 sandore 代码改动
- 问题 C：sandore 侧 `cwd ?? '/'` 回退已规避 DSH 的 `inspectApiRemoteSession` 强制 `cwd` 要求

---

## 需要用户拍板的决策点

1. **问题 D**：`synthesizeChildId`（recovery-manager / stage-executor）的 `step-{stepId}-{8hex}` 格式改为纯 UUID 后，日志可读性下降。用户已明确要求统一纯 UUID，此处照做——确认？

2. **问题 E**：`branchMeta` 从 `executed` 顶层移入 `finalizeMeta.routingResult` 后，路由节点（`processRoutingNode`）仍保持写入 `executed.branchMeta`（无 `finalizeMeta`），只有命令节点的 Phase D 路由结果写入 `finalizeMeta.routingResult`。两者共存是否可接受？

3. **问题 E**：`FinalizeAssessResultSchema` 去掉 `hasAsk` 后，旧持久化快照的 `assessResult` 含 `hasAsk`——需要向后兼容（`hasAsk: z.boolean().default(false).optional()`），还是直接不兼容（旧快照需迁移）？

4. **问题 F**：「已收尾」= Phase B 完成态 vs 「已完成」= 全部完成态——在 `phaseHistory` badge 列表中，已完成的 Phase B 显示「已收尾✓」，最终态显示「已完成」。这两个文案是否需要同时出现在 badge 列表中？

---

## 计划文档路径

`D:\project-code\llm\sandore\docs\bugfix\bugfix-2026-08-17-round3-all.md`
