# bugfix-2026-08-17-round22-runloop-race：runLoop 重构（batch+Promise.all → pendingQueue+Promise.race）审查与完善方案

## 〇、审查范围与方法

- 只读审查 `packages/sandore/microflow/src/stage-executor.ts`、`packages/sandore/workflow/src/workflow-engine.ts`、`packages/sandore/workflow/src/schema.ts`、`packages/sandore/microflow/src/step-navigator.ts`、`packages/sandore/microflow/src/loop-manager.ts`、`packages/sandore/microflow/src/concurrency-limiter.ts` 及四份测试（stage-executor.spec.ts / workflow-engine.spec.ts / workflow-engine-e2e.spec.ts / lifecycle-manager.spec.ts）。
- 主代理引用的行号全部核验属实（stage-executor L592-670 runLoop、L321-363 StageRunState、L407-455 execute、L464-539 initState、L679-704 processCommandNodeWithLimiter、L711-747 processRoutingNode、L750-854 processCommandNode、L1153-1200 completeAfterFinalize、L1259-1278 resumePendingPaused、L1287-1310 resumePendingResumes、L1313-1364 resumeSubagentStep、L1454-1457 persist；workflow-engine L1271-1296 onPersist、L1796-1859 resumeInfo；schema L495 pendingQueue）。
- 结论：**重构方向正确**（对齐注释中引用的「基准 Promise.race + pendingQueue」并发模型，L575），但方案原文存在 4 个会导致**语义破坏或数据丢失**的硬伤（status 竞态、resume 分流缺失、崩溃窗口丢 next、路由并发/循环门 barrier 缺失），另有若干时序与持久化细节需修正。本文件给出完善后的完整实施方案。

---

## 一、主代理初步发现（逐项验证）

### 1. status 竞态覆盖（严重）——**真**

**证据**：`completeAfterFinalize` L1195-1198：
```
1195  await this.persist(executed, state);          // P3 completed 持久化
1196  state.nextBatch.push(...routed.nextNodeIds);
1197  state.status = 'completed';
1198  this.options.commitState?.({ status: 'completed' });
```
L1197 无条件写 `completed`。现有模型不炸是因为 runLoop L647-663 在 `Promise.all` 之后聚合 `failed > paused > ask > completed` 统一回写 `state.status`（L660-664），且引擎在 L1438-1447 依据 `result.status` 再次纠正（`result.status === 'failed'` → `markStageStatus(active, stageId, 'failed')` + 落盘）。新模型删掉聚合步骤后，若节点 A 先完成（L1197 写 completed）、节点 B 后失败（processCommandNode L849-851 写 failed），最终 `state.status='completed'`；反之 A 后完成会无条件把 B 的 failed 覆盖成 completed。processCommandNode 的失败写（L792-794、L849-851）与 runPhaseC 失败写（L1132-1134）都是无条件终态写，竞态真实存在。

**解法**（明确方案）：
- `completeAfterFinalize` 的 completed 写改为**条件写**：`if (!this.isTerminalState(state)) { state.status = 'completed'; commitState?.({status:'completed'}); }`。
- 终态写（failed/paused/interacting）保持无条件（last-write-wins），配合条件 completed 写后**终态永远不可被 completed 覆盖**；同优先级终态互覆（paused 覆盖 failed）由 runLoop 末尾的**终态优先级 re-assert** 兜底（见 4.4）。
- 关键配套：ask/pause 断点续跑入口必须先把 `state.status` 重置为 `'running'`（见第 5 项）——否则条件写会在续跑时被 `interacting/paused` 拦住，Stage 永久卡住。

### 2. processCommandNode 内部 status 写入（双重写入 / commitState 乱序）——**真（需条件化）**

**证据**：L784-796（命令缺失防御路径）L792-794 写 `state.status='failed'` + `commitState`；L846-853（runner 异常路径）L848 persist、L849-851 写 failed + commitState；runPhaseC 失败路径 L1131-1135 同样写 failed + commitState；`completeAfterFinalize` L1197-1198 写 completed + commitState。现有模型的「保证」是：a) runLoop 聚合 L647-663 最终回写 state.status（但**不调 commitState**——聚合处只有 `state.status = finalStatus`，无 commitState 调用，引擎 active.state 在批内可能短暂停在 'completed'，靠 L1438-1447 的 result.status 纠正）；b) 引擎 onPersist L1271-1296 只在逐 Step 持久化时落盘 status，终态由引擎级落盘兜底。

