# retryStep 与真实 DSH continuation 生命周期不兼容（后续修复计划）

> **日期**：2026-08-25
> **来源**：真实 e2e 多轮运行诊断（第 5/8/9/10/11/12/13 次）
> **状态**：**已定位根因，修复另立任务**（e2e 已去掉自动重试，见 bugfix-2026-08-25-round23-midstage-completed-ask-gate.md）
> **优先级**：中高（真实用户「重试失败 step」功能受影响）

---

## 一、问题现象

真实 e2e（test-workflow，真实 LLM 子代理）中，step 失败（门禁 AI 误判 / 模型 429/529）触发 `retryStep` 自动重试后：

| 模式 | 现象 | 证据 |
|------|------|------|
| `continue` | 重试后**卡死**（40min 无 end、无新段） | 第 5 次（429 settle error 后第二次 retryStep） |
| `fork`（修复前） | `forkSession` 对已 dispose 会话抛 `SESSION_NOT_FOUND` | 第 9/10 次（`ctx.sessions.fork` 只认 live） |
| `fork`（修复后） | `agents.create` 新 agent 无 continuation 状态 → `followup` 抛 `SubagentError: has no supported continuation state` | 第 13 次 |
| `fork`（修复前 createAgent） | `meta.parentSession=源childId` 与 DSH lineage 校验冲突 → `SubagentError: belongs to another parent session` | 第 12 次 |

## 二、根因（完整定位）

### 2.1 DSH continuation 生命周期

DSH 的可续接子代理（continuable）生命周期：

```
subagents.startContinuable（provider 'fork'/'spawn'）
  → prepareContinuable（provider 决定 seed：fork 从 parent 完成 turn 前缀截取）
  → child 创建（durable continuation 状态注册）
  → followup(prompt) → agent loop → settle（completed/error/max-tokens/aborted）
  → watchSettlement → **dispose（live 移除，continuation 状态注销）**
  → cold-resume：仅当会话可从持久化 hydrate 且 continuation 状态仍在
```

### 2.2 sandore retryStep 的三种模式与真实环境的冲突

`sandore/recovery-manager.ts` `retryStep`（L217-333）：

1. **continue 模式**（L263-266 + L313）：复用旧 childId，`followup(childId, ...)`。
   - **真实环境问题**：失败的 step 子代理已 settle → DSH **dispose**（continuation 注销）→ `followup` 已注销的子代理**挂起**（第 5 次 40min 卡死）。
   - 单测环境不暴露：mock subagents 的 followup 无 continuation 校验。

2. **fork 模式**（L270-312）：`forkSession(childId, boundary)` → `createAgent({ sessionId: newChildId, meta: { parentSession: childId }, seed })` → `followup(newChildId)`。
   - **问题 a（已修 2026-08-25）**：`ctx.sessions.fork` 只认 live 会话；已 settle/dispose 的源会话 → `SESSION_NOT_FOUND`。修复：`forkSession` deps 加 live → `sessionPersistence.inspect` 回退（workflow-engine.ts）。
   - **问题 b（已修 2026-08-25）**：`meta.parentSession=源childId` 与 DSH lineage 校验（`continuation.ts authorizeLineage`：`child.parentSession === parent.id`，parent=宿主主代理）冲突 → `belongs to another parent session`。修复：engine `createAgent` deps 包装统一 `parentSession=hostAgent.id`。
   - **问题 c（未修，核心）**：`agents.create` 创建的新 agent **不是 continuable**（未注册 continuation 状态）→ `subagents.followup(newChildId)` 抛 `has no supported continuation state`（第 13 次）。
   - **问题 d（设计缺口）**：DSH `startContinuable` 的 `ContinuableCreateRequest` **无 seed 参数**（seed 由 fork provider 从 parent 计算）——sandore fork 语义（从**任意源会话** fork 事件作 seed）在真实 DSH 无直接对应 API。

3. **revert 模式**：同 fork 的问题 c/d。

### 2.3 为什么单测全绿

- workflow-engine.spec / recovery-manager.spec 用 **FakeSubagents / mock agents.create**——不校验 continuation 状态、不 dispose、followup 无 lineage 校验——三种模式在 mock 下均「可用」。

### 2.4 已顺带修复（本轮 e2e 驱动）

- **ask 工具注入 gate 误判终态**（Round 23）：stage-executor 中途 commit 引擎级 completed → 循环回跳 ask step 用全局 ask 工具挂起。详见 bugfix-2026-08-25-round23-midstage-completed-ask-gate.md。
- **循环栈残留**：stage 完成/终态统一清空。
- **forkSession live → 持久化回退**（问题 a）。
- **createAgent parentSession 统一 hostAgent**（问题 b）。

## 三、修复计划（后续）

### 方向 A（推荐）：retryStep fork/revert 改用 DSH continuation 原生重建

理解并复用 DSH 的 cold-resume / restart 机制：

1. **研究 DSH continuation**（`packages/subagent/subagent/src/continuation.ts`）：
   - `followup` 对已 settle 子代理的 cold-resume 条件（持久化 hydrate + continuation 状态保留的时机）
   - 是否有 `restart`/`resumeContinuable` API（进程内 settle 后重建）
2. **continue 模式**：若 DSH 支持「settle 后 cold-resume」（需 child 会话持久化 + 未 dispose），调整 sandore 重试时机（在 dispose 前？）或显式重建。
3. **fork/revert 模式**：改用 `subagents.startContinuable`（provider 'spawn' 或 'fork'）+ **seed 注入**——若 `ContinuableCreateRequest` 不支持 seed，评估：
   - provider 扩展（sandore 自注册 continuable provider，`prepareContinuable` 返回指定 seed）
   - 或「fork 源会话 → startContinuable 基于 fork 会话」（`sessions.fork` 创建的 live 会话作 continuation 源）

### 方向 B（兜底）：重试失败快速落态

若 DSH 无法支持进程内重建，retryStep 对已 dispose 会话**快速失败**（不挂起、不抛未处理错误）：
- `followup`/`createAgent` 失败 → `failRetry`（已有）→ 明确报错信息「子代理会话已销毁，无法重试」
- 至少消除「卡死 40min」与「UNAUTHORIZED 噪音」

### 验收

1. 单测：用**真实 continuation mock**（模拟 settle→dispose→cold-resume 语义）覆盖三种模式
2. 真实 e2e 恢复自动重试（re-enable），门禁误判/模型波动场景重试后应能完成
3. `pnpm typecheck` + `pnpm build` + 全量 test

## 四、关联

- e2e 已去掉自动重试（workflow-engine-real-e2e.spec.ts，2026-08-25），断言 22b 改为「无 step-retried 事件」
- 真实 e2e 其余修复：bugfix-2026-08-25-round23-midstage-completed-ask-gate.md
- DSH 参考：`packages/subagent/subagent/src/continuation.ts`（followup L1255-1266、authorizeLineage L1273-1287、watchSettlement L1295+）、`types.ts`（ContinuableCreateRequest L167-177 / ContinuableCreateSpec L185-192）
