# Round 23：stage-executor 中途 commit 引擎级 completed 导致 ask 工具注入 gate 误判终态

> **日期**：2026-08-25
> **来源**：真实 e2e 诊断（第 3 次运行卡在 loop 回跳 sce1 visit 2 的 ask）
> **类型**：引擎 bug（影响真实场景，非仅 e2e）

---

## 一、现象

真实 e2e（wfl-2dcf2ae6 test-workflow）第 3 次运行：工作流完整执行到 loop → 回跳 sce1（第 2 次迭代，loopIteration [1]），**sce1 visit 2 子代理调用 ask_user_question 后永久挂起**（40min 超时）。visit 1 的 sce1 ask 正常（自动回答生效）。

## 二、诊断链（session 日志 + state 轮询实证）

1. visit 2 子代理（e769d6e4 / af90974a）工具列表有 `ask_user_question`，描述与 sandore 版一致（**但 DSH 全局版 tool-ask-user 的描述与参数 schema 完全相同**——无法从列表/调用参数区分）。
2. visit 2 子代理调用 ask_user_question 后：**无 question 事件**（hostAgent session 无 `sandore/question` append、pendingInteractions 始终空）→ sandore 引擎未登记 ask → 自动回答（`sandore/question` 事件驱动）无从触发 → 子代理挂起。
3. visit 2 段（sce1 loop=[1]）`sessionMeta.childId` 更新正常（真实子代理 id，onChildStarted 生效）——排除 stepEntry 反查失败。
4. **关键**：轮询显示 visit 2 期间 `state.status = 'completed'`（引擎级）——**loop step 完成时 `completeAfterFinalize` 的条件写把引擎级 status 设为 completed**。

## 三、根因

**sandore 引擎 bug（Round 22 重构引入/放大）**：

1. `stage-executor.ts` `completeAfterFinalize`（Round 22 条件写）：step 完成时
   `if (!isTerminalState(state)) { state.status='completed'; commitState({status:'completed'}) }`
   → **把引擎级 `active.state.status` 提前写成 completed**（工作流仍在执行）。
2. `workflow-engine.ts` `registerSandoreAskToolSetup` 的注入 gate：
   `TERMINAL_STATUSES.has(instance.state.status)`——**completed ∈ 终态集**
   → **status='completed' 时 gate 不命中** → 子代理**不注入 sandore 版 child-scope ask 工具**（遮蔽全局版失效）→ 模型调用**DSH 全局版 ask_user_question**。
3. DSH 全局版 execute → `ctx.userQuestions.ask(...)`——headless 下无 UI 提供者 → **永久挂起**（子代理卡死）。真实 UI 环境即使能回答，语义也不正确（绕过 sandore 引擎的 ask 闭环）。

**触发条件**：**任何「step 完成（status 被写 completed）之后创建的、会调用 ask 的 step 子代理」**——典型场景：**循环回跳的 ask step**（visit 2）、**跨 stage 的 ask step**（stage 完成时 runLoop 兜底也 commit completed）。首 stage 首个 ask step 正常（startInstance 初始 status='running'）。

## 四、修复

**原则**：引擎级 `status='completed'` 只在**工作流真正完成**时设置（`workflow-engine.ts` L1480 是唯一合法设点，见 L1476-1482 注释「工作流成功完成：落 completed 终态」）。**stage-executor 不 commit 引擎级 completed**。

### 改动 1：`completeAfterFinalize` 删除条件写

```ts
// 改前（stage-executor.ts，Round 22 加）：
if (!this.isTerminalState(state)) {
  state.status = 'completed';
  this.options.commitState?.({ status: 'completed' });
}

// 改后：删除整块（step 完成不写引擎级 completed——引擎在真正结束时统一落）
```

### 改动 2：`runLoop` 循环末兜底去掉 commitState

```ts
// 改前：
} else if (!this.isTerminalState(state)) {
  state.status = 'completed';
  this.options.commitState?.({ status: 'completed' });
}

// 改后（保留 StageRunState 内部语义，不 commit 引擎级）：
} else if (!this.isTerminalState(state)) {
  // 仅设内部状态；不 commit 引擎级 completed（原因见上）
  state.status = 'completed';
}
```

**保留**：`terminalPriority` re-assert（failed/paused/ask 终态必须 commit 引擎级）；失败/ask/pause 的无条件终态写；resumePendingAsk/Paused 入口重置 running + commitState。

**安全性**：引擎 `runAndCatch`（L1438）只检查 `result.status === 'failed'`；非 failed 一律走 completed 分支（L1456+）——stage-executor 返回内部 completed/running 不影响引擎。UI 刷新靠事件（step-completed/stage-completed）驱动，不依赖中途 status。

## 五、测试适配

- `stage-executor.spec.ts`：Round 22 新增测试若断言 commitState({status:'completed'}) 需适配（改为断言不 commit 或仅内部状态）。
- `workflow-engine.spec.ts`：终态断言不受影响（引擎结束设 completed）。
- 真实 e2e：断言 A1（end completed）、A2（state.status completed）不变（引擎结束设）。

## 六、验证

1. 相关单测全绿（stage-executor / workflow-engine / e2e 默认 skip）
2. `pnpm build`（lib 变更）
3. 重跑真实 e2e：**sce1 visit 2 的 ask 应被自动回答**（gate 命中 → sandore 版工具 → question 事件 → replyQuestion）→ 工作流应完整跑完（含 loop 回跳 + breakCondition 判断）