**结论**：双重写入本身不冲突（同一字段赋值），但**乱序真实存在**——completed 快照后 failed 快照（A 先完成、B 后失败时）。修复即第 1 项的条件写：completed 写被终态拦截后，`state.status` 与 commitState 的写入序列单调收敛到终态，不再出现「completed 覆盖 failed」。**无需**为 processCommandNode 内部失败路径加条件（终态写应保持无条件，failed 必须能覆盖任何先前的 completed）；只需 completeAfterFinalize 单侧条件化。

### 3. resume 分流缺失（严重）——**真，计划 3.10 不可行**

**证据**：startNode 只接收 nodeId（计划 3.3 的 `startNode(shift())`）；`processCommandNode` L750-854 是首次执行（新建 executed 段 + runner.run），`resumeSubagentStep` L1313-1364 是续跑（runner.resumeSubagent 重收集输出 + finishCommandNode 共用收尾），二者需要不同的输入（resume 需要既有 executed 段 + childId）。runLoop 只凭 nodeId 无法区分。现有模型用 `pendingResumes`（initState L508-515 从 resumeSubagents 映射）+ execute() L420-425 的 resumePendingResumes（L1287-1310）先行处理，不经过 runLoop。

**解法**（设计已验证）：StageRunState 新增 `resumeSegments: Map<string, { executed: ExecutedStepDefault; childId: string }>`，initState 从 `resumeFrom.resumeSubagents` 播种（`rs.step.id → {rs.executed, rs.childId}`），并把每个 resume 段 nodeId **入队 pendingQueue**；startNode 入口查表分流：
```
const resume = state.resumeSegments.get(nodeId);
if (resume !== undefined) {
  state.resumeSegments.delete(nodeId);
  return this.resumeSubagentStep(state, nodeId, step, resume.executed, resume.childId);
}
```
- 入队顺序：resume 段在前、快照 pendingQueue 在后；快照中的 nodeId 若命中 resumeSegments 则跳过（旧快照 batch 可能同时含 running 节点，防重复拉起）。
- resume 段**不 acquire limiter**（对齐现有 resumePendingResumes 不经 limiter 的语义，避免 maxConcurrentSteps=1 时多路恢复被串行化——这是行为变更，需明示）。
- `StageExecutorResume` 类型与引擎 resumeInfo **不需要改**（resumeSubagents 字段原样保留，分流发生在 initState 内部），引擎改动面缩小到零。
- 已知微差：resume 段经 startNode 会 `visitCount+1`（现有 resumePendingResumes 不递增）。仅影响 `state.visitCounts` 计数、不影响段快照（段沿用原 executed 的 visitCount）与循环 break（checkLoopBreak 只读循环节点计数，resume 段均为命令节点），**无害**，文档化即可。

### 4. 崩溃窗口丢 next（严重）——**真；结论 = 方案 a + 方案 b 组合**

**证据**：completeAfterFinalize L1195 persist 在 L1196 enqueue **之前**；processRoutingNode L744 persist 在 L746 push **之前**。崩溃于两者之间 → 快照含 completed 段但 pendingQueue 不含刚算出的 next。现有兜底：workflow-engine resumeInfo L1838-1849 无活跃段且有已完成 Step 且 pendingQueue 空时返回 `{completedSteps, resumeBetweenSteps: true}` → execute L439-452 反推 DAG next 播种。计划 3.9 删除该反推 + 3.8 删 pendingBetweenSteps 后：此窗口恢复时 completedSteps 非空、pendingQueue 空、无活跃段 → resumeInfo 若返回 undefined → 引擎从首步重跑已完成 Step（非恰好一次语义破坏）。**该反推不是可删的「简化」，而是缺陷 9 G 专项补的兜底，且兜的不止 enqueue 窗口**：
- 路由节点崩溃窗口（crash 于 executedSteps.push 与 persist 之间，routingEntry 与 nexts 双失）→ 只能靠反推从最后一个 completed 段续出 nexts；
- 「全部 Step 已完成的收尾窗口」（末步 P3 persist 后、Stage 收尾前崩溃）→ 反推得空 → execute L447-450 标 completed，Stage 正常推进（engine 测试 L3715-3739「resumes a between-steps crash without re-running the completed step」与 stage-executor.spec L304-344「resumeBetweenSteps 反推」直接依赖此路径）。

**结论**：a) **enqueue 先于 P3 persist**（交换 L1195/L1196 顺序，单次 persist 快照即含新 nexts，闭合 enqueue 窗口，且避免「enqueue 另起一次 persist」的双写）；b) **保留 between-steps 反推兜底**（resumeInfo 分支 2 与 pendingBetweenSteps 不删，仅作为 pendingQueue 空时的 fallback，实际触发频率在 a) 之后大幅下降）。不接受 c（丢语义）。计划 3.9 的「删反推」**否决**。

