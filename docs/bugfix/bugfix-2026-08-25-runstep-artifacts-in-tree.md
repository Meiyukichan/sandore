# 运行中实例导航树不显示已完成 Step 产物（实例 2eccdc8f / wfl-2dcf2ae6）——修复影响面核实与计划

> **日期**：2026-08-25
> **来源**：运行中实例（status=interacting，loop step 在 ask-detect 等待）核实：sce1 已 completed 且实际产出 `artifacts/book-management/proposal.md`（子代理会话消息与门禁均证实），但导航树 sce1 下看不到产物。
> **类型**：UI 数据源缺陷 + 引擎快照缺字段（影响真实场景）
> **性质**：本文档为**核实产出**（证据到 文件:行），**未修改任何源码**（sandore 与 DSH 均只读）。

---

## 一、根因核实（与拟修复方案一致）

**导航树产物只从 `state.stageContracts[].artifacts` 取**（`run-view-model.ts` L381/L413-428）；而 stage 契约**只在 Stage 完成时生成**：

- `finalizeStageContract`（`microflow/stage-executor.ts` L262-301）逐 executedStep 调 `collectStepArtifacts`（L276）组装 `StageContract.artifacts`；
- 引擎只在 Stage 结束时写入 `stageContracts`：`workflow-engine.ts` L1430（completed）/ L1453（failed），并 `persistState`（L1437/L1462）；
- **实例运行中 `stageContracts: {}` 为空**（`workflow-engine.ts` L262 初始值）→ 已完成的 Step 产物无处展示。✅ 根因成立。

引擎在**每个 step 收尾路径**其实已通过 `buildFinalizeContext`（`stage-executor.ts` L927-942）收集实际产物（L936，缺陷 16/34：透传变量替换 + 相对转绝对 + regex/glob），但结果只进 `FinalizeStepContext.artifacts`（prompt 上下文），**未写入 executed 段快照** → 运行中 UI 不可见。✅ 拟修复方向正确。

---

## 二、影响面清单

### 2.1 引擎写入点：buildFinalizeContext 覆盖所有「会产出产物的 step 完成路径」

`buildFinalizeContext`（`stage-executor.ts` L927-942）定义：L936 调
`collectStepArtifacts(this.options.ctx.fs, step, this.options.sharedState.cwd, toVarMap(state.passThroughVars))`，
`flatMap(a => a.value)` 得 `string[]`（进程绝对路径，见 2.6）。

**全部调用点（共 3 处，均在产物 step 完成路径上）**：

| 路径 | 调用点 | 是否过 finishCommandNode | 产物收集时机 |
|---|---|---|---|
| 命令节点首次完成（含 agent/skill/mcp/prompt/shell） | `finishCommandNode` L909（**Phase A 之前、isShellStep 判断 L913 之前**） | —（即本身） | ✅ 正常完成（runPhasesBC）、ask 中断（L916-918 返回 'ask'）、门禁失败（runPhaseC L962-964）均在收集之后 |
| shell step | 同上 L909（L913 才跳过 Phase A） | — | ✅ shell 同样先收集（outputTo 对 shell 有效） |
| ask 回复续跑（真实子代理） | `resumePendingAsk` L1389 | **否**（L1377 重收集输出后直接调 buildFinalizeContext → runPhaseA → runPhasesBC） | ✅ |
| ask 回复续跑（shell/合成会话） | `resumePendingAsk` L1404 | 否（直接 buildFinalizeContext → runPhasesBC） | ✅ |
| 暂停续跑 / between-steps 崩溃续跑 | `resumePendingPaused` L1289 → `resumeSubagentStep` L1315 → `finishCommandNode` L909 | 是 | ✅ |
| 崩溃恢复续跑（resumeSegments 分流） | `startNode` L690 → `resumeSubagentStep` → `finishCommandNode` | 是 | ✅ |
| **routing 节点**（无 command，仅 branches/loop） | `processRoutingNode` L715-755 **不调用** finishCommandNode/buildFinalizeContext | 否 | 自建 routingEntry（L731-745，无 `outputTo`）→ 无 artifacts ✅ |

**关键结论**：`resumePendingAsk` **不走** finishCommandNode（任务描述里 L1315 是 `resumeSubagentStep` 的调用点，resumePendingAsk 在 L1389/L1404 直调 buildFinalizeContext）。因此**写入 `executed.artifacts` 必须放在 `buildFinalizeContext` 内部**（或紧随其全部 3 个调用点），仅放在 finishCommandNode 会漏掉 ask 续跑路径。

失败路径说明：`runner.run` 抛错（L826-861）时 buildFinalizeContext 未执行 → 段无 artifacts（合理：无产出可展示）；门禁失败（L1132-1144）时 L909 已收集 → 段带 artifacts（收尾收集即最终判定）。

