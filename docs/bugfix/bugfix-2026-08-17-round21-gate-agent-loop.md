# Round 21：门禁 fork 会话改走 subagent agent loop（startContinuable）

> **日期**：2026-08-17
> **来源**：用户修复计划（方案 A，已确认执行）
> **状态**：已核验，等待实施

---

## 根因（用户描述）

门禁评估（Phase C secondary）用 raw `llm.stream`（`runStream`）跑 AI，无 tools、无 agent loop、无系统提示词——AI 要验证文件却无 glob/read/shell 工具 → 幻觉命令。

**用户洞察**：门禁子代理本质上与 step 执行子代理同类型（同属宿主主代理的子代理），应走同一机制：`ctx.subagents.startContinuable`（DSH agent loop + 工具 + preset 系统提示词）。

## 核验发现（主代理交叉核验 2026-08-17）

1. **当前实现**（finalize-manager.ts `GateEvaluator.evaluateSecondary` L958-996）：已用 `agents.create` + `driveAgentRound`（followup → whenIdle → finalAssistantOutput）建子代理，`runStream` 仅在降级路径（配置缺省 / createAgent 抛错）。但 `agents.create` 路径与 step 执行子代理的 `subagents.startContinuable`（DSH continuation 机制：settle 终态语义 + preset 继承 + 全量工具）**机制不同**——按用户方案统一为 startContinuable。
2. **可复用范式**（step-runner.ts `runSubagent` L474-490 + `collectSubagentOutput` L529-568）：
   - `ctx.subagents.startContinuable({ provider: subagentProvider /* 缺省 'fork' */, label, request: { prompt: [{type:'text',text}], parent: hostAgent, agentOptions }, signal })` → `{ childId }`
   - `ctx.agents.get(childId)` → child；settle：注入的 `awaitSubagentSettlement(childId, signal)` → `settlement.stopReason === 'completed'` → `settlement.output ?? finalAssistantOutput(child.session.events)` → `textSummary`；未注入回退 `child.whenIdle()` + `finalAssistantOutput`
3. **类型与依赖**：
   - `ctx.subagents` 类型已全局声明（subagents.ts L401-403 `declare module '@deepseek-ai/cordis'`）✅
   - `textSummary`/`finalAssistantOutput`/`SubagentSettlement`/`Agent` 均可从现有 import 获取（finalize-manager.ts L39-42）
   - `resolveForkAgentOptions(config)`（L325）直接用作 startContinuable 的 agentOptions
   - `synthesizeGateChildId`（L320）改后不再使用 → 删除
4. **注入链路**：workflow-engine.ts L1147 `new FinalizeManager(this.ctx, { ...runnerConfig, hostAgentId, createAgent, getStepSessionEvents })`——`runnerConfig` 已含 `hostAgent`（Agent 对象，L1554）/`awaitSubagentSettlement`（L1581）/`subagentProvider`（缺省 'fork'），构造处显式补传即可。
5. **spec 现状**：
   - stage-executor.spec.ts harness（L123）已注入 FakeSubagents ✅
   - finalize-manager.spec.ts harness（L150-170）无 subagents mock → 需补
   - e2e FakeSubagents（workflow/tests/mocks/subagents.ts）完整支持 startContinuable + settle 事件 + agents.get ✅，childId 格式 `child-{index}`
   - finalize-manager.spec.ts secondary gate 测试（L753-931）用 createAgent mock → 改 startContinuable mock
   - 纯 primary 门禁测试（L1345/L1524）gateSessionId 仍是 `newSessionHandle()`（UUID）→ 不变 ✅

---

## 修复（方案 A）

### 1. `finalize-manager.ts`

**FinalizeManagerConfig 新增字段**：
```ts
/** 宿主主代理（secondary 门禁 startContinuable 的 request.parent；引擎注入 runnerConfig.hostAgent）。 */
readonly hostAgent?: Agent;
/** 子代理 settle 终态等待（引擎注入 runnerConfig.awaitSubagentSettlement，经 sandore/subagent-settled 事件路由）。 */
readonly awaitSubagentSettlement?: (childId: string, signal: AbortSignal) => Promise<SubagentSettlement>;
/** DSH subagent provider 注册名（startContinuable 的 provider；缺省 'fork'）。 */
readonly subagentProvider?: string;
```

**`GateEvaluator.evaluateSecondary` 改造**（替换 createAgent + driveAgentRound 路径）：
1. 缺省检查：`this.config.hostAgent === undefined` → 降级 runStream（errorDetail 文案保留原意，更新为「hostAgent not configured」）。
2. 主路径：
   ```ts
   const started = await this.ctx.subagents.startContinuable({
     provider: this.config.subagentProvider ?? 'fork',
     label: `gate ${input.step.id}`,
     request: {
       prompt: [{ type: 'text', text: promptText }],
       parent: this.config.hostAgent,
       ...(agentOptions === undefined ? {} : { agentOptions }),  // resolveForkAgentOptions(this.config)
     },
     signal: input.signal ?? new AbortController().signal,
   });
   const raw = await this.awaitGateOutput(started.childId, input.signal);
   return this.secondaryFromRaw(raw, started.childId);
   ```
