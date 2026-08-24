# Round 20：分支批量模板 + shell 跳过 Phase A/B + fork 会话按钮容错

> **日期**：2026-08-17
> **来源**：用户提供的修复计划（已确认执行）
> **状态**：已核验，等待实施

---

## 问题 1（❌ 高）：分支判断改为 docs/prompts/branch.md 批量模板

### 根因

当前逐条评估：每个条件分支单独 fork → AI 返回 `{"shouldExecute": true/false}`。

`buildBranchPrompt`（`branch-evaluator.ts:150-173`）：
- L160-163 只列 `- {label}`，**不带 branchId**
- L166 返回格式要求布尔值 `{"shouldExecute": true}`
- branch.md 模板要求 `branchId + executeCondition` 成对列出，返回 `{"shouldExecute": ["branchId1", "branchId2"]}` 数组

**隐藏 bug**：`step-navigator.ts:145-149` 的 `branchMeta` 在 for 循环里被覆盖——多条件分支只保留最后一条。

### 核验发现（主代理交叉核验 2026-08-17）

- `buildBranchPrompt` 有两个使用点：`evaluateCondition`（L447，逐条 AI 评估）与 `startAi`（L550，两阶段接口 `start()/evaluate()` 的 AI 分支——生产代码中仅 shell 走 `evaluate()`，AI 两阶段路径实际为死路径，但 spec（L336）仍覆盖）。**决策：保留 `buildBranchPrompt`/`startAi`/`start`/`evaluate` 不动（最小破坏），新增 `buildBatchBranchPrompt` 供批量路径使用。**
- `evaluateCondition`（L435-458）：shell 走 `evaluate()`（matchesExpectation），AI 走 `runRoutingAi`（fork 子代理 + followup 重试 + dispose）。`runRoutingAi`（L474-542）是通用 private 方法，批量路径直接复用（换 prompt + spec）。
- `decideCondition`（step-navigator.ts:242-252）只被 L150 调用；批量后 AI 判定移入 `evaluateConditions`（按 passedBranchIds 路由），`decideCondition` 删除，step-navigator 的 `extractShouldExecute`/`matchesExpectation` import 一并移除。
- `stripJsonFence` 存在于 `finalize-manager.ts:228`（未导出）——`extractShouldExecuteBatch` 需本地实现一份（或等效的 fence 剥离逻辑）。
- `evaluateConditions` 的 `result` 约定：AI 分支存在时取 AI 批量评估结果（output = AI JSON 文本，sessionHandle = fork id）；纯 shell 时取最后一条 shell 结果（output = stdout，sessionHandle = null）。
- `BranchEvalResult` 类型不变（`{ output, sessionHandle }`）。
- `branchMeta` 写入（step-navigator.ts:145-149）：`{ status: 'completed', result: result.output, ...(result.sessionHandle === null ? {} : { sessionId: result.sessionHandle }) }`，批量后只写一次（循环外）。

### 修复

#### A. 新增 `buildBatchBranchPrompt`（`branch-evaluator.ts`，对齐 docs/prompts/branch.md）

