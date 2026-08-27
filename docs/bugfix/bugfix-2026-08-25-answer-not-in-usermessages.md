# 修复计划核实报告：ask 回答不应注入 userMessages（讨论页不再显示回答气泡）

- 日期：2026-08-25
- 范围：仅核实影响面并产出修正版修复计划（不改任何源码；sandore 与 DSH 均只读）
- 目标文件：`packages/sandore/workflow/src/workflow-engine.ts`、`packages/sandore/ui/src/client/run-view-model.ts`、`packages/sandore/workflow/src/workflow-engine.spec.ts` 等（见影响面清单）

---

## 0. 结论摘要

需求（Phase A ask 收尾）：引擎向用户提问并把回答 followup 注回 step 子代理——**正确，保留**；但回答同时被写入 `state.userMessages`（`kind:'answer'`），导致讨论页（RunView 统一时间线）渲染「用户气泡 + answer 徽标」。用户要求回答不再注入 `userMessages`。

核实结论：**原计划（删除写入块）大方向正确，且经核实 4 处必须补充**：

1. **唯一写入点确认** ✅：全仓 `kind:'answer'` 仅 `workflow-engine.ts:1374` 一处运行时写入（引擎 interacting 分支 L1368-1381）。`lifecycle-manager.ts:285` 的 `userMessage()` 辅助类型联合含 `'answer'` 但从不以 `'answer'` 调用（仅 `'resume'`）；`schema.ts:403` 的枚举含 `'answer'` 但只是类型/校验面，非写入。
2. **UI 需同步过滤（不能只删引擎侧）** ⚠️：`run-view-model.ts buildTimeline`（L489-497）把 `userMessages` **全部**转成时间线条目，`UnifiedTimeline.tsx UserMsg`（L443-451）渲染 answer 徽标。只删引擎写入块的话，**历史实例（如 `00b1a319-…`）已落盘的 answer 记录仍会在讨论页展示**——必须同时在 `buildTimeline` 跳过 `kind:'answer'`，统一「讨论页不显示回答」目标（推荐，见 §4）。
3. **schema 枚举 `'answer'` 绝不能删** ⚠️：`domain.ts:24` 经 `WorkflowTaskStateSchema` 校验 state 表**每条**记录（读写皆 parse）；历史实例 userMessages 含 answer 记录，删枚举会 zod 校验失败 → 旧实例不可读/不可恢复。`'answer'` 保留为历史兼容值。
4. **恢复/续跑不依赖 answer 记录** ✅：`recovery-manager.recover()` 只按 `executedSteps` 状态分类 + followup 冷恢复提示词（不读 userMessages）；`retryStep`/`resumeStep` 只**写** `'retry'`/`'resume'` 记录、不读；回答已在回答时经 `subagents.followup`（L1363）注回子代理会话（source `{kind:'user'}`），子代理会话持久化里已有回答 turn——恢复不需要 answer 记录。

其余核实项均通过：`buildAnswerText` 仍用于 followup（L1360→L1363，保留不删）；删除块后 L1382 `persistState` 冗余但无害（建议保留）；`interaction-manager` / `engine-surface` / `wire` / `remote` / `seam` 均不读不写 answer（userMessages 提及全是 `kind:'message'` 的 @mention 通道）；回答可见性无功能缺口（composer 问答卡 + 子代理续跑输出 + 子代理会话内可见回答 turn）。

---

## 1. 影响面清单

### 1.1 唯一写入点 ✅

| 位置 | 内容 |
|------|------|
| `workflow-engine.ts:1368-1381` | interacting 分支 `active.state = { ...active.state, userMessages: [...(active.state.userMessages ?? []), { id, kind:'answer', target: stepId, content: answerText, createdAt }], updatedAt }` —— **唯一运行时写入** |
| `workflow-engine.ts:1382` | `await this.persistState(active)`（紧随写入块） |
| `workflow-engine.ts:1348-1350` | 注释描述「回答写入 userMessages（kind:'answer'）统一时间轴」（需同步改文案） |