### 2.2 persist 时序：写入 executed.artifacts 后各路径均落盘，无时序丢失

`persist(executed, state)`（`stage-executor.ts` L1447-1450）→ `options.onPersist`（`workflow-engine.ts` L1260-1285）：按**执行段 id upsert** 进 `active.state.executedSteps`（L1267-1277）→ `await this.persistState(active)`（L1284）→ `ReactiveState.flush`（L2005-2008；L1652-1662 → `saveWorkflowState` → `state.put(taskId, state)`，`persistence.ts` L54-56）→ 落盘。

| 路径 | 落盘点 | artifacts 是否在快照中 |
|---|---|---|
| ask 中断 | `runPhaseA` L1029 `persist(executed, state)`（**buildFinalizeContext L909 已执行**）→ onPersist 落盘；引擎随后 L1295-1297 markStageStatus('interacting') + persistState（二次幂等落盘） | ✅ 两次落盘均含 |
| 正常完成 | `completeAfterFinalize` L1205 `persist`（P3 completed） | ✅ |
| ask 续跑真实子代理 | L1387 persist（此刻 artifacts 为**上次收尾旧值**）→ L1389 重新收集更新 → 终态 persist（再 ask 走 L1029 / 完成走 L1205） | ✅ 终态为最新值（中间快照短暂旧值，可接受） |
| 暂停续跑 | `resumePendingPaused` L1288 persist（`...rest` 继承旧段字段，含旧 artifacts）→ finishCommandNode 重新收集 → 终态 persist | ✅ 终态为最新值 |

**崩溃恢复边界**：`initState` resumeFrom 播种 `executedSteps: [...completedSteps]`（L509）原样保留 artifacts（若快照为修复后产生）；**DSH storage-domain 读表时 `valueSchema.parse(raw)`**（`deepseek-harness/packages/storage/storage-domain/src/index.ts` L121）会**剥离未声明字段** → schema 必须声明 artifacts，否则进程重启后读回即丢失（见 2.3）。写路径不受影响（putRecord 直接序列化，domain.ts L307-309）。

### 2.3 schema 位置（两处，均需改）

1. **`packages/sandore/workflow/src/schema.ts`** `ExecutedStepDefaultSchema`（L413-444）：
   在 L443 `output: z.array(ContentBlockSchema).optional(),` 之后、L444 `})` 之前插入：
   ```ts
   artifacts: z.array(z.string()).optional(),
   ```
   optional 不破坏既有 zod 校验：历史实例无该字段通过（optional）；zod 默认非严格（未知键剥离）——**必须声明**，否则字段被剥（见 2.2 崩溃恢复边界）。
2. **`packages/sandore/workflow/src/types.ts`** `ExecutedStepDefault` 接口（L178-209）：
   L208 `output?: ContentBlock[]` 后加：
   ```ts
   /** 本执行段收尾时收集的产物文件（进程绝对路径；可选，旧实例/路由段/失败段无）。 */
   artifacts?: string[]
   ```
   引擎写 `executed.artifacts` 需要该类型。

**UI 类型自动获得**：UI 侧 `ExecutedStep = WorkflowTaskState['executedSteps'][number]`（`run-view-model.ts` L24，派生自 schema）→ schema 声明后无需单独改 UI 类型。

### 2.4 UI：buildRunTree 段快照优先 + stageContracts 回退

现状（`run-view-model.ts` buildRunTree L396-480）：
- result 按执行段 id 挂（L398-410，`resultByExecId`）；
- artifact 从 stageContracts 收集、按 `artifact.stepId` 归并（L413-428，`artifactByStepId`）；
- `lastSegmentByStepId`（L430-433）记录每 stepId 最后段；L447 产物**只挂该 stepId 最后一段**（stage 契约无执行段 id，无法按段区分）。

改法（最小改动）：
1. 新增 `artifactByExecId`：遍历 `state.executedSteps`，对 `step.artifacts !== undefined` 的段生成 artifact 叶子（`id: ${step.id}:file:${file}`、`name/text: file`、`type:'artifact'`、`stepId: stepIdOf(step)`；`meta` 为可选，段快照无 outputToId，可省略或置 undefined——`RunTreeNode.meta?: string` L194）。
2. 构建 step 子节点（L444-448）改为：
   ```ts
   const segArtifacts = artifactByExecId.get(step.id)
   const children = [
     ...(resultByExecId.get(step.id) ?? []),
     // 段快照优先（运行中即可见）；无段快照（旧实例/路由段）回退 stageContracts 挂最后段（现状）
     ...(segArtifacts !== undefined
       ? segArtifacts
       : lastSegmentByStepId.get(key) === step.id ? (artifactByStepId.get(key) ?? []) : []),
   ]
   ```