### 5. runLoop 正常结束 status——**真，缺「续跑入口重置」与「循环末兜底」两个配套**

**证据**：initState 正常路径 L532 初始 `status='completed'`，恰好可用；resume 路径 L501 初始 `status='running'`；ask 中断 runPhaseA L1023 写 `status='interacting'`、pause 写 `status='paused'`（L832）。现有模型靠 completeAfterFinalize L1197 **无条件** completed 写把续跑后的状态刷回 completed（resumePendingAsk L1402/L1422 只重置 `executed.status`，不重置 state.status——**现有模型隐式依赖无条件写**）。第 1 项条件化之后，若不配套，续跑入口 status 仍是 interacting/paused → 条件写被拦 → runLoop 一进即断 → 卡死。

**解法**（三件套）：
1. execute() 中 pendingPaused / pendingAsk 续跑入口**先重置 `state.status='running'` + `commitState({status:'running'})`**（resumePendingPaused / resumePendingAsk 调用前）。
2. runLoop 末尾兜底：`if (!isTerminalState(state)) { state.status='completed'; commitState?.({status:'completed'}); }`（覆盖空队列 resume、反向推导空 next 等边缘）。
3. 第 1 项条件写在续跑重置后即恢复语义：续跑 → 'running' → 完成 → 条件写 'completed' ✅；重问/再暂停 → 终态写 ✅。
   （另：反推空 next 分支 execute L447-450 现有 `state.status='completed'` 保留，见 4.7。）

### 6. 路由节点并发（严重）——**真；且比计划描述的更严重（还需 quiescent barrier）**

**证据**：计划 3.3 代码 `while (pendingQueue.length > 0) startNode(shift())` 一次拉光全部且路由分支无 await → 多路由并发 → `processRoutingNode` L714 的 `resolveNextNodes` 并发 → step-navigator L186-200/L217-218 的 `pushActiveLoop`/`popActiveLoop`/`incrementLoopIteration` 在共享 `loopManager.state.activeLoopStack` 上交错，栈状态破坏（现有模型 L631-633 注释即声明路由必须串行）。现有模型路由只在批边界（Promise.all 之后）执行，**路由 resolveNextNodes 从不与命令节点 Phase D resolveNextNodes 重叠**（L631-641 先路由后命令；命令产出的 next 只进 nextBatch 下一轮）。

**计划未覆盖的新竞态（本轮审查最重要的新发现）**：新模型下命令节点完成即 enqueue next，其 next 含路由节点时，drain 会在**其他命令仍在飞**时立即路由——比现有模型多出两类重叠：
- **路由节点 vs 命令 Phase D**：并发 resolveNextNodes 破坏 loopManager 栈；
- **循环门提前路由导致迭代语义破坏**：并行循环体（body 内并行分支汇聚回循环门）中，分支 b1 完成 → 循环门入队 → 立即路由 → continue 开启下一迭代并 spawn 新 body 段，而此时同迭代的 b2 仍在飞 → 同一循环门被 b2 完成再次入队 → visitCount 超前递增 → `visitCount >= maxIterations` 提前 break → exitTo 推进 Stage 时**仍有 body 段在飞**（灾难性）。现有模型 Promise.all 天然是 barrier，循环门只在全部兄弟落地后路由。