```ts
function buildBatchBranchPrompt(branches: readonly DagBranch[]): string {
  const sections: string[] = [
    '你是严谨准确的DAG分支评估Agent，你的任务是根据`分支执行条件`与上下文，判断哪些分支满足其执行条件。',
    '',
    '## 分支执行条件',
    '```json',
    JSON.stringify(
      branches.map(b => ({
        branchId: b.next,
        executeCondition: b.condition?.value?.promptText ?? b.label ?? b.next,
      })),
      null,
      4,
    ),
    '```',
    '',
    '## 返回格式',
    '请仅返回 JSON，格式如下：',
    '```json',
    '{"shouldExecute": ["branchId1", "branchId2"]}',
    '```',
    '',
    '其中，`shouldExecute` 为满足其 `executeCondition` 条件的分支的 `branchId` 列表。',
    '',
    '## 红线规则',
    '- 禁止编辑、创建或删除任何文件',
  ]
  return sections.join('\n')
}
```

**注意**：`DagBranch`（`schema.ts:115-120`）只有 `next/label/condition/loop`，没有独立 `branchId`。用 `branch.next` 作为 AI 返回的标识（唯一且与路由目标一致）。

#### B. 新增 `extractShouldExecuteBatch`（`branch-evaluator.ts`）

```ts
// 解析 {"shouldExecute": ["id1", "id2"]} 数组
export function extractShouldExecuteBatch(raw: string): readonly string[] | undefined {
  // ① JSON.parse 取 shouldExecute 数组
  // ② 失败 stripJsonFence 后再 parse
  // ③ regex 回退 /"shouldExecute"\s*:\s*\[([^\]]*)\]/i
  // 返回 branchId 数组，undefined 表示解析失败
}
```

#### C. `evaluateCondition` → `evaluateConditions`（`branch-evaluator.ts`）

```ts
// 批量评估方法（替换 evaluateCondition）
async evaluateConditions(
  branches: readonly { branch: DagBranch; condition: CommandConfig }[],
  options: BranchEvalOptions = {},
): Promise<{ result: BranchEvalResult; passedBranchIds: readonly string[] }> {
  // 1. shell 条件逐条执行（每条命令不同，不能批量）→ matchesExpectation(output.trim(), branch.label) 判定
  // 2. AI 条件批量评估：一次 fork（第一个 AI condition 的 route），发送 buildBatchBranchPrompt(aiBranches)
  //    → runRoutingAi 复用（isSatisfied = extractShouldExecuteBatch(output) !== undefined；
  //    新批量 correctionHint；maxRetries = MAX_BRANCH_EVAL_RETRIES）
  // 3. AI 返回 {"shouldExecute": ["id1", "id2"]} → passedBranchIds = 解析结果 ?? []
  // 4. 合并 shell（通过 push branch.next）+ AI（push 解析出的 id）结果
  // 5. result：AI 存在时取 AI 批量结果，否则最后一条 shell 结果
}
```

#### D. `step-navigator.ts:142-154` 改调用

```ts
// 一次批量调，修复 branchMeta 覆盖 bug
if (conditional.length > 0) {
  const { result, passedBranchIds } = await this.evaluator.evaluateConditions(
    conditional.map(b => ({ branch: b, condition: b.condition! })),
    this.branchEvalOptions(node, context),
  )
  branchMeta = {
    status: 'completed',
    result: result.output,
    ...(result.sessionHandle === null ? {} : { sessionId: result.sessionHandle }),
  }
  for (const nextId of passedBranchIds) {
    if (this.sameStageStep(node, nextId) !== undefined) nextNodeIds.push(nextId)
  }
}
```

### 不碰的

- 循环跳出（`evaluateBreak` + `shouldBreak`）不变
- shell 条件逐条执行逻辑不变（每条命令不同）
- 并行分支（parallel）不变
- `BranchEvalResult` 类型不变（`{ output, sessionHandle }`）
- `buildBranchPrompt`/`startAi`/`start`/`evaluate`/`extractShouldExecute` 保留（spec 依赖）

---

## 问题 2+3（❌ 高）：shell 步骤不展示结果 + 跳过 Phase A/B

### 根因

**完整降级链路**：

1. shell 执行 → `step-runner.ts:426-428` 返回 `{ output: [{type:'text', text: stdout}] }`，无 sessionMeta
2. shell 的 `sessionMeta = { childId: 合成UUID, synthetic: true, command: 'shell' }`（`stage-executor.ts:775`）
3. Phase B `assessForked` → `forkStepSubagent`（`fork-session.ts:263-268`）→ shell 合成会话**无 events** → fork 返回 undefined
4. `finalize-manager.ts:769-774` → `degradeFinalize` → `compressedOutput: ''`（空串）
5. UI `UnifiedTimeline.tsx` completed 分支检查 `compressedOutput !== undefined` → **空串通过**（空串 ≠ undefined）→ 渲染空白
6. **shell 的命令输出 `outputText`（如 "miku"）被完全隐藏**

### 核验发现（主代理交叉核验 2026-08-17）

- `degradeFinalize`（finalize-manager.ts:818-836）确实设置 `errorDetail: reason`（降级原因），故 UI 可用 `finalizeMeta.assessResult.errorDetail` 检测降级。
- `stage-executor.ts:1376` 已有 `const commandType = step.command?.type;` 模式，shell 判定用 `step.command?.type === 'shell'`。
- `run-view-model.ts` 映射（L503-553）：新增 `commandType: step.sessionMeta?.command`（L553 附近）与 `finalizeAssessErrorDetail: step.finalizeMeta?.assessResult?.errorDetail`（L508 附近）。
- UI 现有 completed 分支（UnifiedTimeline.tsx L357-373）用 `assessStatus`/`compressedOutput` 判断；计划 C 改为 `commandType` + `finalizeAssessErrorDetail` 判断。**注意：计划代码中的 `MessageText` 应为 `MarkdownText`（现有代码导入的是 MarkdownText，L362 等）。**

### 修复

#### A. shell 跳过 Phase A（`stage-executor.ts` finishCommandNode，L904）

```ts
const isShellStep = step.command?.type === 'shell'
if (!isShellStep) {
  // Phase A：fork → assess（ask 判断），仅非 shell 步骤
  const phaseA = await this.runPhaseA(nodeId, step, executed, context, gates, state)
  if (phaseA.kind === 'ask') return 'ask'
}
// shell 直接进 Phase B/C
```

#### B. shell 跳过 Phase B 的 assess（`stage-executor.ts` runPhaseB，L1062）

```ts
const isShellStep = step.command?.type === 'shell'
// shell 或（无未解析透传变量且无门禁）→ 跳过 assess
if (isShellStep || (!hasUnresolvedPassThroughVars(step) && !hasEnabledGates(gates))) {
  return undefined
}
```

#### C. UI completed 时 shell 显示 output（`UnifiedTimeline.tsx`）

```tsx
{item.status === 'completed' && (
  // shell 步骤：直接显示命令输出
  item.commandType === 'shell' && item.outputText !== undefined
    ? <div className={css.md}><MarkdownText text={item.outputText} /></div>
    // 非 shell：优先 compressedOutput，降级（有 errorDetail）时回退 output
    : item.commandType !== 'shell' && (
      item.finalizeAssessErrorDetail === undefined
        && item.finalizeAssessResult?.compressedOutput !== undefined
        ? <div className={css.md}><MarkdownText text={item.finalizeAssessResult.compressedOutput} /></div>
        : item.outputText !== undefined
          ? <div className={css.md}><MarkdownText text={item.outputText} /></div>
          : null
    )
)}
```

#### D. `TimelineStepItem` 补字段（`run-view-model.ts`）

```ts
commandType?: string  // step.sessionMeta?.command（'shell'/'prompt'/'agent'/'skill'/'mcp'）
finalizeAssessErrorDetail?: string  // step.finalizeMeta?.assessResult?.errorDetail（降级检测用）
```

### 不碰的

- Phase C 门禁对 shell 不跳过（primary 产物校验对 shell 有效）
- shell 的 passThroughVars refresh 提取（另行设计）
- 非 shell 步骤的 Phase A/B/C 完全不碰

---

## 问题 4（❌ 高）：点击"收尾中"/"门禁中"按钮报 unknown session

### 根因

**完整链路**：

1. Phase B 评估完 `await handle.dispose()`（`finalize-manager.ts:805`）→ fork 会话 live store 移除
2. Phase C 评估完 `await handle.dispose()`（`finalize-manager.ts:986`）→ live 移除
3. 但 `forkSessionId`/`gateSessionId` 仍持久化在 state（schema 必填，`schema.ts:280,313`）
4. `PhaseBadge`（`UnifiedTimeline.tsx:211-301`）**不检查 `item.status === 'completed'`** → completed 后仍渲染可点击按钮
5. 点击 → `openSession(已dispose的id)` → `sessions.select` → **unknown session** 报错
6. `index.ts:101` 的 `openSession` **无 try/catch**

### 核验发现（主代理交叉核验 2026-08-17）

- `index.ts` 有两处 `openSession`：L101（overlay 版，`closeWorkflowOverlay()` 后 open）与 L157（`(id: SessionId) => remoteCtx.sessions.open(id)`），两处都加 try/catch。
- PhaseBadge 的 target 守卫为 `target !== undefined && target !== ''`（UnifiedTimeline.tsx L281）；completed 后将 target 置 undefined 即走纯文本 `<span>` 分支（不可点击）。

### 修复

#### A. UI 侧：completed 后 badge 降级为不可点击（`UnifiedTimeline.tsx` PhaseBadge）

```tsx
const isCompleted = item.status === 'completed'  // fork 会话已 dispose