全仓 grep `kind: 'answer'` 命中（不含 node_modules）：
- `workflow-engine.ts:1349`（注释）、`:1374`（写入）—— 引擎
- `workflow-engine.spec.ts:2626/2665`（注释）、`:2631/2667`（断言 filter）—— spec
- 无其它写入点。

相关非写入点（确认不含 answer）：
- `workflow-engine.ts:255-261`：初始 `kind:'input'`（原始需求）。
- `workflow-engine.ts:1014-1028`：`sendStepMessage` 写 `kind:'message'`（@mention）。
- `workflow-engine.ts:1702-1709` / `1720-1727`：lifecycle / recovery 的 `appendUserMessage` 接线（分别由 `lifecycle-manager.ts:167/202` 写 `'resume'`、`recovery-manager.ts:258-264` 写 `'retry'`）。
- `lifecycle-manager.ts:285`：`userMessage()` 签名类型联合含 `'answer'`，**从不以 `'answer'` 调用**（仅 `'resume'`）。

### 1.2 消费方盘点

#### a. UI（需改：buildTimeline 过滤）✅

| 位置 | 内容 |
|------|------|
| `ui/src/client/run-view-model.ts:489-497` | `buildTimeline` 遍历 `state.userMessages ?? []` **全部**条目 → `TimelineUserItem`（`messageKind: message.kind`，含 `'answer'`） |
| `ui/src/client/run-view-model.ts:477` | 注释「userMessages（input/resume/retry/answer，含原始需求…）」（需同步改文案） |
| `ui/src/client/UnifiedTimeline.tsx:436-461` | `UserMsg` 渲染右侧气泡 + 徽标；`:443-451` 徽标映射含 `messageKind === 'answer'` → `run.user.kind.answer` |
| `ui/src/client/locales.ts:212`（zh `'回答'`）/`:609`（en `'Answer'`） | answer 徽标文案 |
| `ui/src/client/RunView.tsx:195` | `buildTimeline(state)` 是 UI 唯一生产消费点（useMemo）→ **在 buildTimeline 过滤即可覆盖全部 UI** |

UI 侧测试：`run-view-model.spec.ts` 无 `'answer'` 断言（grep 无命中）→ UI 改动不破坏既有用例。

#### b. spec 断言（需改：删除后两处失败）⚠️

| 位置 | 断言 | 删除写入块后 |
|------|------|--------------|
| `workflow-engine.spec.ts:2625-2634` | `answers = state?.userMessages?.filter(m => m.kind === 'answer')` → `toHaveLength(1)`、`target==='step-ask'`、`content==='A'`（卡片通道回复用例） | **失败**（长度变 0） |
| `workflow-engine.spec.ts:2665-2669` | 同上 → `toHaveLength(1)`、`content==='B'`（replyQuestion 兼容路径用例） | **失败** |

不受影响：`workflow-engine.spec.ts:3966/4017`（`kind:'message'` 断言，sendStepMessage）；`workflow-engine-e2e.spec.ts` / `workflow-engine-real-e2e.spec.ts` 无 userMessages answer 断言（real-e2e 仅自动 `replyQuestion`，L514-530）；`recovery-manager.spec.ts` 只断言 `'retry'`（L351）；`interaction-manager.spec.ts` 不涉 userMessages。

#### c. 恢复/续跑（确认不消费 answer 记录）✅

| 位置 | 行为 |
|------|------|
| `recovery-manager.ts:349-378` `recover()` | 只读 `executedSteps` 分类（running/interacting 子代理 Step）→ `followup` 冷恢复提示词（L351/L373）；**不读 userMessages** |
| `recovery-manager.ts:222-338` `retryStep` | **写** `kind:'retry'` 记录（L258-264）；**不读** userMessages |
| `lifecycle-manager.ts:153-205` `resumeStep`/`resumeAllSteps` | **写** `kind:'resume'` 记录（L167/L202）；**不读** userMessages |
| `workflow-engine.ts:1363` | 回答已 `subagents.followup(hostAgent, childId, [answerText], { source:{kind:'user'} })` 注回子代理 → 子代理会话（DSH 持久化）内已有回答 turn |