**解法（明确方案）**：**quiescent routing barrier + 串行路由 + peek-and-stop drain**。drain 循环对队首节点 **peek**：
```
while (state.pendingQueue.length > 0) {
  const nodeId = state.pendingQueue[0]!;
  const step = state.stepIndex.get(nodeId);
  if (step === undefined) { state.pendingQueue.shift(); continue; }   // 跨 Stage 目标：引擎 tryAdvanceStage 承接（同现有 L613-615）
  const isRouting = step.command === undefined && step.branches !== undefined;
  if (isRouting && running.size > 0) break;   // ← quiescent barrier：路由等待在飞命令全部落地
  state.pendingQueue.shift();
  visitCounts[nodeId] = (visitCounts[nodeId] ?? 0) + 1;   // 单一递增点（对齐现有 L617）
  loopManager.recordScopeVisit(nodeId);                    // 对齐现有 L618
  if (isRouting) {
    await this.processRoutingNode(nodeId, step, state);    // 串行（barrier 满足时才执行）
    if (this.isTerminalState(state)) break;
  } else {
    const p = this.startNode(nodeId, step, state);
    running.set(nodeId, p.then(outcome => { running.delete(nodeId); terminalPriority = this.recordTerminal(terminalPriority, outcome); return outcome; }));
  }
}
```
- **barrier 的正确性**：路由只在 `running.size === 0` 时执行 → 路由 resolveNextNodes 永不与命令 Phase D 重叠（命令 Phase D 在命令「在飞」期间发生）→ 第 6 项的两类新竞态一并消灭；循环门只在当前迭代全部命令落地后路由 → 迭代语义与现有模型完全一致。
- **peek-and-stop 优于「暂存数组」**：路由节点留在 pendingQueue 中不被 shift，终止态 break 时**不会丢节点**（无需 re-queue），持久化快照天然含它（见第 7 项时序），visitCount 也不会因「拉出又放回」重复递增。
- 吞吐影响可忽略：路由只会在「有命令在飞且队首是路由」时等待 race 唤醒，与现有批模型的等待粒度一致；命令节点的 eager 拉起（重构的核心收益：线性链不必等兄弟完成）不受影响。
- `processCommandNodeWithLimiter` 删除后，limiter 移入 startNode；保留 **acquire 后**的 `isTerminalState` 二次检查（limiter 等待窗口内可能已有终态，对齐现有 L695），acquire 前检查在新模型 sync-drain 下不可达，可留可删（建议留，成本为零）。

### 7. enqueue 与 race 时序——**真（结论正确，需满足两个前提）**

**证据与推演**：
- 「enqueue 在 await 链内先于 .then」成立：completeAfterFinalize 的 enqueue（原 L1196）在节点 promise resolve 之前同步完成；`.then`（registered 先于 `await Promise.race`）的 cleanup 微任务先于 race 的 continuation 执行 → race 唤醒时 running Map 已删除胜者、pendingQueue 已含其 next → 下一轮 drain 拉走 ✅ 无丢节点。
- 「runningPromises 空但 pendingQueue 刚有值被 break 漏掉」**不会发生**，前提是 break 检查在 drain **之后**且同时看两者：`if (running.size === 0) { if (state.pendingQueue.length === 0) break; continue; }`（drain 先执行 → pendingQueue 有值则被拉走并 spawn 新 running）。若按计划原文「先查 running 再 drain」则会漏——实施时务必按本文件结构。
- **peek-and-stop 下追加保证**：路由节点不被 shift → 终态 break 后仍留在 pendingQueue → ask/pause 续跑重拉 ✅、failed 落盘快照含它 ✅（最后一段 persist 的 pendingQueue 参数来自 `state.pendingQueue`，未 shift 即含）。

### 8. 计划测试影响表（8 项）核对——**全部存在，位置核实如下；影响评估大体正确但需修正 1 处**

| 计划条目 | 实际位置 | 新模型影响 |
|---|---|---|
| parallel branches execute concurrently | stage-executor.spec L684-705 | ✅ 通过（router 先路由 → [a,b] 并发 spawn，maxActive≥2）；无需改 |
| maxConcurrentSteps limits concurrency | stage-executor.spec L708-731 | ✅ 通过（limiter 移入 startNode，行为等价）；无需改 |
| serial regression | stage-executor.spec L734-758 | ✅ 通过（max=1 串行，FIFO 队列保序）；无需改 |
| nested loop visitCount resets | stage-executor.spec L761-794 | ✅ 通过（**依赖 quiescent barrier**：循环门在 quiescent 时路由，迭代串行）；不改但需 barrier 保障 |
| resumeFrom 从指定子代理 Step 播种 | stage-executor.spec L257-302 | ✅ 通过（resumeSegments 分流）；**需新增混合播种（resumeSubagents + pendingQueue）用例** |
| resumeBetweenSteps 反推 | stage-executor.spec L304-344 | ⚠️ **计划删反推会导致此测试失败**——按第 4 项结论保留反推 → 通过且不改 |
| multiple agent subagents run concurrently | stage-executor.spec L823-853 | ✅ 通过（eager spawn）；无需改 |
| 5 阶段收尾 | stage-executor.spec L857-941（ask 保底 / shell 跳过）+ workflow-engine.spec L2682（ask 后重跑门禁）、L2939（ask 轮次上限）、L2721（phase 事件） | ✅ 通过（依赖第 5 项的续跑入口 status 重置 + 条件写） |