// Phase B badge：target: isCompleted ? undefined : item.finalizeAssessSessionId
// Phase C badge：target: isCompleted ? undefined : item.finalizeGateSessionId
// Phase D badge：target: isCompleted ? undefined : item.finalizeRoutingSessionId
```

#### B. `openSession` 加容错（`index.ts:101,157`）

```ts
openSession: (id: string) => {
  closeWorkflowOverlay()
  try {
    remoteCtx.sessions.open(id as SessionId)
  } catch (error) {
    console.error('ui-sandore: openSession failed (session may be disposed)', error)
  }
},
```

### 不碰的

- fork 会话的 dispose 时机不碰（改了会泄漏）
- schema 的 `forkSessionId`/`gateSessionId` 必填约束不碰（审计价值）
- running 态的 badge 可点击性不碰（此时会话未 dispose）

---

## 改动文件总览

| 文件 | 问题 | 改动 |
|---|---|---|
| `microflow/src/branch-evaluator.ts` | 1 | 新增 `buildBatchBranchPrompt` + `extractShouldExecuteBatch` + `evaluateConditions`（替换 `evaluateCondition`） |
| `microflow/src/step-navigator.ts` | 1 | L142-154 批量调用；删除 `decideCondition` 与多余 import |
| `microflow/src/branch-evaluator.spec.ts` | 1 | 测试适配批量格式（evaluateCondition 测试改 evaluateConditions；新增 extractShouldExecuteBatch/buildBatchBranchPrompt 测试） |
| `microflow/src/step-navigator.spec.ts` | 1 | 多条件分支 branchMeta 不覆盖测试（如有） |
| `microflow/src/stage-executor.ts` | 2+3 | shell 跳过 Phase A（finishCommandNode）+ Phase B assess（runPhaseB） |
| `microflow/src/stage-executor.spec.ts` | 2+3 | shell 跳过 Phase A/B 测试（如有 harness 可测） |
| `ui/src/client/UnifiedTimeline.tsx` | 2+4 | shell completed 显示 output + PhaseBadge completed 不可点击 |
| `ui/src/client/run-view-model.ts` | 2 | TimelineStepItem 补 `commandType` + `finalizeAssessErrorDetail` |
| `ui/src/client/index.ts` | 4 | `openSession` 两处加 try/catch |

## 验证步骤

1. `pnpm typecheck` + `pnpm build` + `pnpm test`（基线 800 tests / 35 files，改后需全绿）
2. 重启 dev（3090），验证：
   - 多条件分支节点：一次 fork 批量评估，branchMeta 保留（不再只留最后一条）
   - shell 步骤 completed：直接显示命令输出（不再空白）
   - shell 步骤收尾流程：跳过 Phase A/B，直接 Phase C（门禁）
   - completed 后「已收尾/已门禁/已判断」badge 不可点击（纯文本）