3. stageContracts 收集段（L413-428）**原样保留**作为回退数据源。

兼容性：
- **旧实例（executedSteps 无 artifacts 字段）**：`artifactByExecId` 为空 → 全部回退 → 行为与现状完全一致（产物只挂最后段）✅；
- **运行中新实例**：`getInstanceState` RPC 内存优先（`remote.ts` L276-281 → `workflow-engine.ts` L619-621 直接返回 `active.state`，不过 zod）→ 段快照 artifacts 立即可见 ✅；
- **完成态新实例**：段快照优先后按「段」挂产物（loop 多段各自显示最新文件列表），不再只挂最后段——与 Round 26 ⑤「result 按段挂」哲学一致，属合理行为细化（非回归），在 PR 描述中注明；
- 数据语义一致：`executed.artifacts` 与 `StageContract.artifacts[].files` 出自同一 `collectStepArtifacts`（前者 L936 收 step、后者 L276 收 executed），均为进程绝对路径（见 2.6），UI 只按字符串展示叶子，无需路径转换。

### 2.5 spec 断言影响清单（含改法）

| 文件 | 用例 | 结论 / 改法 |
|---|---|---|
| `ui/.../run-view-model.spec.ts` | L526-568「产物只挂最后段」（L566-567 断言 seg1 无 artifact、seg2 有 `out/proposal.md`） | 构造段**无 artifacts 字段** → 回退 stageContracts → 行为不变，**照常通过** ✅；建议**新增**「段快照优先：带 artifacts 的段直接挂本段」用例 |
| 同上 | L467-524（stageContracts: {} 全空） | 无产物路径，不受影响 ✅ |
| `microflow/.../stage-executor.spec.ts` | 全部 `toEqual`（L482-490/502-503/624-629/1033-1034/1048-1049/1058）均在 contract.files / contractArtifacts / passThroughVars / createSeeds / createMetas / phases 上；`executedSteps` 断言全部字段级（`.status`/`.id`/`.finalizeMeta?.currentPhase`/`.output`/`toHaveLength`） | **无 whole-segment/whole-state 相等断言** → 新增 artifacts 字段不破坏 ✅；建议补充一条「完成段带 `artifacts` 快照」断言 |
| `workflow/.../workflow-engine.spec.ts` | `executedSteps` 断言仅字段级（L1504-1505/1529/2708/2985/3010/3275/3576）；无 whole-state `toEqual` | 不破坏 ✅ |
| `workflow/.../schema.spec.ts` | L135-140 round-trip `restored).toEqual(parsed)`（两侧同 schema，恒等）；L142-153 strip 断言（permissionMode 等，与 artifacts 无关） | 不破坏 ✅；可选加一条「artifacts 字段 round-trip 保留」断言 |
| `workflow/.../remote.spec.ts` / `persistence.spec.ts` / `lifecycle-manager.spec.ts` / `recovery-manager.spec.ts` | fixture 均无 artifacts；getArtifacts（remote.spec L987）只读 stageContracts（本修复不改动） | 不破坏 ✅ |
| `workflow/.../workflow-engine-real-e2e.spec.ts` | L705/L727 仅按 createdAt 排序等字段级断言 | 应不破坏，作全量回归跑一遍 |

### 2.6 其它消费方 / 命名冲突核查

- **命名无冲突**：`ExecutedStepDefault` 现有字段（types.ts L178-209 / schema.ts L413-444）无 `artifacts`；schema 中 `artifacts` 仅存在于 `StageContractSchema`（L458）；全仓 grep 无 `outputFiles` 等同类已写字段 ✅；
- **产物路径语义**：`collectStepArtifacts` 三分支（glob L210 / regex L219 / 字面 L349）均返回 `fs.processPath` 进程绝对路径 → `executed.artifacts` 与契约 files 同语义（测试 fixture 里的相对路径仅为构造数据）；
- **相邻未覆盖面（可选扩展，非本次范围）**：`remote.getArtifacts`（`remote.ts` L429-446）与 `RunView.tsx` L45/L106 的产物面板仍只读 `stageContracts` → 运行中实例在该面板同样不显示产物；如需一并修复，可让 getArtifacts 优先聚合 `executedSteps[].artifacts`（保留契约回退）；
- `finalizeStageContract`（L262-301）不改：完成 Stage 契约仍为权威产物源（含 outputToId 元数据，段快照无），UI 回退路径依赖它。

---

## 三、修正版修复计划

> 原方案方向正确（段快照字段 + UI 双源回退），两处修正：① 写入点必须在 `buildFinalizeContext`（resumePendingAsk 不经过 finishCommandNode）；② schema 与 types.ts **两处**都要声明（DSH 存储域读表 zod parse 会剥离未声明字段）。

### 改动点