另有直接相关的引擎测试：workflow-engine.spec L1628「keeps the first step completed when the second step fails」（正是第 1 项竞态的场景——新模型条件写保证通过）、L3715「defect 9 G」（依赖保留反推）、L3791「multi-running recovery」（快照 L3882 `pendingQueue: ['step-end']` + 两个 running 段 → resumeSegments 分流路径，✅ 通过）。lifecycle-manager.spec 的 pause/resume 测试（L217/L365/L563 等）与 e2e（L122 收尾流转、L198 门禁失败）走引擎级流程，暂停/门禁路径本重构不改，✅。

### 9. 其他遗漏（逐条核验）

- **visitCount 递增点**：✅ 计划与现有一致。现有 L617 对路由/命令统一 +1；新模型在 drain 的 shift 后 +1，路由/命令统一，且**只在真正处理时递增**（peek-and-stop 保证不重复）。回边/checkLoopBreak 只读（loop-manager L192-200 注释、step-navigator L169-181）✅。
- **recordScopeVisit 位置**：✅ 紧随递增（对齐 L618），同步操作无交错风险。
- **limiter acquire 阻塞 drain？**：✅ 不阻塞——startNode 同步返回 promise，acquire 在异步体内执行；多节点排队 acquire 与现有 Promise.all 语义一致。
- **UnlimitedLimiter 语义**：✅ concurrency-limiter L27-34 立即返回；maxConcurrentSteps=0 即无上限（L68-70）。
- **isTerminalState 位置**：✅ loop 顶检查 + 路由 await 后防御检查 + startNode acquire 后检查（对齐现有 L686/L695 双检查）；「已 running 节点内部是否查终止态跳过 enqueue」——**不跳过**（见下条）。
- **终止态 break 后 in-flight 节点**：allSettled 等待其落地（P3/failed persist 完成，executedSteps 完整）。其 completeAfterFinalize 的 **enqueue 保持无条件**（ask/paused 续跑必须重拉这些 next——现有模型靠 nextBatch 残留 + execute L596-600 晋升提供同等语义；failed 时残留 nexts 是已完成段的合法后继，重试 resumeFrom 重跑它们 DAG 一致）；**status 写条件化**（第 1 项）。
- **errorDetail 并发写**：✅ last-write-wins，仅失败路径写；与现有模型一致，可接受。
- **buildResult 依赖 status**：✅ 由循环末兜底 + 终态 re-assert 保证最终值正确。
- **StageExecutorResume 与 schema 兼容**：✅ schema L495 `pendingQueue: z.array(z.string()).default([])`；StageExecutorResume.pendingQueue `readonly string[]`（L150），兼容，无需迁移。
- **onPersist 签名**：✅ L96 `(executedStep, pendingQueue?)` 不变；引擎侧 L1271-1296 不变（pendingQueue 写 L1286 已有）。

---

## 二、审查补充的新缺漏（计划未覆盖）

- **G10（严重）循环门 quiescent barrier**：见第 6 项——并行循环体 + eager enqueue 会导致循环门提前路由、迭代语义破坏、Stage 在 body 段在飞时推进。**必须**以 quiescent barrier 解决（peek-and-stop）。这是原计划最大的结构性缺口。
- **G11 终止态优先级 re-assert（failed > paused > ask）**：现有模型聚合 L647-663 保证 failed 优先；新模型终态互覆为 last-write-wins——并发「A 失败、B 暂停」时最终可能落 paused（引擎会等待 resume 而吞掉失败）。runLoop 末尾按 `terminalPriority` 重断言（见 4.4）。同时**顺带修复**现有模型聚合不调 commitState 的中间态漂移。
- **G12 反推兜底不可删**：见第 4 项，已并入结论。
- **G13（预存、非回归）命令 Phase D resolveNextNodes 并发**：同一批两个命令节点并发进 Phase D，`incrementLoopIteration`（step-navigator L198）可双计导致循环提前 break。**现有模型已存在**（Promise.all 下 Phase D 并发），quiescent barrier 只挡「路由 vs Phase D」不挡「Phase D vs Phase D」。本重构不引入、不放大（命令并发度不变）；建议**后续**用 per-executor resolveNextNodes 互斥锁（`withRouting` 链式 promise）一并修复，本轮不做（避免扩大改动面）。
- **G14 计划「enqueue（去重 + persist）」表述不成立**：onPersist 需要 executedStep 参数（L96），纯 enqueue 无法单独 persist；且会造成每节点双 persist。改为 **enqueue = 纯去重 push；persist 保持在完成点、顺序调整为先 push 后 persist**（单次 persist 同时携带段与 pendingQueue 快照）。
- **G15 基准引擎不可核验**：本工作区与 deepseek-harness checkout 均无「基准 processNode/pendingQueue+Promise.race」源码（harness 内 grep 无命中），对齐声明仅存在于注释（L575/L114 等）。本方案的正确性论证独立成立，不依赖基准；若基准存在差异（尤其 barrier 处理），需以本文件为准回归。
- **G16 resume 段 visitCount+1**：见第 3 项，文档化即可。