结论：resume/retry/崩溃恢复的输入是「子代理会话历史 + 冷恢复提示词」，**不依赖 userMessages 里的 answer 记录**；删除 answer 写入不影响任何恢复路径。✅

#### d. 其它（确认不读不写 answer）✅

| 位置 | 内容 |
|------|------|
| `interaction-manager.ts:116` | 注释「`buildAnswerText` → 注回子代理/**写 userMessages** 的可读文本」（需同步改文案：仅注回子代理） |
| `interaction-manager.ts:220/356` | 注释「历史由 userMessages 与 executedSteps 承载」——泛指历史（input/resume/retry/message 仍承载），**不涉 answer 消费** |
| `engine-surface.ts:47` / `wire.ts:220` / `remote.ts:394` / `seam.ts:155` | userMessages 提及全部是 `sendStepMessage` 的 `{kind:'message', target:stepId}` 描述（@mention），与 answer 无关 |
| `schema.ts:403` | `kind: z.enum(['input','resume','retry','answer','message'])` —— 类型/校验面，非写入；**枚举值 `'answer'` 必须保留**（见 §3 历史数据） |

---

## 2. 删除写入块的影响

删除 `workflow-engine.ts:1368-1381`（`active.state = {…}` 整块）后：

- **L1382 `persistState` 保留（建议）**：状态在回答时刻已由 `finishQuestion → syncState → persist` 回调（`interaction-manager.ts:261-271` → 引擎 `workflow-engine.ts:1677-1680`，置 `pendingInteractions: []` + `updatedAt` 并 persist）持久化；L1382 此时写入的是同一状态，**冗余但无害**。保留 = 最小 diff + 维持「每次状态变更后显式落盘」的不变式；删除亦可（省一次磁盘写），但不推荐为省一次写引入行为差异风险。
- **`buildAnswerText`（L1360）保留不删** ✅：仍用于 followup 注回（L1363）。`isRejectedAnswer`/`handleRejectedQuestion`（L1356-1358）不受影响。
- **注释同步**：L1348-1350 改为「回答仅 followup 注回子代理，不写 userMessages（讨论页不显示回答）」；`interaction-manager.ts:116`、`schema.ts:399` 注释同步。

---

## 3. 历史数据（推荐：UI 统一过滤）

旧实例（如 `00b1a319-ce91-46d9-880a-56f7556ef9f1`）的 `userMessages` 已含 `kind:'answer'` 记录（持久化于 state 表）。只删引擎写入块只能阻止**新**回答入库，旧记录仍会被 `buildTimeline` 渲染。

**推荐方案：引擎侧停写 + UI 侧过滤，双管齐下**：

1. **引擎**：删除 L1368-1381 写入块（不再产生新 answer 记录）。
2. **UI**：`buildTimeline` 循环跳过 `message.kind === 'answer'`（`if (message.kind === 'answer') continue;`）→ 历史 answer 记录统一隐藏，与「讨论页不显示回答」目标一致。
3. **不做数据迁移**：无需清洗旧 state（UI 过滤即可覆盖）；且本轮不改源码。
4. **schema 枚举 `'answer'` 保留**：`domain.ts:24` 的 `WorkflowTaskStateSchema` 校验 state 表每条记录（读写皆 parse）——删除枚举会让含 answer 的历史实例 zod 校验失败（不可读、`recoverInstance`/`getInstanceState` 全挂）。`'answer'` 作为历史兼容值保留，仅注释标注「历史遗留，不再写入」。

---

## 4. 回答的可见性（无功能缺口）✅

删除 userMessages 写入后，用户仍能从三处感知「自己回答了」：

1. **ask 弹窗期间**：主会话 composer 的 `SandoreQuestionComposer`（`ui/src/client/SandoreQuestionComposer.tsx`）→ `QuestionCard`（复用 DiscussionInput 接管面板）展示问题 + 自定义输入，作答即感知；回答成功后乐观移除卡片（`sandore-questions.ts:70` `removeSandoreQuestion`）。
2. **回答后（执行体现）**：followup 注回子代理（L1363）→ 子代理基于回答继续 → Step 卡输出更新出现在讨论页时间线（step 卡，非用户气泡）。
3. **子代理会话内**：回答以用户 turn（source `{kind:'user'}`）进入子代理会话，Step 卡「打开子代理会话」可见。

讨论页不再显示回答气泡正是需求目标；composer 卡片 + 子代理续跑输出构成完整闭环，无功能缺口。

---

## 5. 修正版修复计划

### 5.1 引擎：删除写入块（`packages/sandore/workflow/src/workflow-engine.ts`）

- **删** L1368-1381（`active.state = { … userMessages 追加 {kind:'answer'} … }` 整块）。
- **留** L1382 `await this.persistState(active);`（冗余但无害；维持显式落盘不变式）。
- **改** L1348-1350 注释：去掉「回答写入 userMessages（kind:'answer'）统一时间轴」措辞，改为「回答经 `buildAnswerText` → followup 注回真实子代理（synthetic===false）让子代理基于回答继续；**不写入 userMessages**（讨论页不显示回答气泡）」。

### 5.2 UI：buildTimeline 过滤历史 answer（`packages/sandore/ui/src/client/run-view-model.ts`）

- L489 循环内、push 之前加：
  ```ts
  // 历史兼容（bugfix 2026-08-25）：kind:'answer' 是 ask 回答的内部闭环记录
  // （回答已 followup 注回子代理），讨论页不展示——统一隐藏旧实例残留记录。
  if (message.kind === 'answer') continue;
  ```
- L477 注释同步（去掉「/answer」措辞，说明 answer 被过滤）。

可选（防御性死代码，不强制）：`UnifiedTimeline.tsx:449` 的 answer 徽标分支与 `locales.ts:212/609` 词条保留无害（buildTimeline 过滤后不会有 answer 条目；旧缓存/未来复用兜底）。

### 5.3 spec 适配（`packages/sandore/workflow/src/workflow-engine.spec.ts`）

两处断言改为「不再写入」+ 强化真实契约（回答注回子代理）：

- **L2625-2634**（卡片通道回复，选 A）：注释改为「回答**不写入** userMessages（kind:'answer' 仅历史遗留）——回答经 followup 注回子代理」；断言改为：
  ```ts
  const answers = state?.userMessages?.filter(message => message.kind === 'answer');
  expect(answers).toEqual([]);
  // 真实契约：回答文本经 followup 注回子代理会话。
  const followups = subagents.followups.filter(f => f.childId === 'child-1');
  expect(followups.some(f => f.content.some(b => b.type === 'text' && b.text === 'A'))).toBe(true);
  ```
- **L2665-2669**（replyQuestion 兼容路径，选 B）：同样改为 `expect(answers).toEqual([])` + followup 内容断言 `'B'`。
- 其余 `kind:'message'` 断言（L3966/4017）与恢复/生命周期断言不受影响。
- 可选：`ui/src/client/run-view-model.spec.ts` 新增一例「buildTimeline 过滤 kind:'answer'（历史实例）」断言（含 answer 的 userMessages 不产出 user 条目）。

### 5.4 文档同步（可选，非源码）

- `docs/design/execution-segment-timeline.md:228/244/374/382/394`：标注该设计决策（`kind:'answer'` 进 userMessages）已被本 bugfix 推翻（回答不写 userMessages）。
- `interaction-manager.ts:116`、`schema.ts:399` 注释文案同步（见 §1.2d / §3）。

### 5.5 验证步骤

1. `pnpm vitest run packages/sandore/workflow/src/workflow-engine.spec.ts` —— interaction 两用例改后全绿；`kind:'message'`、恢复、生命周期用例不受影响。
2. `pnpm vitest run packages/sandore/ui/src/client/run-view-model.spec.ts` —— buildTimeline 既有用例 + 新增过滤用例全绿。
3. `pnpm typecheck`（root：`pnpm -r --if-present run typecheck`）。
4. 手动（dev 实例，AGENTS.md 流程）：`node --import tsx/esm D:\project-code\llm\deepseek-harness\apps\cli\src\bin.ts --profile web --patch D:\project-code\llm\sandore\cordis.yml --port 3090`：
   - 跑含 ask 的工作流（如 wfl-ask）→ composer QuestionCard 回答 → RunView 讨论页**无回答气泡**；Step 卡续跑输出正常；打开子代理会话可见回答 turn。
   - 打开旧实例 `00b1a319-…` → 讨论页无历史 answer 气泡（UI 过滤生效）；实例可正常读取（schema 枚举保留）。

---

## 6. 证据行号索引

| 关注点 | 证据 |
|--------|------|
| 唯一写入点 | `workflow-engine.ts:1374`（`kind: 'answer'`）、`:1368-1381` |
| followup 注回 | `workflow-engine.ts:1360-1367`（`buildAnswerText` + `subagents.followup` source user） |
| persistState | `workflow-engine.ts:1382` |
| UI 渲染 | `run-view-model.ts:489-497`、`UnifiedTimeline.tsx:443-451`、`locales.ts:212/609`、`RunView.tsx:195` |
| spec 断言 | `workflow-engine.spec.ts:2631-2634`、`:2667-2669` |
| 恢复不读 | `recovery-manager.ts:349-378`（recover）、`:258-264`（retry 写）、`lifecycle-manager.ts:167/202`（resume 写） |
| 其它通道 | `interaction-manager.ts:116/220/356`、`engine-surface.ts:47`、`wire.ts:220`、`remote.ts:394`、`seam.ts:155`（皆 `kind:'message'` 或泛历史注释） |
| schema | `schema.ts:403`（枚举含 answer，**保留**）、`domain.ts:24`（state 表 zod 校验） |
| 可见性 | `SandoreQuestionComposer.tsx:38-100`、`sandore-questions.ts:87-92`（乐观移除）、`workflow-engine.ts:1363`（子代理会话内回答 turn） |

---

## 7. 实施记录（2026-08-25，用户确认「按计划实施」）

已按修正版计划落地：

1. **引擎**（`workflow-engine.ts`）：interacting 分支删除 `userMessages` kind:'answer' 追加块（原 L1368-1381），回答仅 followup 注回子代理（L1360-1367 保留）；`active.state` 只更新 `updatedAt` 后 `persistState`（保留）；L1348-1350 注释更新（回答不写 userMessages，可见性由 composer 问答卡 + 子代理续跑输出承载）。
2. **UI**（`run-view-model.ts`）：`buildTimeline` L489 前加 `if (message.kind === 'answer') continue`——历史实例已落盘的 answer 记录同样隐藏；注释同步。
3. **spec**（`workflow-engine.spec.ts`）：两处 `kind:'answer'` 断言改为 `toEqual([])`（不再写入）+ 新增 followup 注回内容断言（`subagents.followups` 含 `'A'`/`'B'` 文本）；两用例 harness 解构补 `subagents`。
4. **验证**：typecheck ✅ / build ✅ / **790 tests + 1 skipped 全绿** ✅；dev 实例（3090）已重启生效。

| 设计文档 | `docs/design/execution-segment-timeline.md:228/244/374/382/394` |