1. **`workflow/src/schema.ts`**：`ExecutedStepDefaultSchema` L443 后加 `artifacts: z.array(z.string()).optional(),`。
2. **`workflow/src/types.ts`**：`ExecutedStepDefault` L208 后加 `artifacts?: string[]`。
3. **`microflow/src/stage-executor.ts`** `buildFinalizeContext`（L936 收集之后）：写入段快照。
   ```ts
   const artifacts = (await collectStepArtifacts(...)).flatMap(a => a.value);
   // 段快照写入（修复：运行中 UI 可读段级产物；resumePendingAsk 不经 finishCommandNode，
   // 故写入点必须在此，覆盖全部 3 个调用点）。仅非空时写，保持快照精简。
   if (artifacts.length > 0) {
     executed.artifacts = artifacts;
   }
   ```
   同步更新方法 doc 注释（「组装收尾上下文」→ 增加「并写 executed.artifacts 段快照」）。可选项：无条件写 `executed.artifacts = artifacts`（含空数组），UI 逻辑等价（`segArtifacts !== undefined` 判据不变），按仓库精简快照惯例推荐**仅非空写**。
4. **`ui/src/client/run-view-model.ts`** buildRunTree：新增 `artifactByExecId`（段快照优先），L444-448 子节点组装改为「段快照优先、stageContracts 回退」，stageContracts 收集段保留；更新函数头注释（L379-392）。
5. **测试**：
   - `run-view-model.spec.ts`：新增「段快照优先：段带 artifacts 直接挂本段（运行中实例场景，stageContracts:{}）」用例；既有最后段用例不动（天然验证回退）。
   - `stage-executor.spec.ts`：可选补「完成段含 artifacts 快照」断言（字段级）。
   - `schema.spec.ts`：可选补 artifacts round-trip 断言。

### 验证步骤

1. **单测**：`ui`（run-view-model.spec）、`microflow`（stage-executor.spec）、`workflow`（schema.spec / workflow-engine.spec / remote.spec / persistence.spec）全绿。
2. **构建**：`pnpm build`（lib 变更，需重建受影响包）。
3. **dev 实例手测**（3090 端口，改 sandore 代码后重启 dev 实例即可）：启动 wfl-2dcf2ae6（或等价工作流）→ **sce1 完成后、在 ask 中断（status=interacting，loop step 在 ask-detect 等待）期间**检查导航树 sce1 下**立即出现产物叶子**（`artifacts/book-management/proposal.md` 的进程绝对路径）；回答 ask 续跑后再确认终态树不回归。
4. **历史实例回归**：打开修复前产生的实例（executedSteps 无 artifacts 字段）→ 树行为与修复前一致（产物仍只挂 stepId 最后一段，来自 stageContracts）。
5. **崩溃恢复回归**：运行中中断进程 → `recoverInstance` 恢复 → 确认 executedSteps 段的 `artifacts` 经 DSH 存储域读回**仍保留**（验证 schema 声明生效，未被 zod strip）。
6. **e2e**：workflow-engine-real-e2e.spec 全量跑一遍（若有条件）。

---

## 四、结论

- 根因、引擎写入点、schema 位置、UI 双源回退方案、persist 时序、spec 影响面**全部核实通过**，证据见各节 文件:行。
- 两处必须修正的实现细节：**写入点放 buildFinalizeContext**（resumePendingAsk 不经过 finishCommandNode，L1389/L1404 直调）、**schema 与 types.ts 双声明**（DSH 存储域读表 zod strip）。
- 本次为核实产出，未修改任何源码（sandore 与 DSH 均只读）。

---

## 五、实施记录（2026-08-25，用户报问题后确认实施）

1. **schema.ts**：`ExecutedStepDefaultSchema` 加 `artifacts: z.array(z.string()).optional()`（output 之后）。
2. **types.ts**：`ExecutedStepDefault` 加 `artifacts?: string[]`（与 schema 同步）。
3. **stage-executor.ts**：`buildFinalizeContext`（L926-942）内把 `collectStepArtifacts` 收集结果写入 `executed.artifacts`（>0 时）——覆盖 finishCommandNode / resumeSubagentStep / resumePendingAsk 全部收尾路径（含 ask 中断与 shell），随 onPersist 持久化。
4. **run-view-model.ts `buildRunTree`**：产物数据源改为「**段快照 `executedStep.artifacts` 优先（按执行段挂）**；无段快照（旧数据/历史实例）回退 stageContracts（按 stepId 挂最后一段）」。
5. **spec**：run-view-model.spec 新增「段快照优先 + stageContracts 回退」用例（含两段各挂各的、旧数据回退断言）。
6. **验证**：typecheck ✅ / build ✅ / **793 tests + 1 skipped 全绿** ✅；dev 实例（3090）已重启生效。