---

## 三、完善后的完整实施方案

### 3.1 StageRunState 最终字段（stage-executor.ts L321-363 替换）

```ts
interface StageRunState {
  readonly stepIndex: Map<string, MergedStep>;
  readonly executedSteps: ExecutedStepDefault[];
  readonly previousOutputs: PreviousStepOutput[];
  readonly passThroughVars: Record<string, PassThroughVarValue>;
  /** ready 节点队列（FIFO；去重由 enqueue 保证）。取代 batch/batchIndex/nextBatch。 */
  pendingQueue: string[];
  status: StepStatus;
  errorDetail: string | undefined;
  pendingAsk: { nodeId; step; executed; rounds } | undefined;      // 保留
  pendingPaused: { nodeId; step; executed; childId } | undefined;  // 保留
  /** resume 分流表：nodeId → 既有执行段 + childId（initState 从 resumeSubagents 播种）。取代 pendingResumes。 */
  resumeSegments: Map<string, { executed: ExecutedStepDefault; childId: string }>;
  /** between-steps 反推兜底（缺陷 9 G，保留不删）。 */
  pendingBetweenSteps: boolean;
}
```
删除：`batch`、`batchIndex`、`nextBatch`、`pendingResumes`。

### 3.2 runLoop 最终形态（替换 L592-670）

```ts
type Outcome = 'ok' | 'ask' | 'failed' | 'paused' | 'skipped';
type TerminalKind = 'failed' | 'paused' | 'interacting';

private async runLoop(state: StageRunState): Promise<void> {
  const { visitCounts, loopManager } = this.options;
  const running = new Map<string, Promise<Outcome>>();
  let terminalPriority: TerminalKind | undefined;

  while (true) {
    if (this.isTerminalState(state)) break;

    // drain：拉起 pendingQueue；路由节点仅 quiescent（running.size===0）时串行处理
    while (state.pendingQueue.length > 0) {
      const nodeId = state.pendingQueue[0]!;              // peek，不 shift
      const step = state.stepIndex.get(nodeId);
      if (step === undefined) { state.pendingQueue.shift(); continue; }  // 跨 Stage 目标：引擎承接
      const isRoutingNode = step.command === undefined && step.branches !== undefined;
      if (isRoutingNode && running.size > 0) break;        // ← quiescent barrier（G10/第6项）
      state.pendingQueue.shift();
      visitCounts[nodeId] = (visitCounts[nodeId] ?? 0) + 1; // 单一递增点
      loopManager.recordScopeVisit(nodeId);
      if (isRoutingNode) {
        await this.processRoutingNode(nodeId, step, state); // 串行（barrier 满足时）
        if (this.isTerminalState(state)) break;
      } else {
        const p = this.startNode(nodeId, step, state);      // limiter 在 startNode 内
        running.set(nodeId, p.then(outcome => {
          running.delete(nodeId);
          terminalPriority = this.recordTerminal(terminalPriority, outcome);
          return outcome;
        }));
      }
    }

    if (running.size === 0) {
      if (state.pendingQueue.length === 0) break;
      continue;   // 仅剩路由节点且无在飞命令 → 下轮直接路由
    }
    await Promise.race(running.values());   // running 非空才 race（race 空集永不 settle）
  }

  // 终止态收尾：等全部在飞节点落地（P3/failed persist 完成），再按优先级断言终态（G11）
  await Promise.allSettled(running.values());
  if (terminalPriority !== undefined) {
    if (state.status !== terminalPriority) {
      state.status = terminalPriority;
      this.options.commitState?.({ status: terminalPriority });
    }
  } else if (!this.isTerminalState(state)) {
    state.status = 'completed';             // 循环末兜底（第5项）
    this.options.commitState?.({ status: 'completed' });
  }
}

private recordTerminal(priority: TerminalKind | undefined, outcome: Outcome): TerminalKind | undefined {
  const kind = outcome === 'failed' ? 'failed' : outcome === 'paused' ? 'paused' : outcome === 'ask' ? 'interacting' : undefined;
  if (kind === undefined) return priority;
  const order: Record<TerminalKind, number> = { failed: 0, paused: 1, interacting: 2 };
  return priority === undefined || order[kind] < order[priority] ? kind : priority;   // failed > paused > ask
}
```