3. 新增 `private async awaitGateOutput(childId: string, signal?: AbortSignal): Promise<string>`：
   - `const child = this.ctx.agents.get(childId)`；undefined → throw（进降级）
   - `awaitSubagentSettlement` 注入：`settlement.stopReason !== 'completed'` → throw（进降级）；`blocks = settlement.output ?? finalAssistantOutput(child.session.events)`；`blocks === undefined` → throw；返回 `textSummary(blocks)`
   - 未注入回退：`await child.whenIdle()` → `finalAssistantOutput(child.session.events)` → `textSummary`；undefined → throw
4. 降级 catch 不变（runStream + errorDetail：`secondary gate subagent degraded to temp session: ${describeError(error)}`）。
5. 删除 `synthesizeGateChildId`；`driveAgentRound`/`forkStepSubagent` import 保留（Phase B assessForked 用）。
6. 更新文件头注释（L21-26 Phase C 描述）与 `evaluateSecondary` JSDoc：secondary 门禁 = `subagents.startContinuable` 宿主子代理（agent loop + 工具 + preset 系统提示词，与 step 执行子代理同机制），settle 终态取输出，失败降级 runStream（不失败）。

### 2. `workflow-engine.ts`（L1147 FinalizeManager 构造）

新增显式传参：
```ts
...(runnerConfig.hostAgent === undefined ? {} : { hostAgent: runnerConfig.hostAgent }),
...(runnerConfig.awaitSubagentSettlement === undefined ? {} : { awaitSubagentSettlement: runnerConfig.awaitSubagentSettlement }),
...(runnerConfig.subagentProvider === undefined ? {} : { subagentProvider: runnerConfig.subagentProvider }),
```

### 3. spec 适配

**finalize-manager.spec.ts**：
- harness ctx 补 `subagents: { startContinuable: mock }`（返回 `{ childId }`）+ `agents.get(childId)` mock（返回带 session.events/whenIdle 的 child）+ fullConfig 补 `hostAgent`（最小 Agent 桩：`{ id: 'host-1', session: { events: [] }, options: {} }` 等按现有 agents mock 的 Agent 形状）+ 可注入 `awaitSubagentSettlement`（测试手动 settle 或回退 whenIdle）。
- secondary gate 测试（L753-931 约 8 个 it）：改断言 startContinuable 被调用（prompt 携带门禁提示词、parent = hostAgent）、gateSessionId = startContinuable 返回的 childId、settle/输出收集路径；降级测试（L788）改 startContinuable 抛错。
- 其余（primary 纯代码、commitFinalize、Phase B assessForked）不动。

**stage-executor.spec.ts**（L159 `new FinalizeManager(ctx, config)`）：确认编译通过；若该 harness 有 secondary gate 场景，同样适配（FakeSubagents 已注入 ctx）。

**workflow-engine.spec.ts / e2e**：FakeSubagents 已支持 startContinuable；若有 secondary gate e2e 断言（gateSessionId 格式/事件序列），适配为 `child-{index}` 真实 childId 语义；若无门禁 AI e2e 则不动。

### 4. 不碰

- Phase B assessForked（保持 forkStepSubagent + agents.create + driveAgentRound + dispose）
- Phase D 路由（branch-evaluator runRoutingAi）
- step-runner、FakeSubagents mock、runStream 降级机制本身
- 门禁 primary 纯代码 verifyArtifacts

---

## 改动文件总览

| 文件 | 改动 |
|---|---|
| `microflow/src/finalize-manager.ts` | FinalizeManagerConfig + hostAgent/awaitSubagentSettlement/subagentProvider；evaluateSecondary 改 startContinuable；新增 awaitGateOutput；删 synthesizeGateChildId；注释更新 |
| `workflow/src/workflow-engine.ts` | FinalizeManager 构造补 3 个字段 |
| `microflow/src/finalize-manager.spec.ts` | harness 补 subagents/agents/hostAgent mock；secondary gate 测试适配 |
| `microflow/src/stage-executor.spec.ts` | 编译适配（如需要） |
| `workflow/src/workflow-engine.spec.ts` / e2e | gate 断言适配（如需要） |

## 验证步骤

1. 相关 spec 单跑全绿（finalize-manager / stage-executor / workflow-engine / e2e）
2. 全量 `pnpm typecheck` + `pnpm build` + `pnpm test`
3. 重启 dev（3090），验证：secondary 门禁子代理有工具（能真实 glob/read/shell 验证产物）+ preset 系统提示词；gateSessionId = 真实子代理 id（UI 可打开）