### 3.3 startNode（取代 processCommandNodeWithLimiter L679-704；resume 分流，第 3 项）

```ts
private async startNode(nodeId: string, step: WorkflowStep, state: StageRunState): Promise<Outcome> {
  const resume = state.resumeSegments.get(nodeId);          // resume 分流
  if (resume !== undefined) {
    state.resumeSegments.delete(nodeId);
    return this.resumeSubagentStep(state, nodeId, step, resume.executed, resume.childId);  // 不 acquire limiter（对齐现状）
  }
  const limiter = this.options.concurrencyLimiter;
  if (limiter !== undefined) await limiter.acquire();
  try {
    if (this.isTerminalState(state)) return 'skipped';      // acquire 后检查（limiter 等待窗口，对齐 L695）
    return await this.processCommandNode(nodeId, step, state);
  } finally {
    limiter?.release();
  }
}
```

### 3.4 enqueue 与 persist 顺序（第 4/7 项；enqueue = 纯去重 push，persist 在 push 之后单次完成）

```ts
private enqueue(ids: readonly string[], state: StageRunState): void {
  for (const id of ids) {
    if (!state.pendingQueue.includes(id)) state.pendingQueue.push(id);   // 去重（O(n)，队列小；量大可加 Set 镜像）
  }
}

private async persist(executed: ExecutedStepDefault, state: StageRunState): Promise<void> {
  const pendingQueue = [...state.pendingQueue];             // 取代 L1455 的 [...new Set([...batch, ...nextBatch])]
  await this.options.onPersist?.(executed, pendingQueue);
}
```
- `completeAfterFinalize`（L1195-1198 替换为）：
```ts
executed.status = 'completed';
executed.updatedAt = now();
this.enqueue(routed.nextNodeIds, state);                    // 先入队（崩溃窗口闭合）
await this.persist(executed, state);                        // P3 快照含新 nexts（单次 persist）
if (!this.isTerminalState(state)) {                          // 条件写（第1/2项）
  state.status = 'completed';
  this.options.commitState?.({ status: 'completed' });
}
return 'ok';
```
- `processRoutingNode`（L743-746 替换为）：`state.executedSteps.push(routingEntry); this.enqueue(routed.nextNodeIds, state); await this.persist(routingEntry, state);`（同序闭合路由窗口）。
- processCommandNode 内部失败路径（L792-794、L849-851）与 runPhaseC 失败路径（L1132-1134）**保持无条件终态写**。

### 3.5 execute / initState 最终形态

```ts
async execute(): Promise<StageExecutionResult> {
  let state = this.runState;
  if (state === undefined) { state = await this.initState(); this.runState = state; }
  if (state.pendingPaused !== undefined) {
    state.status = 'running'; this.options.commitState?.({ status: 'running' });   // 续跑入口重置（第5项）
    const resumed = await this.resumePendingPaused(state);
    if (resumed !== 'ok') return await this.buildResult(state);
  }
  if (state.pendingAsk !== undefined) {
    state.status = 'running'; this.options.commitState?.({ status: 'running' });
    const resumed = await this.resumePendingAsk(state);
    if (resumed !== 'ok') return await this.buildResult(state);
  }
  // 删 pendingResumes 分支（并入 runLoop）；保留 pendingBetweenSteps 反推（第4项结论）：
  if (state.pendingBetweenSteps) {
    state.pendingBetweenSteps = false;
    const lastNodeId = state.executedSteps[state.executedSteps.length - 1]?.stepId;
    if (lastNodeId !== undefined) {
      const routed = await this.options.stepNavigator.resolveNextNodes(lastNodeId, this.buildContext(state));
      this.enqueue(routed.nextNodeIds, state);               // 取代 L445 的 batch 赋值
      if (state.pendingQueue.length === 0) state.status = 'completed';   // 保留 L447-450
    }
  }
  await this.runLoop(state);
  return await this.buildResult(state);
}
```

initState resumeFrom 分支（L480-518 替换）：
```ts
const { completedSteps, resumeSubagents, resumeBetweenSteps, pendingQueue } = resumeFrom;
const artifactsPerStep = await Promise.all(/* 同 L484-486 */);
const segments = new Map<string, { executed: ExecutedStepDefault; childId: string }>();
const initialQueue: string[] = [];
for (const rs of resumeSubagents ?? []) {                    // resume 段优先入队
  segments.set(rs.step.id, { executed: rs.executed, childId: rs.childId });
  initialQueue.push(rs.step.id);
}
const seen = new Set(initialQueue);
for (const id of pendingQueue ?? []) {                        // 快照 pendingQueue 去重追加入队（防含 running 节点）
  if (!segments.has(id) && !seen.has(id)) { seen.add(id); initialQueue.push(id); }
}
return {
  stepIndex, executedSteps: [...completedSteps], previousOutputs: /* 同 L494-496 */, passThroughVars,
  pendingQueue: initialQueue,
  status: 'running', errorDetail: undefined,
  pendingAsk: undefined, pendingPaused: undefined,
  resumeSegments: segments,
  pendingBetweenSteps: resumeBetweenSteps === true && (pendingQueue === undefined || pendingQueue.length === 0) && segments.size === 0,
};
```
正常分支（L519-538）：`pendingQueue: firstStep === undefined ? [] : [firstStep.id]`，其余不变（status 初始 'completed'）。

### 3.6 workflow-engine.resumeInfo 最终形态（**不改**）

- 三分支（L1796-1859）与 `StageExecutorResume` 类型（L127-151）**原样保留**：branch 2 的空 pendingQueue 分支（L1845-1848 `resumeBetweenSteps: true`）是缺陷 9 G 兜底，不得删除（第 4 项）。resumeSubagents → resumeSegments 的映射在 initState 内部完成，引擎零改动。
- onPersist（L1271-1296）不变（pendingQueue 落盘 L1286 已就绪）。
- 方案原文 3.9 的「删 between-steps 反推分支 / 简化 resumeInfo」**否决**；3.8 的「删 pendingBetweenSteps」**否决**。

### 3.7 status 写入策略汇总（第 1/2/5/G11 项）

| 写入点 | 策略 |
|---|---|
| completeAfterFinalize completed 写（L1197-1198） | **条件写**：`!isTerminalState(state)` 才设 completed + commitState |
| processCommandNode 失败/暂停写（L792-794、L832-834、L849-851）、runPhaseC 失败写（L1132-1134）、resumeSubagentStep 失败/暂停写（L1328-1330、L1345-1347、L1360-1362） | 无条件终态写（last-write-wins，failed/paused/interacting 永不被 completed 覆盖） |
| runPhaseA ask 写（L1023-1024） | 不变（interacting + pendingAsk + commitState） |
| execute 续跑入口（pendingPaused/pendingAsk 前） | **重置 'running' + commitState** |
| runLoop 末尾 | terminalPriority re-assert（failed > paused > ask）；否则非终止态 → completed（兜底） |

### 3.8 测试适配清单

**不改即通过**：stage-executor.spec L684（parallel）、L708（maxConcurrent）、L734（serial）、L761（nested loop，依赖 barrier）、L823（multi-agent）、L857/L907（5 阶段收尾）；workflow-engine.spec L1628（首步 completed 次步 failed）、L2682（ask 后重跑门禁）、L2939（ask 轮次）、L3715（defect 9 G，依赖保留反推）、L3791（multi-running）；lifecycle-manager.spec 全部；e2e 两条。

**保留不删（计划误判）**：stage-executor.spec L304（resumeBetweenSteps 反推）、L257（resumeFrom 播种——改为验证 resumeSegments 分流后语义不变）。

**新增单测（AGENTS.md 要求功能点配套）**：
1. 并发完成/失败 status 竞态：并行分支一完成一失败 → 最终 failed（条件写验证）。
2. 循环门 barrier：循环体内并行分支汇聚回循环门 → 不提前路由、迭代次数正确、无 body 段在飞（G10）。
3. persist 顺序：完成节点 persist 快照含其 nexts（enqueue 先于 P3）。
4. resume 混合播种：resumeSubagents + pendingQueue 同时播种 → 段走 resumeSegments、快照节点正常拉起、去重生效。
5. 终态优先级：并发 failed + paused → 最终 failed（G11 re-assert）。
6. resume 空队列：resumeFrom 仅 completedSteps（无段无 pendingQueue，反推空 next）→ status='completed'（循环末兜底）。
7. limiter 等待窗口终态跳过：acquire 期间另一节点失败 → acquire 后返回 'skipped' 不执行。

**实施顺序建议**：① StageRunState 字段替换 → ② initState/execute 形态 → ③ runLoop（barrier + race）→ ④ startNode/enqueue/persist 顺序与条件写 → ⑤ 续跑入口重置 + 循环末兜底 + re-assert → ⑥ 跑全套测试并补新增用例。
