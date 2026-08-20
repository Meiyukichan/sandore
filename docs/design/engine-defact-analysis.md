# sandore vs workflow-lab-3/engine 缺陷逐项判定与修复计划

> **方法**：每项由子代理完成定位分析与源码探索 → 主代理给出存在性结论 → 与用户讨论确认 →
> 子代理将最终结论（存在/不存在 + 具体原因）与修复计划直接写入本文档对应条目。
> **执行节奏**：最初严格串行（一次一个），用户要求提速后改为**并行批处理**（每轮 4-6 个缺陷并行分析 +
> 逐个确认判定 + 单个写入子代理一次性写入该批条目）。
> **状态图例**：⬜ 待分析 / ✅ 已判定（判定类别见各条目「判定」字段：✅ 真实存在 / ⚠️ 部分存在 / ❌ 非缺陷）
> 已全部修复

---

## 缺陷 1：`matchesExpectation` 实现完全不同

- **状态**：✅ 已判定（部分存在，已定修复计划）
- **来源**：engine-defact.md #1（🔴 逻辑错误）
- **报告摘要**：基准为「大小写不敏感 + 包含匹配」；sandore 为「含 regex 元字符时正则匹配，否则大小写敏感精确匹配」。
- **涉及文件**：`microflow/src/branch-evaluator.ts`（matchesExpectation/hasRegexMetacharacters）、`workflow/src/dag-navigator.ts`（decideCondition）、`microflow/src/loop-manager.ts`（decideBreak）、`workflow/src/schema.ts`（DagBranchSchema）、`ui/src/client/FlowEditor.tsx`（UI 缺口）
- **判定**：⚠️ 部分存在
- **原因/结论**：
  1. 报告核心示例（AI 输出 vs expectation）对应的基准 AI 条件分支路径在 sandore 不存在（无 evaluateBranches，条件分支重构为 condition 命令 + 布尔判定）——该部分报告不成立。
  2. 真实分歧在循环跳出 shell 场景（breakCondition shell + breakExpectation 同字段同数据流）：基准大小写不敏感包含 vs sandore 大小写敏感精确/正则，迁移工作流静默分歧。
  3. sandore 当前语义的静默陷阱：regex 元字符启发式误判字面量（版本号 v1.2.3、路径 `\`、100%、括号等）、非法正则静默 false、大小写敏感脆弱；label 兼作显示名与 shell 匹配目标（语义复用歧义）；UI 无 label/breakExpectation 编辑框（FlowEditor 只能手写 YAML 才带这两个字段）；zod 默认剥离未知字段会把基准 YAML 的 branch.expectation 静默丢弃→分支变并行（始终执行）。
  4. 定位说明：sandore 为全新设计，匹配语义有意对齐基准宽松行为。
- **修复计划**（具体、可执行，含文件级改动方向；与缺陷 2/4 分场景字段方案对齐）：
  1. `branch-evaluator.ts` 重写 `matchesExpectation`：
     - 默认路径：`const o = result.trim().toLowerCase(); const e = expectation.trim().toLowerCase(); return o === e || o.includes(e);`（大小写不敏感 + 包含匹配，宽松）。
     - regex 显式化：废除 `hasRegexMetacharacters` 启发式；改为显式定界符（如 expectation 以 `/` 开头结尾 → 视为正则，如 `/build-.*/`；或新增选项 `regex?: boolean`）。带定界符时 `new RegExp(inner)` 匹配（非法正则返回 false），无定界符一律走包含匹配（此时字面量含 `.` 等不会被误判）。
     - 同步更新 `branch-evaluator.spec.ts` 对应用例（精确匹配用例改为包含匹配语义；新增大小写不敏感、包含、显式正则、非法正则用例）。
  2. `loop-manager.ts` `decideBreak`：**shell 分支**保持调用 matchesExpectation，语义随修复自动对齐；补充 shell breakCondition 集成测试（当前无端到端覆盖）。**AI 分支不属本缺陷**——走缺陷 4 的 shouldBreak 专用模板（含 I/O 块 + `{"shouldBreak": true/false}`），与 matchesExpectation 无关。
  3. `dag-navigator.ts` `decideCondition`：**shell 分支**保持传 branch.label 走 matchesExpectation（含 `expectation === undefined → false` 守卫）；**AI 分支**不属本缺陷——走缺陷 2 的 shouldExecute 提取函数（`{"shouldExecute": true/false}`），此处不展开。
  4. schema 静默剥字段问题：`DagBranchSchema` 对基准遗留的未知 `expectation` 字段——在 yaml-parser 转换层显式告警或拒绝（避免静默变并行），或文档明确「迁移时需把 expectation 改写成 condition + label」。此点作为附带建议记录。
  5. UI 缺口（可选，后续）：FlowEditor 增加 label 编辑框（条件分支显示名/匹配目标）与循环 breakExpectation 编辑框；在未提供时给出默认 label 或提示。
  - 每项标注改动文件与方向即可，**不要实际修改代码**（本任务只写文档）。
- **修复计划状态**：待实施（需用户批准后另行执行；与缺陷 2/4 分场景字段方案联动——shell 匹配走本缺陷 matchesExpectation，AI 判定分别走缺陷 2 shouldExecute / 缺陷 4 shouldBreak）

---

## 缺陷 2：`decideCondition` 与 `buildBranchPrompt` 格式不匹配

- **状态**：✅ 已判定（真实存在，已定修复计划）
- **来源**：engine-defact.md #2（🔴 逻辑错误）
- **报告摘要**：AI 条件分支因 `decideCondition` 检查裸 `'true'`，而 `buildBranchPrompt` 要求 `{"shouldExecute": true}` JSON，导致 AI 遵循提示词时条件分支永不通过。
- **涉及文件**：`microflow/src/branch-evaluator.ts`（buildBranchPrompt/collect/extractBreakResult/extractExpectation）、`workflow/src/dag-navigator.ts`（decideCondition）、`microflow/src/loop-manager.ts`（decideBreak）、`workflow/src/workflow-engine.spec.ts`（测试 mock 脱节）、`ui/src/client/DagEditor.tsx`/`FlowEditor.tsx`（UI 可达性）
- **判定**：✅ 真实存在（影响面大于报告）
- **原因/结论**：
  1. **AI 条件分支失败链路**：`buildBranchPrompt`（branch-evaluator.ts L99-126）要求 AI 返回 `{"shouldExecute": true/false}` JSON（L119「请仅返回 JSON」）；而 `decideCondition`（dag-navigator.ts L291-299）AI 分支做裸 `output.trim().toLowerCase() === 'true'`（L298）比较——AI 遵循提示词时条件分支**永不通过**，这是报告发现的核心问题。
  2. **AI 循环跳出字段错配失败链路（报告漏报）**：`decideBreak`（loop-manager.ts L220-228）AI 分支用 `extractBreakResult(output) === 'true'`（L227），但 `extractBreakResult`（branch-evaluator.ts L171-188）解析的是 **shouldBreak** 字段，而循环 breakCondition 与条件分支共用同一 `buildBranchPrompt`（要求 shouldExecute）——字段错配，AI 遵循提示词时**循环永不跳出**，只能靠 maxIterations 硬上限兜底。此影响面大于报告所述。
  3. **根因描述有偏差**：报告指向的 `extractExpectation`（branch-evaluator.ts L149-163）解析的是 branchExpectation（基准遗留语义），且 src 中**零调用（死代码）**——接线也无法修复字段错配，不是根因；真正的根因是「提示词要求的 shouldExecute 与两侧判定侧解析的字段/裸值不一致」。
  4. **shell 路径不受影响**：shell 类型 condition 走 `matchesExpectation`（属缺陷 1 范畴），不受缺陷 2 影响；受影响的仅为 AI 类型 condition（UI 可配 prompt：DagEditor.tsx L553/L641 `conditionTypes=['shell','prompt']`）与 AI 类型 breakCondition（FlowEditor.tsx L211 默认 prompt 类型）。
  5. **测试 mock 与提示词矛盾、掩盖问题**：workflow-engine.spec.ts mock 裸 `'true'`（L940）、`'{"shouldBreak": true}'`（L1077）等，均与提示词 JSON 指令矛盾；无任何「AI 遵循提示词返回 `{"shouldExecute": ...}`」场景的测试覆盖，导致两条链路长期静默失效。
- **修复计划**（具体、可执行，含文件级方向；不实施）：
  1. **统一 `shouldExecute` 提取函数**（branch-evaluator.ts）：新增/改造 `extractShouldExecute`，两层解析——①直接 `JSON.parse` 提取 `shouldExecute` 布尔；②正则 `/\{"shouldExecute"\s*:\s*(true|false)/i` 提取 true/false；两层均不满足才返回 undefined（解析失败）。**仅条件分支使用**（见下：循环跳出走缺陷 4 的 shouldBreak 专用模板，两者分场景字段，互不复用）。
  2. `decideCondition`（dag-navigator.ts）AI 分支改为：提取 shouldExecute 后 `=== 'true'`；解析失败（undefined）走重试或按 false 处理（由步骤 4 决定）。
  3. `decideBreak`（loop-manager.ts）AI 分支**不迁移到 shouldExecute**：循环跳出按缺陷 4 方案使用**专用 shouldBreak 模板**（含 I/O 块 + 要求返回 `{"shouldBreak": true/false}`），`decideBreak`/`extractBreakResult` 与提示词格式对齐（条件分支 shouldExecute、循环跳出 shouldBreak 分开处理）——**基准源码 workflow-loop-manager.ts:206-238 证明分离方案正确**（breakCondition 独立评估、独立字段），统一 shouldExecute 会破坏循环跳出的独立语义。
  4. **解析失败重试**：`BranchEvaluator.evaluate` 或调用方（dag-navigator/loop-manager）增加重试——把 AI 输出原文 + 错误提示（「未能从你的输出中解析出 shouldExecute/shouldBreak 布尔值，请仅返回 `{"shouldExecute": true}` 或 `{"shouldExecute": false}`（分支）/ `{"shouldBreak": true}` 或 `{"shouldBreak": false}`（循环）」）构造为 follow-up 重新评估；轮次上限建议新增常量 `MAX_BRANCH_EVAL_RETRIES = 2`（或对齐现有 `MAX_FINALIZE_ASK_ROUNDS = 3`），防死循环；超限按 false 处理并记日志。
  5. **死代码处理**：删除 `extractExpectation`（branchExpectation 匹配语义已废弃）或重写为 shouldExecute 提取（建议删除）。
  6. **补测试**：workflow-engine.spec / loop-manager.spec / branch-evaluator.spec 新增 mock `{"shouldExecute": true/false}`（条件分支）与 `{"shouldBreak": true/false}`（循环跳出）覆盖两条链路 + 解析失败重试场景；修正现有与提示词矛盾的 mock（裸 `'true'`、`'{"shouldBreak": ...}'`）。
- **修复计划状态**：待实施（需用户批准后另行执行；与缺陷 4 分场景字段方案对齐——循环跳出按缺陷 4 的 shouldBreak 专用模板，不随本缺陷迁移 shouldExecute）

---

## 缺陷 3：`checkLoopBreak` 调用时机 off-by-one

- **状态**：✅ 已判定（部分存在，已定修复计划）
- **来源**：engine-defact.md #3（🔴 逻辑错误）
- **报告摘要**：sandore 先递增 visitCount 再调 checkLoopBreak，可能提前一轮跳出循环。
- **涉及文件**：`workflow/src/dag-navigator.ts`（resolveNextNodes 循环分支 L228-272）、`microflow/src/loop-manager.ts`（checkLoopBreak L179-207）、`microflow/src/stage-executor.ts`（isLoopControl L432-436 / 条目 visitCount L448/L484）、`workflow/src/workflow-engine.spec.ts`（循环测试实证）
- **判定**：⚠️ 部分存在（报告主断言不成立，残留双重计数需修）
- **原因/结论**：
  1. **报告数字推演错误**：sandore 首次进入循环是「置 0 而非 +1」（dag-navigator.ts L260 `context.visitCounts[node.id] = 0`），且纯静默路由门（无 command、仅 loop 分支，stage-executor.ts L432-436 `isLoopControl` 跳过条目）不产生 executed 条目、不递增；回边（L234-235）`(visitCounts ?? 0) + 1` 后调 checkLoopBreak，第 N 次回边传入的是 **N（1、2、3）**。checkLoopBreak（loop-manager.ts L184）`visitCount >= maxIterations`，maxIterations=3 时第 3 次回边（此时第 3 次迭代已执行完毕）触发跳出——循环体恰好执行 3 次，**不提前**。
  2. **测试实证**：workflow-engine.spec.ts L991-995 断言 maxIterations=3 时 loopIteration=[[1],[2],[3]]、iterations[2].visitCount===3（循环体 3 次）；嵌套循环测试 L1048-1066 断言 2×2=4 次；loop-manager.spec.ts L97-104 确认 checkLoopBreak(3, maxIterations=3)=true——纯静默路由门场景行为正确。
  3. **与基准对比方向相反**：按基准文档字面（processNode 每趟 +1 且首趟即评估 checkLoopBreak，§4.3 L1199/§16.2），基准循环体只执行 2 次（首趟计入）——差异方向与报告相反（sandore 不比基准少，相等或更多）。
  4. **真实残留问题（报告未准确描述）——visitCount 双重计数**：当循环门节点每趟产生 executed 条目时（①有 command 的命令门；②混合分支门；③带 breakCondition 且评估产出 loopMeta 的门，loop-manager.ts L197-202 每次评估都产出 loopMeta），执行器条目计数（stage-executor L448/L484）与回边计数（dag-navigator L234-235）叠加，checkLoopBreak 输入变 2、4、…，maxIterations 上限在 maxIterations-1 次迭代后触发。纯静默路由门（现有测试全部使用）不受影响 → 测试全绿但未覆盖此场景。
- **修复计划**（具体、可执行，含文件级方向；不实施）：
  1. **只改执行器侧计数，不改 dag-navigator 回边语义**：`stage-executor.ts` 对循环门节点（`activeLoopNodeId === nodeId` 或 `isLoopControl`）**跳过条目 visitCount 递增**（L448/L484）——消除执行器条目计数与回边计数叠加的双重计数，回边（dag-navigator L234-235）保持为唯一计数源。**不要改 dag-navigator L234 为「先读后 +1」**：当前「increment-then-check + 首次置 0」已恰好实现「第 N 次迭代执行完毕后的回边传入 N」语义（首次进入置 0 → 第 1 次回边传 1 → … → 第 maxIterations 次回边传 maxIterations 触发跳出，循环体恰好执行 maxIterations 次）；若改为「先读后 +1」且首次仍置 0，则第 1 次回边传 0（不跳）→ … → 第 maxIterations 次回边传 maxIterations-1（不跳）→ 第 maxIterations+1 次回边传 maxIterations 才跳 → **循环体执行 maxIterations+1 次，更糟**。
  2. **补测试**：为命令门、混合分支门、带 breakCondition 门补充 `maxIterations` 迭代数断言（当前无覆盖）；断言 maxIterations=3 时这些门场景也恰好执行 3 次。
  3. **文档/报告层面修正**：撤回缺陷 3 的「提前一轮跳出」数字与方向性结论，改写为「仅非纯静默路由门场景存在双重计数，修复在 stage-executor 侧跳过循环门条目计数」。
- **修复计划状态**：待实施（需用户批准后另行执行）

---

## 缺陷 4：`checkLoopBreak` 传入空 I/O 上下文

- **状态**：✅ 已判定（真实存在，已定修复计划）
- **来源**：engine-defact.md #4（🔴 逻辑错误）
- **报告摘要**：sandore checkLoopBreak 传空 I/O 上下文，AI breakCondition 无法参考 Step 实际输入输出。
- **涉及文件**：`workflow/src/dag-navigator.ts`（resolveNextNodes 循环分支 L228-272 / ResolveNextNodesContext L42-48）、`microflow/src/loop-manager.ts`（checkLoopBreak L179-207 / buildBreakContextMessage L64-80 / decideBreak L220-228）、`microflow/src/stage-executor.ts`（buildContext L383-390 / previousOutputs L591 / finalize 先例 L599）、`microflow/src/branch-evaluator.ts`（buildBranchPrompt 复用）、`ui/src/client/FlowEditor.tsx`（breakCondition 配置）
- **判定**：✅ 真实存在（功能缺失，中等影响面）
- **原因/结论**：
  1. 现状属实：resolveNextNodes 传 `{ input: '', output: '' }`（L239），buildBreakContextMessage 渲染空白 I/O 块。
  2. 成因修正：非架构差异——循环体输出在判定时刻存在于执行器 state（previousOutputs / executedSteps[].output，finalize 门禁 L599 已在用同一数据喂 AI），是调度层管道未打通（buildContext 只传 visitCounts/passThroughVars/signal，导航器无 readState）。
  3. 受影响面：AI 类型 breakCondition 且依赖循环体输出 → 无法正确判定（仅靠 promptText/loopTurn/maxIterations 兜底）；shell 类型不受影响（decideBreak 走 matchesExpectation，context 不参与判定）；maxIterations 硬上限不受影响。
  4. 附加发现（同族于缺陷 2）：loop break 复用 buildBranchPrompt（要求 shouldExecute），decideBreak 用 extractBreakResult 解析 shouldBreak 键——AI 遵守模板格式将永不跳出，测试 mock 返回 shouldBreak 掩盖。
  5. 测试未锁定：loop-manager.spec 单测传非空 context 但不断言提示词内容；workflow-engine.spec loopBreakYaml mock 无条件返回 true；UI：FlowEditor.tsx L209-216 breakCondition 默认 prompt 且 CommandEditor 全五类型可选，用户可配 AI 条件但无提示其看不到循环体输出。
- **修复计划**（具体、可执行，含文件级方向；不实施）：
  1. **打通 I/O 管道**：给 `ResolveNextNodesContext` 增加可选 I/O 字段（或独立 loopBreakContext 注入）；`stage-executor.buildContext(state)` 从 `state.previousOutputs` 组装——input 用 `input.originalInput`（对齐 finalize L599 先例），output 用 `textSummary` 最近一次循环体迭代输出（按 loopIteration 匹配当前迭代路径更精确），artifacts 可选留空。`LoopManager.checkLoopBreak` 与 `buildBreakContextMessage` 接口已支持，无需改动。
  2. **延续分场景字段**（缺陷 2 的分场景方案）：循环跳出使用**专用 shouldBreak 模板**（含 I/O 块 + 要求返回 `{"shouldBreak": true/false}` + 红线），不复用分支 shouldExecute 模板；decideBreak/extractBreakResult 与提示词格式对齐（条件分支 shouldExecute、循环跳出 shouldBreak 分开处理）。
  3. **补测试**：loop-manager.spec 增加断言提示词含真实 I/O 的用例；workflow-engine.spec loopBreakYaml 改用「依据迭代输出决定 break」的 mock（如输出含 'done' 才返回 true）。
- **修复计划状态**：待实施（需用户批准后另行执行）

---

## 缺陷 5：`resolveStepGates` 浅合并 vs 字段级深度合并

- **状态**：✅ 已判定（非缺陷，假阳性）
- **来源**：engine-defact.md #5（🔴 逻辑错误）
- **报告摘要**：sandore `mergeGates` 浅合并（spread）vs 基准字段级深度合并，称 step 只定义 primary 时 workflow 的 secondary 丢失。
- **涉及文件**：`microflow/src/stage-executor.ts`（mergeGates L195-208）、`workflow/src/schema.ts`（GatesSchema L122-129）、`microflow/src/finalize-manager.ts`（GateEvaluator 消费 L491-591）、`ui/src/client/DefinitionDetail.tsx` / `DagEditor.tsx`（GatesEditor）
- **判定**：❌ 非缺陷（假阳性）
- **不存在的原因**：
  1. **报告对 spread 语义推断错误**：JS spread 是**顶层键级合并（per-key nearest-wins）**，非整对象替换。step.gates 只含 primary 键时，secondary 键在 step 中不存在 → workflow 的 secondary 原样保留，不会丢失。
  2. **Node 实测一致**：报告场景（workflow.gates=`{primary:{enabled:true}, secondary:{enabled:true,prompt:"审查代码质量"}}`，step.gates=`{primary:{enabled:false}}`）下 `mergeGates` 结果 = `{"primary":{"enabled":false},"secondary":{"enabled":true,"prompt":"审查代码质量"}}`，与基准 `resolveStepGates` 结果完全一致（primaryEnabled=false、secondaryEnabled=true、secondaryPrompt 继承）；secondary 门禁照常执行，未被绕过。
  3. **两种策略在 zod 可达形状下等价**：primary/secondary 各自独立取「最近定义级整对象」——spread 键级合并 ≡ 基准字段级 `??` 回退。唯一理论分歧（显式 `undefined` 键）在 sandore 代码与 YAML 路径均不可达。
  4. **UI 不可构造报告场景**：UI 只暴露 workflow.primary（DefinitionDetail.tsx 详情页）+ step.secondary（DagEditor GatesEditor 步骤编辑器）两个不相交层级；stage 级 gates 与 step 级 primary 只能手写 YAML，报告场景（workflow.secondary + step.primary-only 混合）在 UI 内无法构造。
  5. **附：真实存在的次要差异（基准 primary 默认 enabled=true vs sandore 默认 false）**——**已由用户决定纳入本缺陷改动计划（见下）**。
- **修复计划**：（非缺陷，无行为修复；附测试建议）
  1. **补测试锁定三级合并语义**（建议，待批准）：新增用例「workflow 配 primary+secondary、step 只配 primary」→ 断言 secondaryEnabled=true 且 prompt 从上级继承、GateEvaluator 实际执行 secondary 门禁，防止未来重构引入回归（当前 stage-executor.spec 零 gates/mergeGates 测试；finalize-manager.spec / workflow-engine.spec 门禁测试均单级直接传 gates，无三级合并覆盖）。
  2. **可选**：`mergeGates` 加注释说明 spread 键级合并与字段级 `??` 回退等价（含「step 只定义 primary 时 secondary 从上级继承」说明）。
  3. **primary 默认值差异单独评估**：如需对齐基准 `enabled=true` 默认，涉及 hasEnabledGates 短路与零 AI 调用设计，属行为变更，另行讨论。
  4. **primary 默认值对齐基准**（已由用户决定纳入本缺陷，**待实施**）：将 sandore 的 primary 门禁判定改为「未配置或 `enabled=true` 即启用」：
     - `finalize-manager.ts` `hasEnabledGates`（L345-347）改为：`gates !== undefined && (gates.primary?.enabled !== false || gates.secondary?.enabled === true)`（primary 未显式禁用即视为有门禁；注意 gates 为 undefined 时仍返回 false 跳过——三级都未配置时不跑门禁）。
     - `finalize-manager.ts` `GateEvaluator.evaluate` 的 `primaryEnabled`（L499）改为 `input.gates.primary?.enabled ?? true`（或 `!== false`）；`secondaryEnabled`（L500）保持 `=== true`（secondary 默认禁用，与基准一致）。
     - 同步检查 `hasEnabledGates` 的调用方语义（finalizeStep L613-620：`!needsAssess && !hasGates` 短路跳过）——改动后「无 unresolved vars + 无 gates（三级全未配置）」仍跳过；「有 gates（任一级配了 primary 或 secondary）」时 primary 默认启用。
     - 补测试：未配置 primary 仅配置 secondary 时 primary 门禁默认执行；显式 `primary.enabled=false` 时跳过 primary；三级全未配置时跳过门禁。
     - 标注：**待实施（需用户批准后另行执行）**。
- **修复计划状态**：待实施（含 primary 默认值对齐；需用户批准后另行执行）

---

## 缺陷 6：产物校验 — 非 glob path 用 regex 替代 existsSync

- **状态**：✅ 已判定（真实存在，已定修复计划）
- **来源**：engine-defact.md #6（🔴 逻辑错误）
- **报告摘要**：sandore 对非 glob 的 outputTo.path 用 findFilesByRegex 匹配，路径中 `.` 被解释为正则元字符，语义错误且可能误匹配。
- **涉及文件**：`microflow/src/finalize-manager.ts`（verifyArtifacts L571-590）、`microflow/src/file-utils.ts`（findFilesByRegex L144-155 / collectFiles L114-125 / isGlobPattern L100-103 / findFilesByGlob L77-97 / FileSystem 接缝 L45-51）、`microflow/src/stage-executor.ts`（finalizeStageContract files L178）、`ui/src/client/DagEditor.tsx`（输出参数配置 L479-515）
- **判定**：✅ 真实存在（部分存在：happy path 无感，缺失/前缀场景错误）
- **原因/结论**：
  1. 实现事实：`verifyArtifacts`（finalize-manager.ts L571-590）对非 glob 的 `outputTo.path` 走 `findFilesByRegex(workdir, path)`（L583），glob 走 findFilesByGlob；仅 GateEvaluator L537 调用，`gatesPassed===true` 后校验，missing 则覆盖为 false。`findFilesByRegex`（file-utils.ts L144-155）用 `new RegExp(regex)` 直接编译（L147），`collectFiles` 递归遍历整个 workdir 树（跳过 `.`/node_modules，L114-125），对每个相对路径做**非锚定** `re.test`（L154）。`isGlobPattern`（L100-103）对无 `*`/`?` 的普通路径返回 false → `output/result.txt`、`reports/lint.txt` 等常见写法全部落入 regex 分支；findFilesByGlob 经 globToRegex 锚定 `^...$`（L77-97）无此问题。
  2. 基准对照：非 glob path = `path.resolve(cwd, item.path)` + `fs.existsSync` 精确存在检查（docs/engine/dynamic-workflow-engine.md L2266-2274；defact 报告 L492-562）；regex 字段才走 findFilesByRegex。
  3. 行为分歧一（漏报）：正确文件缺失 + 树内相似文件（嵌套目录同名 `dist/output/result.txt`、无点变体 `result1txt`、`.bak` 副本）→ 正则 `/output.result.txt/` 非锚定全树子串匹配命中 → **该报缺失却没报，门禁错误放行**；默认 cwd 为 `/tmp`（workflow-engine.ts L226）整树遍历放大命中面。正确文件存在时 `.` 恰好匹配字面 `.` 而命中，与基准一致（happy path 无感，finalize-manager.spec L412-425 只测此场景故通过）。
  4. 行为分歧二（误报）：`./output/result.txt` 前导 `./` 使正则要求「任意字符 + /output/result」，相对路径无 `./` 前缀 → **确定性误报缺失（门禁恒失败）**。报告所举 `./outputXresult_txt` 实际对应无前缀形态（`outputXresult_txt`），报告示例需修正。
  5. 影响面：UI（DagEditor.tsx L479-515）输出参数「相对路径/正则匹配」下拉默认 path 模式、占位符即「相对路径」；YAML 示例（yaml-parser.spec L174-178）全是 `reports/lint.txt` 型普通相对路径——常见写法正落在缺陷分支上。schema OutputToItemSchema（schema.ts L77-82）无字段语义约束。测试缺口：无缺失/误匹配/`./` 前缀用例。
  6. 关联：stage-executor.ts L178 `files: []` 硬编码，collectStepArtifacts 缺失（缺陷 #16）独立成立；修复 #6 的判定逻辑可作为 #16 复用的共享原语。
- **修复计划**（具体、可执行，含文件级方向；不实施）：
  1. **非 glob 分支改精确存在检查**（finalize-manager.ts L571-590）：`outputTo.path` 非 glob → resolve 后精确判定存在性（缺 → missing）；glob 仍走 findFilesByGlob；`outputTo.regex` 字段仍走 findFilesByRegex（regex 语义保留）。**实现载体说明**：sandore 仓库内无真实 fs 适配器（`ctx.fs` 由 DSH 宿主注入，仅暴露 FileSystem 结构类型 L45-51：resolve/listDir/readText/writeText，无 exists）——存在性判定可用 **resolve + readText 组合**（`resolve(path)` 成功 + `readText` 不抛错即存在；或宿主 fs 若提供 exists 则用之），无需强制扩展接口；若宿主适配器允许可补 `exists` 原语，非必需。
  2. **补测试**：①正确文件缺失（无相似文件）→ 报 missing；②`./` 前缀路径 → 不误报（精确匹配存在即通过）；③正确文件缺失 + 树内相似文件 → 仍报 missing（不误命中）；④glob/regex 分支回归。
  3. 可选：修复逻辑提取为共享函数，供缺陷 #16（collectStepArtifacts）复用。
- **修复计划状态**：待实施（需用户批准后另行执行）

---

## 缺陷 7：`resolveStepRules` 完全缺失

- **状态**：✅ 已判定（真实存在，已定修复计划）
- **来源**：engine-defact.md #7（🔴 功能缺失）
- **报告摘要**：workflow.rules 定义存在于 schema 但运行时不被解析/注入，工作流规则（代码规范/安全约束等）对 Step 完全无效。
- **涉及文件**：`workflow/src/schema.ts`（三级 rules L153/L170/L188）、`microflow/src/step-runner.ts`（buildPromptText L247-268 / buildTaskText L222-241）、`microflow/src/stage-executor.ts`（mergeGates L196-208 不处理 rules）、`workflow/src/workflow-engine.ts`（runnerConfig L769-819）、`ui/src/client/DefinitionDetail.tsx`/`DagEditor.tsx`（无 rules 入口）
- **判定**：✅ 真实存在（部分存在形态：schema 有 + YAML 保留，运行时零消费 + UI 无入口）
- **原因/结论**：
  1. **schema 三级 rules 字段存在**：workflow 级 `rules: Record<string,string>`（schema.ts L188）、stage/step 级 `rules: string[]` 键引用数组（L170/L153），与基准字段定义一致。
  2. **运行时消费点为零**：全包 grep 无 `workflowDef.rules`/`definition.rules` 读取；无 resolveStepRules / setResolvedRules / `## 任务规则` 注入；`mergeGates`（stage-executor.ts L196-208）只合并 gates 不处理 rules；`runnerConfig()`（workflow-engine.ts L769-819）不传 rules；StepRunRequest/StepRunnerConfig 无 rules 字段。
  3. **提示词无规则注入**：`buildPromptText`（step-runner.ts L247-268）只有主头部 + 任务 + 参考信息 + 前置输出，无 `## 任务规则` 节；prompt 走 llm.stream（L425）、agent/skill/mcp 走 startContinuable（L460），四路 AI 提示词都不带规则；shell Step 无 AI 提示词。
  4. **YAML 解析保留 rules（实测）**：parseWorkflowYaml 走 WorkflowDefinitionSchema.parse，zod 剥离未知字段但保留已声明字段——用户写 rules 是「保留但不消费」，**非静默剥离**。
  5. **UI 无 rules 编辑入口**：DefinitionDetail.tsx 只编辑基础字段；DagEditor 节点面板无 rules；ui/src 全目录 grep rules 零匹配。后端 createDefinition/updateYaml 接受任意 YAML（手工导入路径存在，parse 保留 rules）。
  6. **无等价替代机制**：引擎「红线规则」是写死的内部约束（只读/禁止过度探索），与用户可配置 workflow.rules 语义不同；skills/mcps/agents 只做名称校验；hostAgent 是纯 DSH 默认主代理，无 persona 承担规则职责。
  7. **测试缺口**：yaml-parser.spec.ts 完整样例含三级 rules 但断言无 rules 内容；round-trip 测试无法区分「保留」与「双剥离」（实测是保留）；step-runner.spec.ts 无 rules 测试。
- **修复计划**（具体、可执行，含文件级方向；不实施）：
  1. **解析**：新增纯函数 `resolveStepRules(workflowDef, stageDef, step): Record<string,string>`（microflow 纯函数模块），照抄基准 3 级合并语义——step.rules ∪ stage.rules 键去重；两者都空时继承 workflow.rules 全部键；逐键查内容；未知键忽略。
  2. **装配**：`StepRunnerConfig` 增加 `resolvedRules?: Record<string,string>` 字段；`workflow-engine.ts runnerConfig()`（L769-819）计算后传入。
  3. **注入**：`buildPromptText`（step-runner.ts L247-268）增加 `## 任务规则` 节（有规则时渲染 `- **{key}**: {content}`，对齐基准位置），prompt/agent/skill/mcp 四路 AI 提示词同时生效；shell Step 无 AI 提示词不适用。
  4. **UI**：`DefinitionDetail` 增加工作流级 rules 键值对编辑；`DagEditor` 节点面板增加 stage/step 级 rules 键引用编辑（引用工作流级 rules 的键选择）。
  5. **补测试**：yaml-parser.spec 补 rules 保留断言；step-runner.spec 补 `## 任务规则` 注入断言（四路）；补 3 级合并单测（step 优先 / 都空继承 / 去重 / 未知键忽略）。
- **修复计划状态**：待实施（需用户批准后另行执行）

---

## 缺陷 8：Step 级重试能力完全缺失

- **状态**：✅ 已判定（部分存在，已定修复计划）
- **来源**：engine-defact.md #8（🔴 功能缺失）
- **报告摘要**：sandore 无 SDK 级 revertSession/unrevertSession/forkSession，revert/fork 依赖 sessions.fork + agents.create，无法精确消息点回退。
- **涉及文件**：`workflow/src/recovery-manager.ts`（retryStep L136-235 / computeSafeRevertBoundary L104-112 / RecoveryManagerOptions L53-74）、`workflow/src/workflow-engine.ts`（forkSession/getSession/createAgent 接线 L874-906）、`workflow/src/wire.ts`（RetryStepInputSchema L122-140）、`ui/src/client/DiscussionInput.tsx`/`DagStepNodeView.tsx`（三模式按钮）、DSH `core/session/src/index.ts`（sessions.fork L1070-1141 OPEN_TURN 校验）
- **判定**：⚠️ 部分存在（主体为 DSH 能力上限的合理适配；真实差距：revert 回退点不可选 + 常见场景 revert≈fork）
- **原因/结论**：
  1. 报告事实成立：sandore 确实无 revertSession/unrevertSession，revert/fork 依赖 sessions.fork + agents.create。
  2. 但「功能完全缺失」定性过重：DSH 平台无 messageId 级回退原语（core/session 无 revert/unrevert；sessions.fork boundary 是事件 seq 且 OPEN_TURN 校验禁止 turn 内切片）——turn 边界回退是 DSH 能力上限，属合理适配。
  3. continue 与基准等价；fork 基本等价（边缘：源会话未闭合尾部时 fork(undefined) OPEN_TURN 报错，revert 反而成功）。
  4. 真实差距一：revert 固定取最后一个闭合 turn/end（computeSafeRevertBoundary L104-112），无用户可选回退点，无法回退到更早 turn；DSH fork 支持任意 turn/end seq，可低成本补齐「回退到第 N 个闭合 turn」。
  5. 真实差距二：常见「失败 turn 已闭合」时 revert 与 fork 效果相同（全量回放、不真正截断失败内容），回退语义弱于基准 revertSession(messageId)；workflow-engine.spec revert 测试恰好验证了全量回放路径，无「截断失败内容」测试。
  6. UI/wire 无回退点选择入口（RetryStepInputSchema 无 revertMessageId 字段）。
- **修复计划**（具体、可执行，含文件级方向；不实施）：
  1. **revert 增加可选回退点参数**：`retryStep(stepId, mode, message, revertBoundary?)`——UI 提供「回退到第 N 个闭合 turn」选择；boundary = 所选 turn/end 的 seq，直接传给 `forkSession`；DSH 原生支持，零平台障碍，对齐基准 revertMessageId 主要用途。
  2. **默认值保持兼容**：未传 revertBoundary 时仍用 `computeSafeRevertBoundary`（最后一个闭合 turn/end），现有行为不变。
  3. **API/UI 透传**：wire `RetryStepInputSchema` 增加可选 `revertBoundary` 字段；DiscussionInput/DagStepNodeView 三模式弹窗在 revert 时提供回退点选择（列出会话中可用的闭合 turn/end 序列）；recovery-manager 对应处理。
  4. **「真正删掉失败内容」**：同一机制让用户选更早 turn/end 即可（回退到失败 turn 之前），无需触碰 DSH 无原语的消息级回退。
  5. **不推荐 mid-turn 消息点回退**：DSH 无原语，手工构造事件 seed 违反 OPEN_TURN 约束与事件一致性，风险大于收益。
  6. **fork 防御（必要，非可选）**：源会话存在未闭合尾部时 fork(undefined) 确定性 OPEN_TURN 报错——必须先提示或自动回退到最后一个闭合 turn/end（对齐 computeSafeRevertBoundary 语义），否则 fork 模式在「子代理 turn 未闭合即失败」的常见场景下直接抛错。
  7. **补测试**：revert 指定更早 turn/end 边界 → 新 agent seed 截断到该边界、后续 followup 正常；默认无参 revert 行为不变；fork 未闭合尾部防御用例。
- **修复计划状态**：待实施（需用户批准后另行执行）

---

## 缺陷 9：`recover()` 崩溃恢复流程严重简化

- **状态**：✅ 已判定（部分存在，已定修复计划）
- **来源**：engine-defact.md #9（🔴 功能缺失）；#11 并入；#10 标注不可触发
- **报告摘要**：sandore recover() 仅做步骤分类 + followup 第一个，无 chat 对账、无未执行步骤检查、无 try/catch 错误兜底。
- **涉及文件**：`workflow/src/recovery-manager.ts`（recover L246-274）、`workflow/src/workflow-engine.ts`（recoverInstance L356-416 / recoverOrphanedInstances L423-445 / runAndCatch L511-528 / resumeStageId/resumeInfo L928-971）、`microflow/src/stage-executor.ts`（resumeSubagentStep L667-715 / runLoop L393-424 / resumeFrom 播种 L338-360）、`workflow/src/interaction-manager.ts`（pending Maps L164-167 / syncState L319-325）
- **判定**：⚠️ 部分存在（报告方向正确，部分论断被架构替代、部分仍为真实缺口；真实缺口 3 处：stale pending 清理、between-steps 非恰好一次重跑、recover() followup 失败无 failed 落盘）
- **原因/结论**：
  1. **报告方向正确，部分被架构替代**：执行段模型 + 崩溃恢复改造后，报告声称缺失的三项中部分已被架构替代或实现——chat 对账（DSH Session 持久化 + executedSteps 快照替代，无需对账）、未执行步骤续跑（resumeSubagentStep L667-715 + nextBatch L393-424 推进剩余 Step）、try/catch 错误兜底（runAndCatch L511-528 主循环 try/catch → failed 终态）；但 2/3 项（stale pending 清理、recover() 本体错误兜底）实为报告原论断的真实落点，仍为真实缺口。
  2. **逐项 A-H 判定**：A（restoreFromState）✅ 等价（state 表快照全量恢复 + navigator 播种）；B（清 stale pending）❌ 真实缺失（InteractionManager 重建时 Maps 空、不 hydrate；state.pendingInteractions 从不清理）；C（SSE/EventBus）✅ 合理省略（DSH ctx.events + Session append）；D/E（遍历 + 预加载 runner）⚠️ 分类等价（预加载被 DSH agents.resume 冷恢复 + resumeSubagent 重收集替代，合理；「只 followup 第一个」见第 6 点）；F（chat 对账）✅ 合理替代；G（未执行步骤）⚠️ 部分覆盖（mid-step 崩溃完全覆盖；between-steps 崩溃窗口重跑）；H（主循环 + 错误兜底）⚠️ 部分（runAndCatch 已实现，recover() 本体无兜底）。
  3. **真实缺口一（B）——stale pending 不清理**：崩溃前 pending ask/permission 残留在 state.pendingInteractions，恢复后 InteractionManager 登记表为空（Maps 不 hydrate）→ UI 复弹旧问卡 + replyQuestion 抛 INVALID_OPERATION（与 #27 同根因、不同触发路径）。
  4. **真实缺口二（G 子集）——between-steps 崩溃窗口**：上一步 completed 已落盘、下一步 running 未落盘时崩溃 → resumeInfo 无活跃段 → StageExecutor 从 Stage 首步重跑，已完成步骤重复执行（新段 + visitCounts 累加），非恰好一次语义。
  5. **真实缺口三（#11 并入）——recover() followup 失败无 failed 落盘**：`active.recovery.recover()`（L396）无 try/catch，followup 抛错 → 传播出 recoverInstance → 实例残留内存 + 快照保持 running、无 failed 落盘（runAndCatch 只覆盖续跑主循环，不覆盖 recover() 本体）。
  6. **#10（多并发只恢复第一个）当前不可触发**：StageExecutor runLoop 严格顺序执行（L401-424 逐个 await），实例内同时至多一个 running 步骤；`.find()` 与 findActiveSegment 收口一致，属防御性代码；未来引入并发执行才变真实缺陷。
- **修复计划**（具体、可执行，含文件级方向；不实施）：
  1. **stale pending 清理（B，P0）**：`recover()` 开头 `commitState({ ...state, pendingInteractions: [], updatedAt })` 清空快照残留；或更好：InteractionManager 支持从 state.pendingInteractions hydrate 登记条目（允许恢复后用户回复旧问卡）+ 补 `clearPendingInteractions(stepId)`（对齐 #27）供 recover/retry/pause 调用。
  2. **between-steps 非恰好一次重跑（G，P1）**：`resumeInfo` 无活跃段时返回该 stage 的 completedSteps + 下一个未执行 Step（依据 executedSteps/stageContracts 反推 DAG next），或让 StageExecutor 支持「跳过已完成 Step 播种 batch」，避免从 Stage 首步重跑。
  3. **recover() followup 失败落 failed（#11 并入，P1）**：`recoverInstance` 对 `active.recovery.recover()` 包 try/catch → catch 时置 failed + persist + emitEnd（对齐 runAndCatch 语义），避免实例卡 running。
  4. **#10 标注**：当前顺序执行模型下不可触发（防御性代码）；未来引入并发/并行分支执行时需改为遍历 followup + 多路续跑。
  5. **补测试**：stale pending 恢复后清理/hydrate、between-steps 快照恢复不重跑已完成 Step、recover() followup 失败落 failed。
- **修复计划状态**：待实施（需用户批准后另行执行）

---

## 缺陷 10：多并发 running 步骤只恢复第一个

- **状态**：✅ 已判定（当前不可触发，随队列驱动真并发改造变为真实缺陷；已定修复计划）
- **来源**：engine-defact.md #10（🔴 功能缺失）；与缺陷 9 的 #10 标注联动（缺陷 9 中 #10 标注「当前不可触发、未来并发时改」——本条目给出完整结论）
- **报告摘要**：并发执行的多个 Step 崩溃后只有一个被恢复（recover 用 `.find()` 只取第一个 running 子代理 followup），其余将卡在 running。
- **涉及文件**：`microflow/src/stage-executor.ts`（runLoop L393-424 / processCommandNode L461-557）、`workflow/src/workflow-engine.ts`（findActiveSegment L928-935 / resumeStageId L938-941 / resumeInfo L944-971 / maxConcurrentSteps L194）、`workflow/src/recovery-manager.ts`（recover L246-274 `.find()` L266）、`workflow/src/seam.ts`（maxConcurrentSteps L124/L140）、`workflow/src/recovery-manager.spec.ts`（L372-384 双 running 契约测试）
- **判定**：⚠️ 当前不可触发（并行分支串行执行，无法产生多 running 快照）+ **用户确认需队列驱动真并发改造 → 届时变为真实缺陷**；另：并行分支当前串行执行本身是执行模型缺陷（用户期望真并发）
- **原因/结论**：
  1. **当前架构下不可触发**：`StageExecutor.runLoop`（stage-executor.ts L393-424）严格串行——内层逐个 `await processCommandNode`（L415），无 Promise.all/race；并行分支只是把多个 nextNodeIds 塞进 nextBatch（L457），晋升为 batch 后**仍逐个串行执行**。单点 running 写入：`processCommandNode` 先 onPersist(running)（L491）再 await runner.run——任意时刻 executedSteps 至多一个 running 段（ask 时单段 interacting）。`.find()`（recovery-manager.ts L266）与 `findActiveSegment`（workflow-engine.ts L928-935）收口一致（注释明示），属防御性代码；recovery-manager.spec.ts L372-384 直接构造双 running 状态断言「只 followup 第一个」——测试作者明知引擎无法自然产生多 running，单测是纯防御性覆盖。
  2. **maxConcurrentSteps 是死配置**：schema 声明（workflow-engine.ts L194 / seam.ts L124）但引擎从未读取（grep this.config. 仅 defaultTimeoutMs/defaultProvider/defaultModel）；microflow 全仓 Promise.all/race 零命中。
  3. **与基准执行模型差异**：基准为 Promise.race 真并发（docs/engine/dynamic-workflow-engine.md L1226），多个节点可同时运行，恢复 E 步遍历全部 running/interacting 步骤逐一入队——基准天然多 running；sandore 当前为 Stage 线性循环 + batch 顺序执行——执行模型差异。
  4. **用户决策（关键）**：用户明确要求 sandore **恢复基准的队列驱动调度模型**——引擎维护 `pendingQueue`，出队→执行→解析下一节点→入队的循环驱动整个工作流；**并行分支同时推入队、一把取出执行，有并行个数限制**（maxConcurrentSteps 应真正生效）。即并行分支**必须真并发**（当前串行是执行模型缺陷），届时多个 Step 同时 running 是常态，`.find()`/findActiveSegment 只取第一个 → 其余 running 步骤不被 followup、resumeInfo 只播种第一个 → 半恢复态卡死，**升级为真实缺陷**。
  5. **并行分支当前串行执行本身是执行模型缺陷**（「并行」名不副实），与 #10 同源，需在队列驱动改造中一并解决。
- **修复计划**（具体、可执行，含文件级方向；不实施）：
  1. **（前置，统一规划）队列驱动真并发调度改造**：`StageExecutor` 重写 `runLoop`（stage-executor.ts L393-424）支持 batch 内真并发（Promise.all + 并发上限），`maxConcurrentSteps` 真正生效（读取 config 限制并发数，workflow-engine.ts L194 / seam.ts L124）；`pendingQueue` 出队→执行→解析→入队循环驱动；并行分支多个 Step 同时执行（各自独立 running 段）。
  2. **恢复逻辑多路续跑**（随并发落地同步）：`recover()`（recovery-manager.ts L246-274）把 `running.find(isSubagentStep)`（L266）改为遍历**全部** running/interacting 子代理 Step 逐个 followup（对齐基准恢复 E 步），返回 `{ hasResume: 至少一个, hasFailure }`。
  3. **resumeInfo/findActiveSegment 多路播种**（workflow-engine.ts L928-971）：多 running 时支持播种**多个**续跑 Step（StageExecutorResume 从单 resumeSubagent 扩展为数组），StageExecutor 续跑时对同一 batch 内多个 Step 逐个/并发 resume。
  4. **更新契约测试**：recovery-manager.spec.ts L372 当前把「只恢复第一个」固化为预期，并发落地后改为断言「全部被 followup」；新增并行分支真并发集成测试（多 Step 同时 running 快照的崩溃恢复）。
  5. **纯防御性改进（可选，不依赖并发）**：findActiveSegment/`.find()` 多命中处加 warn 日志或断言，便于并发落地时第一时间暴露多 running 状态。
  6. **注**：队列驱动真并发改造范围较大（涉及 StageExecutor/runLoop/pendingQueue/maxConcurrentSteps/恢复多路续跑），按用户决策**在 35 项缺陷分析完成后统一规划实施**。
- **修复计划状态**：待实施（队列驱动真并发改造在缺陷分析完成后统一规划；恢复多路续跑随并发同步实施）

---

## 缺陷 11：`recover()` 无错误处理

- **状态**：✅ 已判定（部分成立，已定修复计划；与缺陷 9 并入联动）
- **来源**：engine-defact.md #11（🔴 功能缺失）；缺陷 9 已并入（failed 落盘修复），本条目独立验证 + 补充 3 个缺口
- **报告摘要**：recover() 无任何错误兜底，followup 抛错时实例状态不更新为 failed，卡 running。
- **涉及文件**：`workflow/src/workflow-engine.ts`（recoverInstance L356-416 / instances.set L393 / recover() 调用 L396 / hasFailure 分支 L397-401 / runAndCatch L511-528 / recoverOrphanedInstances L423-445 / Service.init L207-210 / getState L297-308 / emitEnd L1118-1121 / persistState L1026-1036）、`workflow/src/recovery-manager.ts`（recover L246-274 / followup L269）、DSH `subagent/src/continuation.ts`（L476-505 真实可抛场景）、`workflow/tests/mocks/subagents.ts`（L58-62 followup 恒 resolve）
- **判定**：⚠️ 部分成立——followup 抛错确实卡 running（缺陷 9 并入正确）；补充 3 个缺口（hasFailure 无 emitEnd、孤儿扫描静默失败、测试无故障注入）
- **原因/结论**：
  1. **核心路径**：`recoverInstance` L396 `await active.recovery.recover()` 无 try/catch，L393 `instances.set` 先执行；followup 抛错 → 异常传播出 recoverInstance → 实例残留内存 running + 快照无 failed 落盘（persistState 自吞错 L1031-1035，无失败路径）+ 二次 recoverInstance 在 L357-362 直接 no-op（返回 running 不做任何事）→ 进程内永久卡 running；UI（getState L297-308 内存优先）无法区分恢复中/失败。
  2. **真实抛错点收敛**：recover()（recovery-manager.ts L246-274）唯一真实抛错点是 L269 followup——readState/commitStep 不抛，commitState→persistState 自吞错（L1031-1035）；对照 DSH continuation.ts L476-505，真实可抛为 abort（signal.throwIfAborted）、coldResume 失败（子代理持久化 Session 缺失/存储不可用）、parent 授权拒绝；「网络异常」论据不成立（followup 只投递入 inbox，不等 LLM turn）。
  3. **缺陷 9 并入正确**：runAndCatch（L511-528）确已覆盖续跑主循环（hasResume 路径后续错误有兜底）；finally 清理 SSE/EventBus 在 DSH 下合理省略（ctx.events + Session append 替代）。
  4. **补充缺口一**：hasFailure 分支（L397-401）标 failed 但**不 emitEnd**——与 runAndCatch 的 failed 分支不一致，`sandore/end` 终态事件缺失，前端收不到终态通知。
  5. **补充缺口二**：recoverOrphanedInstances（L423-445）逐实例 try/catch 只聚合 errors、**不标 failed 不清内存**；且唯一生产调用方 Service.init（L207-210）**丢弃返回值、无日志**——启动扫描失败完全静默。
  6. **补充缺口三**：测试 harness 的 followup 恒 resolve（recovery-manager.spec.ts L122-124、tests/mocks/subagents.ts L58-62），无「恢复期间 followup 抛错」用例。
- **修复计划**（具体、可执行，含文件级方向；不实施）：
  1. **recoverInstance 包 try/catch**（workflow-engine.ts L396）：`active.recovery.recover()` 抛错 → catch 中置 failed + persist + emitEnd（对齐 runAndCatch 语义）+ 从 instances 清内存，避免实例卡 running。
  2. **hasFailure 分支补 emitEnd**（L397-401）：标 failed 后发射 `sandore/end` failed 事件（与 runAndCatch 一致），前端能收到终态。
  3. **孤儿扫描失败日志**（L423-445 + Service.init L207-210）：init 对聚合 errors 记 warn 日志；单实例失败时该实例标 failed（或至少记录），避免启动扫描失败完全静默。
  4. **补测试**：harness 加故障注入（followup 抛错）→ 断言实例落 failed + emitEnd；recoverOrphanedInstances 错误聚合 + 日志用例。
- **修复计划状态**：待实施（需用户批准后另行执行）

---

## 缺陷 12：分支评估缺乏 Step I/O 上下文

- **状态**：✅ 已判定（真实存在，与缺陷 4 合并修复，已定修复计划）
- **来源**：engine-defact.md #12（🔴 功能缺失）；与缺陷 4 同根因
- **报告摘要**：sandore 条件分支评估传空字符串给 BranchEvaluator，AI 看不到 Step 实际输入输出，只能基于 condition 自身 promptText 判断。
- **涉及文件**：`workflow/src/dag-navigator.ts`（条件分支 L214-226 / evaluate 空串 L216 / branchEvalOptions L312-321 / ResolveNextNodesContext L42-48）、`microflow/src/stage-executor.ts`（buildContext L383-390 / executed.output L575 / previousOutputs L591）、`microflow/src/branch-evaluator.ts`（buildBranchPrompt contextMessage L99-126 / BranchEvalOptions.stdin L67）、`ui/src/client/DagEditor.tsx`（L546/L553/L641 条件分支 UI 可达）
- **判定**：✅ 真实存在（命令节点出边场景），与缺陷 4 同根因合并修复
- **原因/结论**：
  1. 现状：dag-navigator.ts L216 硬编码 `evaluator.evaluate(branch.condition!, '', ...)` 传空 contextMessage；L312-321 branchEvalOptions 只传 branches/passThroughVars/loopTurn/loopMaxIterations/signal，无 I/O，且 `BranchEvalOptions.stdin`（branch-evaluator.ts L67「当前 Step 输出 JSON」）从未被填充；L42-48 ResolveNextNodesContext 接口本身无 I/O 字段。
  2. I/O 可得未传：stage-executor.ts L383-390 `buildContext` 只传 visitCounts/passThroughVars/signal；「当前 Step 输出」在 state 中可得（L575 `executed.output` 已写入、L591 `previousOutputs` push），只是不传。
  3. 挂载点：条件分支两种挂载——路由节点（无 command，如测试 dagYaml step-branch，无 I/O 语义正确）+ 命令节点出边（UI 默认场景：DagEditor L546 命令必填默认 shell + FlowEditor L553/L641 `conditionTypes=['shell','prompt']`）。缺陷只影响命令节点场景——恰是 UI 可达主流场景。
  4. shell condition 不受空 contextMessage 影响（branch-evaluator L228-229 shell 分支不接收 contextMessage），但 `BranchEvalOptions.stdin` 从未填充——对齐基准 `readStepOutputForStdin` 的 shell stdin 注入缺失（次生缺口）。
  5. 与缺陷 4 同根因：两者都是「AI 评估缺 I/O 上下文」，共享根因链（ResolveNextNodesContext 无 I/O 字段 + buildContext 不传 + 调用方硬编码空）；LoopManager 已有 `buildBreakContextMessage` 渲染机制（只差调用方传数据），BranchEvaluator 的 contextMessage 透传已就绪——统一打通 I/O 管道即可同时修复两处。
  6. 测试无覆盖：workflow-engine.spec L940/L1029 用裸 `'true'`/`'false'` mock，只断言 branchMeta.status/result；branch-evaluator.spec 只断言输出，无「AI 收到什么上下文」断言。
- **修复计划**（具体、可执行，含文件级方向；不实施）：
  1. **扩展 ResolveNextNodesContext**（dag-navigator.ts L42-48）：新增可选 `stepIo?: { input: string; output: string; artifacts?: readonly string[] }`。
  2. **stage-executor.buildContext 注入 I/O**（L383-390）：从 state 注入当前 Step 的 I/O——命令节点取 `executed.output` 的 textSummary 作 output、input 作 input（路由节点无 command 时留空）；当前 Step 输出在 state 可得（L575/L591），只是此前不传。
  3. **dag-navigator 条件分支转发**（L216）：用 stepIo 构建 contextMessage 传给 evaluate（复用 LoopManager `buildBreakContextMessage` 同款 XML 块，提取为共享工具）；L239 `checkLoopBreak` 同样用 stepIo 替代硬编码空——即缺陷 4 修复。
  4. **branchEvalOptions 补 stdin**（L312-321）：填当前 Step 输出 JSON，对齐基准 `readStepOutputForStdin`（BranchEvaluator L67/L320 已支持 stdin 注入）；shell 条件分支即可在 stdin 中拿到当前 Step 输出。
  5. **与缺陷 4 复用**：缺陷 4 与缺陷 12 共享 I/O 管道（第 1-2 步即缺陷 4 的第 1 步）；`buildBreakContextMessage` 提取为共享工具后，BranchEvaluator 侧无需重复实现 XML 渲染。
  6. **补测试**：AI 条件分支断言提示词含真实 Step I/O；shell 条件分支 stdin 注入用例；路由节点场景回归（无 command 时 I/O 语义正确，行为不变）。
- **修复计划状态**：待实施（需用户批准后另行执行；与缺陷 4 合并实施）

---

## 缺陷 13：`tryAdvanceStage` 不检查失败步骤

- **状态**：✅ 已判定（非缺陷，合理架构差异）
- **来源**：engine-defact.md #13（🔴 功能缺失）
- **报告摘要**：sandore `tryAdvanceStage` 只检查 `isStageAllDone`（契约 completed），不检查失败步骤，可能错误推进含失败 Step 的 Stage。
- **涉及文件**：`workflow/src/dag-navigator.ts`（tryAdvanceStage L152-177 / isStageAllDone L140-143）、`workflow/src/workflow-engine.ts`（runInstance Stage 循环 L563-753 / failed 分支 L718-733 / tryAdvanceStage 唯一调用点 L748）、`microflow/src/stage-executor.ts`（runLoop L393-424 / failed 立即 return L416-417 / finalizeStageContract L164-193/L848-857）、`workflow/src/workflow-engine.spec.ts`（失败用例 L804-875 / 段模型重试用例 L1410-1514）
- **判定**：❌ 非缺陷（合理架构差异）
- **不存在的原因**：
  1. 报告事实观察正确（tryAdvanceStage 确实无 hasFailedSteps 检查），但危害推演不成立——假设的「契约 completed + failed Step」矛盾态在 sandore 不可达。
  2. 无 batch 容错机制（全仓 grep onAgentError/容错 零匹配）；契约 status 与 Step 失败严格联动（finalizeStageContract 直接取执行器 state.status，Step 失败必置 'failed'）。
  3. 失败路径在调用 tryAdvanceStage 之前就 return（runInstance L718-733 failed 分支 → emitEnd → return，L748 永不执行）；即使调用也被 isStageAllDone 的 'failed' 契约挡住（L723 写入 failed 契约）。
  4. 失败传播链路完整：Step 失败 → runLoop 立即 return（stage-executor L416-417）→ execute() 返回 failed → runInstance failed 分支落终态。不存在「跳过失败 Step 推进下一 Stage」的路径。测试佐证（workflow-engine.spec.ts L824 两 Stage linearYaml 首 Stage Step 失败断言实例 status='failed'）。
  5. **反向证据（关键）**：照搬基准的 hasFailedSteps（扫描 executedSteps）在 sandore 段模型下会引入新缺陷——重试成功后历史 failed 段仍在 executedSteps，会错误阻塞已成功重试的 Stage 推进（spec L1484-1485 场景会失败）。sandore 用「契约 status」作为 Stage 权威来源正是为段模型设计的（契约可被覆盖重建，executedSteps 只增不改作为历史）。
  6. 结论：sandore 的「失败即终态 + 契约 status 权威」替代了基准的「failed 阻塞推进」，语义等价且更简单，无需修复。
- **修复计划**：（非缺陷，无行为修复；附防御性测试建议）
  1. **补防御性测试（推荐）**：新增「多 Stage 线性定义（如 linearYaml）+ 首 Stage Step 失败」用例，显式断言：实例 status='failed'、stageContracts[stg-1].status==='failed'、executedSteps 不含 stg-2 的 Step、currentStageId 停留 stg-1——把当前隐式保证固化为回归护栏。
  2. **不要照搬基准 hasFailedSteps**：扫描 executedSteps 中的 failed 会破坏段模型重试语义（重试成功后的历史 failed 段会错误阻塞已成功 Stage 推进）——必须回避。
  3. 可选：finalizeStageContract 内断言「status==='completed' 时 executedSteps 无 failed 段」（当前不变量），防未来引入容错/跳过逻辑时破坏联动前提。
- **修复计划状态**：不适用（非缺陷）；防御性测试待用户批准后另行执行

---

## 缺陷 14：`recoverInstance()` 未通过 RPC 暴露

- **状态**：✅ 已判定（部分存在，P2，已定修复计划）
- **来源**：engine-defact.md #14（🔴 功能缺失）
- **报告摘要**：seam 声明 recoverInstance 但 remote 无 @Remote 端点，客户端无法调用，崩溃实例只能等重启或启动扫描恢复。
- **涉及文件**：`workflow/src/seam.ts`（recoverInstance L83）、`workflow/src/remote.ts`（22 端点无 recover L65-300）、`workflow/src/wire.ts`（无 RecoverInstance schema）、`workflow/src/workflow-engine.ts`（recoverInstance L356-416 / recoverOrphanedInstances L423-445 / Service.init L207-210 / getState L297-308 / requireActive L978-984 / runAndCatch L511-528）、`workflow/src/remote.spec.ts`（mock 引擎无 recoverInstance 桩）、`docs/design/task-4-lifecycle/design.md`（L271-273 有意不暴露 RPC 的设计决策）、`ui/src/client/InstanceList.tsx`/`RunView.tsx`（UI 入口候选）
- **判定**：⚠️ 部分存在（真实但低严重度，P2 恰当）
- **原因/结论**：
  1. 事实准确：seam.ts `SandoreEngine` 抽象类声明 11 个实例级方法（L81-104），含 `recoverInstance`（L83）；引擎实现完整（workflow-engine.ts L356-416）且被 workflow-engine.spec.ts L1591-1709 充分覆盖。但 remote.ts 22 个 @Remote 端点（L65-300）**确实无 recoverInstance**，wire.ts 无 RecoverInstance schema，tool 包 8 个 sandore_* 工具无 recover 工具，UI 全链路 grep recover 零命中——「前端无法手动触发恢复」成立。
  2. 频率被高估：sandore 运行模型下「实例 running 但引擎不在内存」不是常态——进程存活时实例级崩溃由 runAndCatch（L511-528）落 failed 终态（UI 有 retryStep）；「内存无执行体但快照非终态」只出现在进程重启（被启动扫描 recoverOrphanedInstances L423-445 覆盖）或恢复本身失败（罕见二次故障）。
  3. 残留缺口一：启动扫描失败静默且不可逆（Service.init L207-210 丢弃返回值、无日志）→ 孤儿实例只能重启进程，无「重试恢复」手段。
  4. 残留缺口二：基准的两个前端可达机制（API 触发重扫 GET /jobs + getInstanceDiscussion 打开即惰性恢复 recovered:true）sandore 均无。
  5. 残留缺口三：UI 对孤儿实例误导性呈现永久 running（getState L297-308 内存未命中 → state 表兜底读最后 running 快照，L302-307），且 pause/resume/retry/reply/abort 均因 requireActive（L978-984）内存未命中抛 NODE_NOT_FOUND，唯一可用操作是 deleteInstance。
  6. 关键定性：这是**有意的设计取舍**（task-4-lifecycle/design.md L271-273 明确「recoverInstance 作为内部 Service 方法，不单独暴露 RPC」）而非疏漏——真实影响 = 恢复失败/孤儿实例无法重试恢复、只能重启进程，且 UI 无法识别；修复成本极小，P2 恰当。
- **修复计划**（具体、可执行，含文件级方向；不实施）：
  1. **wire.ts**：新增 `RecoverInstanceInputSchema = z.object({ instanceId: z.string() })` + 类型导出。
  2. **remote.ts**：新增 `@Remote('recoverInstance')`，前置 requireInstanceState 校验后转发 `ctx.sandoreEngine.recoverInstance(parsed.instanceId)`（返回 DagRun）；可选加 `@Remote('recoverOrphanedInstances')` 对齐基准 GET /jobs（返回 `{ recovered, errors }`）。
  3. **UI（可选，推荐二选一）**：InstanceList 行级「恢复」按钮（非终态实例显示）；或 RunView 打开时惰性调用 recoverInstance 并以返回值刷新（对齐基准 recovered:true 语义），失败内联展示错误。
  4. **补测试**：remote.spec.ts 的 mock 引擎补 recoverInstance 桩 + 转发/错误透传用例（引擎级 workflow-engine.spec.ts L1591-1709 已有充分覆盖，无需重复）。
- **修复计划状态**：待实施（需用户批准后另行执行）

---

## 缺陷 15：`initPassThroughVars` 缺失

- **状态**：✅ 已判定（部分存在，报告核心主张过时，已定修复计划）
- **来源**：engine-defact.md #15（🔴 功能缺失）
- **报告摘要**：sandore 无 initPassThroughVars，引擎重启后 passThroughVars 可能只有默认空值而无之前已提取的值，破坏变量传递链。
- **涉及文件**：`workflow/src/workflow-engine.ts`（makeInitialState L124-164 / passThroughVars L148 / persistState L1026-1036 / recoverInstance L356-416 / buildActiveInstance L822-920）、`workflow/src/schema.ts`（PassThroughVarSchema L85-90 / PassThroughVarValueSchema L93-97 / WorkflowTaskState.passThroughVars L419）、`microflow/src/stage-executor.ts`（initState L333-336 / collectPassThroughVars L125-133）、`microflow/src/finalize-manager.ts`（writeBackPassThroughVars L350-370 / persistFinalize L689-703）、`microflow/src/step-runner.ts`（replacePassThroughVars 消费 L373-375/L429/L468）、`microflow/src/file-utils.ts`（L62-67 未定义保留字面量）、`workflow/src/workflow-engine.spec.ts`（恢复测试快照 passThroughVars:{} L351/L377/L436）
- **判定**：⚠️ 部分存在（报告核心主张过时；残余 2 个边缘语义差异）
- **原因/结论**：
  1. 事实层面成立：sandore 无 initPassThroughVars，makeInitialState 的 `passThroughVars: {}`（workflow-engine.ts L148）不收集定义默认值、不恢复已解析值。
  2. 报告核心场景不成立（**过时**）：「重启后丢失已提取值、破坏传递链」在当前执行段模型下不可达——`persistState`（L1026-1036）全量持久化（persistence.ts L54-56 state.put 含 passThroughVars）；`recoverInstance`（L356-416）从 state 表全量读回快照（L368）并经 `buildActiveInstance`（L822-920，L915 state 原样装入）恢复；`StageExecutor.initState`（stage-executor.ts L333-336）从快照播种提取值（`{ ...input.passThroughVars, ...collectPassThroughVars(steps) }`）——已提取值在重启后原样保留，Step 间传递链不断。报告结论是引擎改造前撰写的。
  3. **残余差异一**：初始默认值按 Stage 延迟收集（stage-executor.ts collectPassThroughVars L125-133）而非全局一次收集——「先引用后定义（跨 Stage 反向引用）」的编排拿不到定义默认值，`${xxx}` 保留字面量（file-utils.ts L62-67 未定义保留原文）。
  4. **残余差异二**：`collectPassThroughVars` 合并顺序（`{ ...input.passThroughVars, ...collectPassThroughVars(steps) }` 定义值覆盖已有值）与基准「first-wins + 非空提取值优先」语义相左——多 Step 重复声明同名变量且值不同时，后声明定义值覆盖前置提取值。**影响比「边缘」略重**：跨 Stage 场景下前置 Step 已提取变量 A（如 `projectName` 提取自输出），后置 Stage 某 Step 声明同名默认值（如 `projectName: unknown`）→ 定义值覆盖提取值，`${projectName}` 在后置 Step 中解析为默认而非提取值，**破坏跨 Stage 变量传递链**——需补跨 Stage 同名变量用例（前置提取 + 后置默认声明 → 断言后置 Step 拿到提取值）。
  5. 可选记录：基准 V2.4.2 的 `refresh=true` 变量引用前清空重提取逻辑，sandore 也未实现（超出 #15 范围）。
  6. 测试缺口：workflow-engine.spec 恢复测试快照均为 `passThroughVars: {}`（L351/L377/L436），无「崩溃恢复后 passThroughVars 保留」断言。
- **修复计划**（具体、可执行，含文件级方向；不实施）：
  1. **补测试固化「崩溃恢复保留」**（workflow-engine.spec）：构造 passThroughVars 含提取值（如 `{ x: { value: 'extracted', description } }`）的 running 快照 → recoverInstance → 断言后续 Step 的 prompt/shell 命令经 replacePassThroughVars 拿到提取值——钉死恢复保留结论。
  2. **对齐全局默认值收集**（workflow-engine.ts makeInitialState L124-164）：startInstance 中 makeInitialState 之后从 `definition.stages[].steps[].passThroughVars` 全局收集默认值，仅对 state.passThroughVars 尚无的 name 写入（first-wins），解决「先引用后定义」边缘场景。
  3. **修正合并优先级**（stage-executor.ts initState L333-336）：`{ ...collectPassThroughVars(this.steps), ...input.passThroughVars }`（input 提取值放后覆盖定义值），或仅当 input 无该 name 时才用定义值，对齐基准「已提取值优先于定义默认值」，消除重复声明覆盖问题。
  4. **refresh 语义（可选，超出 #15）**：参照基准 V2.4.2 在 Step 执行前清空 refresh=true 变量值使其重新提取。
- **修复计划状态**：待实施（需用户批准后另行执行）

---

## 缺陷 16：`collectStepArtifacts` 缺失

- **状态**：✅ 已判定（真实存在，已定修复计划；与缺陷 6 共享核心逻辑）
- **来源**：engine-defact.md #16（🔴 功能缺失）；与缺陷 6 关联
- **报告摘要**：sandore 无独立产物收集 API，收尾评估 AI 看不到 Step 实际生成的产物文件，Stage 契约产物列表为空。
- **涉及文件**：`microflow/src/stage-executor.ts`（finalizeStageContract L164-193 / toPreviousOutput L154-161 / finishCommandNode L564-636 / resumePendingAsk L756/L814）、`microflow/src/finalize-manager.ts`（FinalizeStepContext L46-50 / buildStepContextBlock L222-236 / buildAssessPrompt L239-262 / buildPrimaryGatePrompt L265-271 / verifyArtifacts L571-590）、`microflow/src/step-runner.ts`（renderPreviousOutputs L190-211 / stepIdFromPath L296-298）、`workflow/src/dag-navigator.ts`（getContractArtifacts L125-133）、`workflow/src/workflow-engine.ts`（contractArtifacts 注入 L587）、`workflow/src/remote.ts`（getArtifacts L271-288）、`ui/src/client/DagEditor.tsx`（outputTo 配置 L575-587）、`ui/src/client/run-view-model.ts`（产物树 L361-375）
- **判定**：✅ 真实存在（比报告更严重，四处断裂）
- **原因/结论**：
  1. `finalizeStageContract`（stage-executor.ts L164-193）：`artifacts[].files` 硬编码 `[]`（L178）、`contractArtifacts` 硬编码 `{}`（L189）——产物从未被收集。
  2. `toPreviousOutput`（L154-161）`files: []` 硬编码（L159）→ step-runner `renderPreviousOutputs`（L190-211）渲染的「## 前置Steps输出与产物」`<artifacts>` 块恒空。
  3. `finishCommandNode`（L595-604）及 resumePendingAsk（L756/L814）调用 finalize 时 context 只传 `{ input, output: textSummary(executed.output) }`——`FinalizeStepContext.artifacts` 字段（finalize-manager.ts L46-50）类型存在但生产代码从不传入；buildAssessPrompt/buildPrimaryGatePrompt/buildSecondaryGatePrompt 经 buildStepContextBlock（L222-236）渲染的 `<artifacts>` 块恒空（收尾 AI 完成度判定与 primary 门禁看不到产物）。
  4. 跨 Stage 引用双重重断：`getContractArtifacts()`（dag-navigator.ts L125-133）合并 contractArtifacts（恒 {}）；且 `input.contractArtifacts`（workflow-engine.ts L587 注入）在 packages 内零消费点。
  5. 额外发现：writeOutputJson/readOutputJson（file-utils.ts L180-240）仅测试使用；inputFrom 的 OutputTo 级引用语法（stg.step.opt）不支持（step-runner `stepIdFromPath` L296-298 直接透传当 stepId）。
  6. 与缺陷 6 关系：非同一缺陷——#6 是 verifyArtifacts（finalize-manager.ts L571-590）判定逻辑错误（非 glob path 用 findFilesByRegex）；#16 是收集逻辑缺失（outputTo → 实际文件列表从未解析）。二者共享「解析 outputTo → 匹配文件」核心逻辑，修复 #6 的判定可抽公共函数复用作 #16 收集逻辑。
  7. 影响：①收尾 AI 完成度判定与 primary 门禁看不到产物列表；②Stage 契约产物空 → UI 产物面板空（run-view-model 产物树 L361-375 / remote getArtifacts L271-288 恒空）；③跨 Stage 契约产物引用全断。
- **修复计划**（具体、可执行，含文件级方向；不实施）：
  1. **新增共享原语 `collectStepArtifacts(step, workdir): Array<{ id, value: string[] }>`**（对齐基准 defact L1439-1466，同时落实 #6 判定修正：glob→findFilesByGlob、非 glob→精确存在检查、regex→findFilesByRegex）。
  2. **三处消费**：①finishCommandNode（L595-604）与 resumePendingAsk（L756/L814）调 finalize 时把扁平文件列表填入 context.artifacts（填充 buildAssessPrompt 等 `<artifacts>` 块）；**resumePendingPaused 不直接调 finalize**——暂停续跑经 resumeSubagentStep（L667-715）回流公共收尾路径 finishCommandNode，因此收集逻辑落在 finishCommandNode/resumePendingAsk 公共收尾处即可覆盖全部续跑路径；②toPreviousOutput 用收集结果填 files（填充 step-runner 前置产物块）；③finalizeStageContract 用收集结果填 artifacts[].files 并按规则聚合 contractArtifacts。
  3. **跨 Stage 引用（更大增量，可后续）**：为 input.contractArtifacts 接入消费端并支持 `${stage.stg-xxx.artifact-name}` 语法。
  4. **补测试**：断言 StageContract.artifacts[].files 与 contractArtifacts 非空、finalize 提示词含产物列表（现状测试刻意回避）。
- **修复计划状态**：待实施（需用户批准后另行执行；与缺陷 6 共享核心逻辑）

---

## 缺陷 17：`stripIdSuffix` 实现差异

- **状态**：✅ 已判定（已无影响，报告过时）
- **来源**：engine-defact.md #17（🟡 逻辑差异）
- **报告摘要**：sandore stripIdSuffix 依赖 stepIdSuffixMap（被 incrementLoopIteration 清除后无法剥离），基准用通用正则不依赖映射表。
- **涉及文件**：`microflow/src/loop-manager.ts`（stripIdSuffix L126-133 / incrementLoopIteration L141-147 / pushActiveLoop L150-155 / stepIdSuffixMap L91 / getActualStepId L115-123）、`workflow/src/recovery-manager.ts`（recover L246-274 / childIdOf L335-337）、`workflow/src/workflow-engine.ts`（resumeInfo L944-971 / resumeStageId L938-941）、`microflow/src/file-utils.ts`（idMatches L245-247）、`microflow/src/stage-executor.ts`（段 id/stepId/childId L438-486）、`microflow/src/loop-manager.spec.ts`（L53-60）
- **判定**：❌ 已无影响（报告过时；stripIdSuffix 为死代码）
- **不存在的原因**：
  1. 全仓 grep：stripIdSuffix 生产代码零调用（仅定义 + spec），死代码。
  2. 恢复路径不依赖：recover 用 childIdOf（sessionMeta.childId 不透明消费）、resumeInfo 用 stepId 字段（原始 id）、resumeStageId 用 stageId 字段；段 id 是纯 UUID，后缀只在 sessionMeta.childId（子代理会话 id），从不需要还原。
  3. 映射表清除（incrementLoopIteration/pushActiveLoop clear）被测试锁定为正确设计（每次迭代 childId 占位唯一）；崩溃恢复后 stepIdSuffixMap 必然为空，但恢复路径不读 map 不调 strip。
  4. 基准需要正则 strip 的架构前提（段 id=带后缀 id）在 sandore 不存在——报告场景不成立。
  5. 残留：stripIdSuffix 映射表实现是死代码/遗留 API，若未来误用（如前端回传带后缀 step id）会静默失败；目前 findStep 只匹配 stepId/id 原值，不做后缀匹配（相邻观察，非本缺陷主张场景）。
- **修复计划**（已无影响，无行为修复；附清理建议）：
  1. **标注遗留或移除**：stripIdSuffix 标注为遗留/未使用（或连同 spec 一并移除），防止后续误用。
  2. **可选对齐基准正则**：改 stripIdSuffix 为 `^(.+)-([0-9a-f]{4})$`（零回归，现有 spec 仍通过），代价是接受「任何 -4位hex 结尾 id 被剥离」语义。
  3. **防未来前端回传（可选）**：在 findStep/stepIdOf 层复用 idMatches 前缀匹配，而非让恢复路径依赖 stripIdSuffix。
- **修复计划状态**：不适用（已无影响）；清理/对齐建议待用户批准后另行执行

---

## 缺陷 18：`walkDir` 隐藏文件过滤差异

- **状态**：✅ 已判定（真实存在但影响低，已定修复计划）
- **来源**：engine-defact.md #18（🟡 逻辑差异）
- **报告摘要**：sandore collectFiles 只跳过 `.` 与 node_modules（`=== '.'` 死判断，实际只跳 node_modules），会遍历 .git 等隐藏目录导致性能与误匹配。
- **涉及文件**：`microflow/src/file-utils.ts`（collectFiles L113-125 / findFilesByGlob L134-141 / findFilesByRegex L143-155 / walkDir L127-132）、`microflow/src/finalize-manager.ts`（verifyArtifacts L571-590 / GateEvaluator L537）、`workflow/src/workflow-engine.ts`（cwd 默认 /tmp L226）
- **判定**：⚠️ 真实存在但影响低（可忽略~低危，含合理差异成分）
- **原因/结论**：
  1. `entry.name === '.'` 是死判断（listDir 只返回子项名，永远不会出现 `.` 子项），实际只过滤 node_modules——`.git`/`.vscode`/`.venv`/`.idea` 等隐藏目录全部被递归遍历，与报告一致；findFilesByGlob / findFilesByRegex / walkDir 均走 collectFiles，先全量收集再过滤。
  2. 但影响面远小于报告暗示：唯一生产调用方是 finalize-manager.ts verifyArtifacts（L571-590）→ GateEvaluator.evaluate（L537，门禁启用 + AI 判 done 时），需「①step 声明 outputTo；②任一层 gates enabled；③门禁通过」三重前提同时成立，且 workdir = request.cwd ?? '/tmp'（workflow-engine.ts L226）——默认 /tmp 无 .git，不触发遍历；sandore 无生产产物收集遍历（files 恒空），误匹配只翻转门禁判定、不污染 UI 产物列表。
  3. `.git/config` 误匹配是真实正确性风险（不锚定 regex + `**/config` 类 glob 会命中），但需特定 glob 模式且概率低。
  4. sandore 保留点文件（.env/.gitignore）可作产物，恰是基准功能短板——直接照抄基准（`startsWith('.')` 跳过一切点条目）会回归「步骤生成 .env 后门禁校验」场景，故不做完全对齐。
  5. 附带：collectFiles 无 try/catch 权限容错（基准有），权限拒绝目录直接抛错——相邻差异。
- **修复计划**（具体、可执行、含文件级方向；不实施）：
  1. **折中修复（首选）**：collectFiles（file-utils.ts L113-125）改为 `if ((entry.name.startsWith('.') && entry.type === 'directory') || entry.name === 'node_modules') continue`——只跳点**目录**（.git/.vscode/.venv），保留点**文件**（.env/.gitignore 仍可作产物），同时消除死判断 `=== '.'`。
  2. **备选完全对齐基准**：`entry.name.startsWith('.')`（跳过一切点条目）——仅在确认不需要隐藏文件产物时采用（会回归 .env 产物场景，需谨慎）。
  3. **独立优化**：verifyArtifacts（finalize-manager.ts L571-590）一次遍历多模式复用同一文件列表，消除 N× 全量遍历。
  4. **顺带可选**：collectFiles 补 try/catch 对齐基准权限容错（权限拒绝目录跳过而非抛错）。
- **修复计划状态**：待实施（需用户批准后另行执行）

---

## 缺陷 19：glob 检测逻辑差异

- **状态**：✅ 已判定（真实存在但影响窄，已定修复计划；与缺陷 6 联动）
- **来源**：engine-defact.md #19（🟡 逻辑差异）；与缺陷 6/20 关联
- **报告摘要**：isGlobPattern 只检测 2 种 regex 特征，`.*` / `\d*` / `[^a]*` 等 regex 模式被误判为 glob。
- **涉及文件**：`microflow/src/file-utils.ts`（isGlobPattern L99-103 / globToRegex L77-97 / findFilesByGlob L135-141 / findFilesByRegex L144-155）、`microflow/src/finalize-manager.ts`（verifyArtifacts L571-590 / isGlobPattern 唯一调用点 L581 / regex 字段 L576）、`ui/src/client/DagEditor.tsx`（OutputRow L481-515 相对路径/正则匹配模式）、`workflow/src/schema.ts`（OutputToItemSchema L77-82）
- **判定**：⚠️ 真实存在但影响窄（低优先级）
- **原因/结论**：
  1. **机制属实**：isGlobPattern（file-utils.ts L99-103）只检测 `\\.`（反斜杠转义）与 `(?` 两种 regex 特征——不含 * /? → 非 glob；含 * /? 且无上述两种特征 → 判为 glob。`.*`/`[^a]*`/`foo.*`/`.*?` 等「含 * /? 且不含 \ 与 (?」的模式在 path 字段被误判为 glob → globToRegex（L77-97，锚定 ^...$ + 非元字符全部转义）转义产生**静默错误匹配**：`.*` → `^\.[^/]*$` 只匹配点文件（静默错误）、`[^a]*` → 字面 `[^a]` 前缀匹配（几乎永不匹配，恒报 missing）。
  2. **报告夸大**：4 个示例仅 2 个成立——`.+` 不含通配符（不被误判）、`\d*` 含反斜杠（不被误判）；且误判是**双向静默错误**：`.*` 门禁假放行、`[^a]*` 门禁恒假失败。真正受影响模式集合 = 含 * /? 且不含 \ 与 (? 的字符串（`.*`、`[^a]*`、`foo.*`、`.*?`）。
  3. **影响面窄**：isGlobPattern 全仓库**单调用点**（finalize-manager.ts verifyArtifacts L581 path 分支，门禁启用 + AI 判 done 时）；UI 明确提供「正则匹配」模式（DagEditor.tsx OutputRow L481-515，写进 regex 字段**绕过 isGlobPattern**，L576 直通 findFilesByRegex）；仓库实际用例正则都带 `\.` 转义且放 regex 字段。
  4. **基准同样不支持 path 字段写正则**（existsSync 响亮失败）——sandore 是「静默错误」而非「功能缺失」，严重度低于报告暗示；且 sandore 的 regex 字段直通正则（不做 glob 检测）比基准更干净。
  5. **关键联动（必须一起修）**：单独修缺陷 19 而不修缺陷 6 会更糟——`.*` 改判非 glob 后落入 L583 findFilesByRegex（缺陷 6 quirk），`new RegExp('.*')` 匹配一切 → 门禁**恒放行**。正确终点：非 glob path → 精确存在检查（缺陷 6），regex 字段 → 正则（现状）。
- **修复计划**（具体、可执行，含文件级方向；不实施）：
  1. **增强 isGlobPattern 特征检测**（file-utils.ts L99-103）：对齐基准 looksLikeGlob——增加 `\\[dDwWsSb]`、`\.\*|\.\+`、`\[\^`、`\{\d`、`\^.*\$` 特征，把 * /? 要求改为「未转义」（`(?<!\\)[*?]`）。
  2. **联动缺陷 6**（finalize-manager.ts L581-583）：verifyArtifacts 非 glob 分支改为 resolve + exists 精确检查（FileSystem 接缝补 exists），glob 分支不变；regex 字段（L576）保持直通正则。
  3. **影响面评估**：增强后翻转的合法 glob（out/*.md、**/*.ts、file?.txt）不含上述特征不会翻转；仅 `.*` / `[^a]*` 类本就不该出现在 path 字段的模式翻转 → 无兼容性风险。
  4. **补测试**：file-utils.spec 的 isGlobPattern 块加 `.*`/`.+`/`\d*`/`[^a]*` → false、`foo.*` → false，保留 `out/*.log`/`out/file?.txt` → true 回归；finalize-manager.spec 加 path=`.*` 无点文件 → 报 missing、path=`[^a]*` 产物齐全 → 不误报。
  5. **修复顺序**：19 → 6 → 20（避免 globToRegex 锚定差异干扰）。
- **修复计划状态**：待实施（需用户批准后另行执行；与缺陷 6 联动）

---

## 缺陷 20：`globToRegex` 锚定差异

- **状态**：✅ 已判定（非缺陷，合理设计差异；报告方向颠倒）
- **来源**：engine-defact.md #20（🟡 逻辑差异）；与缺陷 19 关联
- **报告摘要**：sandore globToRegex 锚定（`^…$`），`*.ts` 不匹配 `src/foo.ts`；基准不锚定（regex 任意位置匹配）。
- **涉及文件**：`microflow/src/file-utils.ts`（globToRegex L77-97 / escapeRegexChar L72-74 / findFilesByGlob L135-141 / isGlobPattern L99-103）、`microflow/src/finalize-manager.ts`（verifyArtifacts L571-590，globToRegex 唯一消费链 L582）、`microflow/src/file-utils.spec.ts`（L107-132 锚定断言）、`docs/design/task-3-full-dag/design.md`（§5.1 L338 示例 `artifacts/*.md`；**注意**：docs/engine/dynamic-workflow-engine.md §6.4 为基准引擎设计文档，task-3-full-dag/design.md §5 标注其来源——sandore 侧设计文档是 task-3-full-dag/design.md）
- **判定**：❌ 非缺陷（sandore 锚定是标准 glob 语义，被测试与文档双重固化）
- **原因/结论**：
  1. **机制属实**：sandore globToRegex（file-utils.ts L77-97）锚定 `^…$`、基准不锚定——报告代码对照无误，两引擎匹配集确实不同。
  2. **但锚定是标准 glob 语义**：`*`→`[^/]*` 不跨 `/`、`**`→`.*` 跨目录、模式需完整匹配相对路径。主流 glob 实现（glob/minimatch/fast-glob）中 `*.ts` 本就只匹配搜索根下顶层文件，`src/foo.ts` 需 `**/*.ts`。基准的「不锚定」等价于递归匹配，且会让 `out/*.md` 误匹配 `x/out/report.md`——**基准才是非标准、易过匹配的一方**。
  3. **调用点实况（影响面极小）**：globToRegex 仅被 findFilesByGlob（L136）调用，findFilesByGlob 仅被 verifyArtifacts（finalize-manager.ts L582）调用，输入是 YAML 的 `outputTo.path`，匹配 workdir 相对路径——锚定全路径匹配恰好正确。
  4. **行为是有意设计且已固化**：sandore 设计文档 task-3-full-dag/design.md §5.1（L338）示例即分段模式 `artifacts/*.md`；单测 file-utils.spec.ts L107-132 显式断言 `artifacts/*.md` 不匹配 `artifacts/sub/report.md`（`*` 不跨层）、`build/**/report.md` 匹配任意深度（`**` 递归）。（修正：原稿引用的 dynamic-workflow-engine.md §6.4 是基准设计文档——sandore 设计文档 task-3-full-dag/design.md §5 标注其「来源」为该节，故 sandore 侧证据以 task-3-full-dag/design.md §5.1 + 单测为准。）
  5. **报告夸大**：以基准非标准行为为参照系给 sandore 定性「缺陷」，未论证基准语义正确；真实后果仅是**跨引擎 YAML 迁移兼容性**（基准写的 `path: '*.ts'` 期望递归，迁到 sandore 会报 missing output files），属文档层面差异。
  6. **与缺陷 19 联动**：独立——isGlobPattern 误判 `.*` 为 glob 后，锚定与否只改变误匹配形态，不改变缺陷 19 判定。
- **修复计划**（无需修改代码；补文档与测试固化）：
  1. **补文档**：task-3-full-dag/design.md §5.1（outputTo 说明处）补 glob 语义说明——`*` 匹配单层、`**` 匹配任意层、模式锚定匹配 workdir 相对路径、`*.ts` 只匹配根层、递归需 `**/*.ts`，并注明与旧基准引擎（不锚定）的迁移差异（修改 sandore 自己的设计文档；不改基准文档 dynamic-workflow-engine.md）。
  2. **补测试固化**（可选）：file-utils.spec.ts 的 globToRegex 用例追加 `expect(globToRegex('*.ts').test('src/foo.ts')).toBe(false)`、`expect(globToRegex('**/*.ts').test('src/foo.ts')).toBe(true)`（现有 `artifacts/*.md` 用例已隐含覆盖，此断言使意图更明确）。
- **修复计划状态**：无需修复代码；文档/测试固化建议待用户批准后另行执行

---

## 缺陷 21：`incrementLoopIteration` 清除行为不同

- **状态**：✅ 已判定（非缺陷，合理设计差异；报告自认「更正确」经复核成立）
- **来源**：engine-defact.md #21（🟡 逻辑差异）
- **报告摘要**：基准不清除 stepIdSuffixMap（同一原始 step ID 跨迭代复用同一后缀），sandore 每次迭代清除映射（新迭代新后缀）。
- **涉及文件**：`microflow/src/loop-manager.ts`（incrementLoopIteration L141-147 / stepIdSuffixMap L91 / getActualStepId L115-123 / stripIdSuffix L126-133）、`microflow/src/stage-executor.ts`（L467 唯一 getActualStepId 调用点 → sessionMeta.childId）、`workflow/src/workflow-engine.ts`（onChildStarted L784-803 真实 childId 替换）、`workflow/src/recovery-manager.ts`（findStep L330-332 / childIdOf L335-337）、`microflow/src/loop-manager.spec.ts`（L53-60 跨迭代新后缀测试）
- **判定**：❌ 非缺陷（清除是进程内辅助状态清理，无 ID 关联断裂）
- **原因/结论**：
  1. **stripIdSuffix 生产零调用**（仅定义 loop-manager.ts L126 + 单测 spec L50）——缺陷 17 死代码结论独立成立，「清除后无法 strip 还原」无实际载体。
  2. **stepIdSuffixMap 唯一用途**：getActualStepId 在单次迭代内为循环步骤生成占位 childId（唯一调用点 stage-executor.ts L467 → executed.sessionMeta.childId）。
  3. **executedSteps 的 ID 关联全部与后缀正交**：executed.id=纯 UUID、stepId=原始定义 id、loopIteration=迭代栈快照、visitCounts 以原始 nodeId 为 key、UI 节点=stepId#loopIteration——无一处依赖后缀映射。
  4. **占位 childId 被真实会话 id 替换**：onChildStarted（workflow-engine.ts L784-803）切换 sessionMeta.childId 并 await 落盘；恢复/重试/暂停反查只走 stepId/执行 id（findStep，recovery-manager.ts L330-337）或真实 sessionMeta.childId（childIdOf L335-337）。
  5. **跨迭代 4-hex 随机后缀碰撞概率 ~1/65536 且无功能后果**（占位不进入任何 childId 键注册表）；sandore 清除行为唯一性严格优于基准的确定性复用。
- **修复计划**（无行为修复）：
  1. 无需修复——清除是进程内辅助状态清理，不持久化、无 strip 依赖、无 ID 关联断裂。
  2. （可选）如需与基准完全一致可移除 clear，但会回归「跨迭代后缀不唯一」且无收益，不建议。
- **修复计划状态**：无需修复

---

## 缺陷 22：`resetLoopVisitCounts` 缺失

- **状态**：✅ 已判定（非缺陷；sandore 重置点在「进入时」而非「跳出时」，行为等价且正确）
- **来源**：engine-defact.md #22（🟡 功能缺失）
- **报告摘要**：sandore 无 resetLoopVisitCounts，循环跳出后 visitCounts 不重置，再次进入同一循环 maxIterations 基于历史累计值可能立即触发跳出。
- **涉及文件**：`workflow/src/dag-navigator.ts`（resolveNextNodes L191-288 / 首次进入归零 L259-261 / 回边累加 L232-257）、`microflow/src/loop-manager.ts`（checkLoopBreak L179-207 / maxIterations 判定 L184）、`workflow/src/workflow-engine.ts`（visitCounts 引擎级注入 L600）、`workflow/src/workflow-engine.spec.ts`（L1048 嵌套循环重入测试）
- **判定**：❌ 非缺陷（sandore 以「进入时归零」实现等价控制语义，嵌套循环测试直接证伪报告）
- **原因/结论**：
  1. **visitCounts 语义与存储**：WorkflowTaskState.visitCounts（引擎级共享、持久化，workflow-engine.ts L600 注入）仅 dag-navigator 回边分支累加并传入 checkLoopBreak（L234-240）；maxIterations 判定唯一入口是 loop-manager.checkLoopBreak（L184 `visitCount >= loop.maxIterations`）。
  2. **报告因果链断裂——重置点在「进入时」而非「跳出时」**：dag-navigator.resolveNextNodes 首次进入分支（L259-261）在 pushActiveLoop 前**无条件**执行 `context.visitCounts[node.id] = 0`；循环跳出后 popActiveLoop 已弹栈，`activeLoopNodeId !== node.id` 必然成立 → **任何再次进入同一循环节点都走首次进入分支并归零**，计数从 0 重新开始。报告引用的跳出片段（仅 popActiveLoop）属实，但漏掉了进入侧归零逻辑。
  3. **「同一循环再次进入」场景真实存在且行为正确，且有测试直接证伪**：嵌套循环中外层每次迭代都重入内层循环（workflow-engine.spec.ts L1048「executes nested loops fully on every outer iteration」），断言内层体完整执行 `[[1,1],[1,2],[2,1],[2,2]]`——若 visitCounts 未重置，第二次外层迭代内层会在执行前命中 `visitCount=3 >= maxIterations=2` 立即跳出，测试将失败；实测通过即证伪。
  4. **恢复场景无问题**：崩溃/续跑时 visitCounts 与 activeLoopStack 一并持久化——循环未结束续跑沿用累计值（正确）；循环已 pop 则重入走首次进入分支归零（正确）。
  5. **残余差异仅展示层**：sandore 只归零循环节点自身计数，未像基准按 loopIteration 作用域归零循环体内其他 Step 的 visitCounts（这些值仅 UI「访问 N 次」展示用，不参与循环控制）——嵌套循环内层体展示为 1,2,3,4 而非 1,2,1,2，是展示语义差异，非循环控制缺陷，与 #22 声称的「maxIterations 误跳出」无关。
- **修复计划**（无行为修复）：
  1. 无需修复——maxIterations 每次循环激活均从 0 计数，现有嵌套循环测试（workflow-engine.spec.ts L1048）已锁定该行为。
  2. （可选展示层优化，非缺陷修复）若追求与基准一致的展示语义（循环体内 Step 跨激活归零），可在 dag-navigator 首次进入分支按 buildLoopIterationPath() 前缀归零作用域内节点计数，或为 LoopManager 增加等价 resetLoopVisitCounts 方法——需配套更新 UI 展示预期，建议作为独立低优先级事项评估。
- **修复计划状态**：无需修复；（可选）展示层对齐建议待用户批准后另行评估

---

## 缺陷 23：`applyPendingLoopMeta` 缺失

- **状态**：✅ 已判定（部分存在——pending 兜底确无必要，但 continue 分支丢 loopMeta 是真实缺口；与缺陷 3 联动）
- **来源**：engine-defact.md #23（🟡 功能缺失）；与缺陷 3 关联
- **报告摘要**：sandore 无 applyPendingLoopMeta pending 兜底，checkLoopBreak 产生的 loopMeta 若无法立即写入会丢失评估现场。
- **涉及文件**：`microflow/src/loop-manager.ts`（checkLoopBreak L179-207 纯函数返回 {shouldBreak, loopMeta}）、`workflow/src/dag-navigator.ts`（循环分支 L228-272 / continue 分支 L250-257 丢弃 loopMeta / break 分支 L241-247 透传）、`microflow/src/stage-executor.ts`（finishCommandNode L588-633 先入列后评估 / processRoutingNode L427-458 原子建条目 / visitCount 递增 L448-453）、`microflow/src/loop-manager.spec.ts`（L174-175 continue 也产 loopMeta）、`workflow/src/workflow-engine.spec.ts`（L1071-1091 break 回写测试）
- **判定**：⚠️ 部分存在（机制不同：pending 兜底在 sandore 无必要；真实缺口是 continue 分支未透传 loopMeta）
- **原因/结论**：
  1. **报告核心机制在 sandore 不成立（pending 兜底确无必要）**：checkLoopBreak（loop-manager.ts L179-207）是**纯函数**——只评估并返回 {shouldBreak, loopMeta}，自身不写 executedSteps、无前置条件、无失败返回值、无 pending 暂存；写入全由调用方 stage-executor 完成，且**必然立即成功**：命令节点路径 finishCommandNode 先 `executedSteps.push(executed)`（L588-590）再 resolveNextNodes（L625）触发评估、直接赋值 `executed.loopMeta`（L629-631，同一对象引用已入列）；路由节点路径 processRoutingNode（L429-455）在 resolveNextNodes 返回后原子创建条目嵌入 loopMeta（L451）——「步骤尚未入列」的失败窗口**永不发生**。基准需要 pending 是因 checkLoopBreak 在 processNode 前经 setLoopIterationMeta 写入（有入列前置条件）；sandore 已重构为「入列后再评估」，照搬 applyPendingLoopMeta 是死代码。
  2. **报告的影响面有真实对应（机制不同）**：dag-navigator 循环分支 **continue 分支（L250-257）丢弃了 outcome.loopMeta**——仅 break 分支（L244-246）透传。loop-manager.spec.ts L174-175 实证 checkLoopBreak 在 shouldBreak=false（继续）时同样产出 loopMeta（completed），导航器未转发 → 每次「继续」迭代的 breakCondition 评估现场（result/sessionId/expectation）静默丢失：命令节点路径不写（routed 无 loopMeta）、路由节点路径不产条目。基准对每次评估（含继续）都两阶段写入 loopMeta——正是报告「影响」描述的丢失，但机制是**continue 分支返回值未透传**，而非 pending 缺失。
  3. **影响面（低-中）**：循环控制（继续/跳出、maxIterations）不受影响（路由只看 shouldBreak）；**跳出**决策现场已保留（break 回写，workflow-engine.spec.ts L1071-1091 实证）；丢失的仅是「为什么继续」的判定记录——审计/可观测性缺口，非执行正确性 bug；UI 不直接消费 loopMeta（ui 目录 grep 无命中），仅持久化快照字段。
  4. **修复交叉效应（必须同步处理）**：continue 透传后，processRoutingNode 因 hasLoopMeta 会**每次继续都产路由条目**，条目创建递增 visitCounts（L448-453）与回边递增（dag-navigator L234-235）叠加 → 触发已知 visitCount 双重计数缺陷（engine-defact-analysis.md 缺陷 3 残留：带 breakCondition 的循环门每趟产条目后 checkLoopBreak 输入变 2、4、…，maxIterations 提前触发）。修复必须同步，否则引入回归。
- **修复计划**（具体、可执行、含文件级方向；不实施）：
  1. **dag-navigator.ts continue 分支**（L250-257）透传 loopMeta：两处 loopResult 均加 `...(outcome.loopMeta === undefined ? {} : { loopMeta: outcome.loopMeta })`。
  2. **stage-executor.ts processRoutingNode**（L448-453）对循环门条目（`activeLoopNodeId === nodeId` 或 `isLoopControl`）**跳过 visitCount 递增**——与缺陷 3 统一修复对齐（回边为唯一计数源），避免新 continue 条目触发双重计数提前跳出；同步更新 L430-431 过时注释（「仅在 breakCondition 评估跳出时回写」→ 继续时也回写）。
  3. **不要引入** applyPendingLoopMeta/pendingLoopMeta：sandore 写入无失败条件，属死代码且误导架构理解。
  4. **补测试**：workflow-engine.spec.ts 新增「breakCondition 评估为 false（继续）时 loopMeta 回写对应路由条目」用例（如 maxIterations=5、首评 false 续跑、次评 true 跳出，断言两条 step-loop 路由条目均含 loopMeta）；保持 L1071-1091 break 用例绿；跑通 loop-manager.spec / workflow-engine.spec / stage-executor 相关测试。
  5. **可选一致性（非本报告范围）**：break 分支路由条目因 popActiveLoop 先于 buildLoopIterationPath（stage-executor L437）导致 loopIteration 为空，可在 pop 前捕获路径。
- **修复计划状态**：待实施（需用户批准后另行执行；与缺陷 3 联动）

---

## 缺陷 24：`readStepInputForFinalize` 缺失

- **状态**：✅ 已判定（部分存在——收尾输入确缺命令文本；session-assess fork 兜底不生效已核实（fork 历史未注入 LLM），影响面中；与缺陷 16 联动）
- **来源**：engine-defact.md #24（🟡 功能缺失）；与缺陷 16 关联
- **报告摘要**：sandore 收尾评估 input 只传 originalInput，缺 parts 拼接 + 命令文本回退（Agent调用/Prompt模板/Shell命令/Skill调用/MCP工具调用）。
- **涉及文件**：`microflow/src/stage-executor.ts`（finalizeStep 调用点 L599/L756/L814 context 构造）、`microflow/src/finalize-manager.ts`（FinalizeStepContext L46-50 / buildStepContextBlock L222-236 / buildAssessPrompt L239-262 / buildPrimaryGatePrompt L265-271 / assess L448-479 fork 逻辑 L453-464）、`microflow/src/step-runner.ts`（buildTaskText / replacePassThroughVars）、`workflow/src/types.ts`（ExecutedStepDefault L159-190 无 input 字段）、`workflow/src/schema.ts`（ExecutedStepDefaultSchema L335-366 / StepSessionMetaSchema L196 注释「替代 SDK 时代 partsJson」）
- **判定**：⚠️ 部分存在（功能缺口真实；parts 数据源不存在、命令文本可从 stepDef 获得；session 类型 assess 的 fork 兜底**不生效**——已核实，影响面中）
- **原因/结论**：
  1. **机制属实**：三处 finalizeStep 调用点（stage-executor.ts L599/L756/L814）均构造 `context: { input: input.originalInput, output: textSummary(executed.output) }`——input 确为原始需求，且未传 artifacts；buildAssessPrompt/buildPrimaryGatePrompt/buildSecondaryGatePrompt 只渲染 buildStepContextBlock + 透传变量列表；FinalizeStepRequest 虽携带完整 step（含 step.command），但命令文本**从未被渲染进任何收尾/门禁提示词**——基准「原始需求 + 命令文本」回退分支确实缺失。
  2. **命令文本可从别处获得**：request.step.command 在 finalize-manager 内可直接访问（command.type / command.value.promptText|command），修复成本低，无需新增持久化。
  3. **session-assess fork 兜底不生效（待定项已核实）**：原稿称 session 类型 assess 经 `ctx.sessions.fork(stepSessionId)` 携带完整历史重放、模型可间接看到命令文本——**不成立**。核实 DSH llm 契约（deepseek-harness/packages/llm/llm/src/types.ts）：`GenerateOptions.sessionId` 注释（L366-370）明确「Session identity stamped by the loop for request routing. Replay uses it to separate cursors; adapters may map it to model-hidden transport metadata」——**只作路由戳记，不自动加载会话历史**；`messages` 注释（L347-352）「A loop-built request assembles them as the derived history (dsh-agent-loop); a hand-built one-shot passes any list」——历史加载是 dsh-agent-loop 的职责。sandore runStream（finalize-manager.ts L395-428）是 hand-built one-shot（`messages: [message]` 只含新 assess 提示词），fork 会话历史**从未注入 LLM 请求**；finalize-manager.ts L9 注释亦明确「完整注入 fork 会话历史留待 Task 4」。**结论：session 类型 assess 同样看不到命令文本**——「有 fork 兜底」不成立，报告影响面对 session 类型也适用（影响面由「低-中」上调为「中」）。
  4. **与缺陷 16 联动**：sandore 全仓无 parts 文件写入（writeOutputJson/readOutputJson 死代码仅 spec 调用；schema.ts L196 注释明确「替代 SDK 时代的 partsJson」）——基准「读取 parts 文件」分支在 sandore **无数据可读**，不能按字面照搬；只有回退分支（需求 + 命令文本）是适用且缺失的。缺陷 16 另使 `<artifacts>` 恒空，收尾/门禁 AI 同时缺「产物列表」与「命令文本」。
  5. **报告略有夸大（方向仍成立）**：sandore 收尾 AI 的任务清单（完成判定 + 透传变量提取 + 门禁）并不包含「产出内容是否符合命令」的比对，命令文本缺失影响的是完成度/门禁判定质量而非新增一项判责。
  6. **影响面（中）**：全部 Step 类型（agent/skill/mcp/prompt/shell）的收尾 assess 与门禁审查均缺命令文本参照——session 类型也因 fork 历史未注入而受影响；唯一例外是 shell Step 的 assess 以 shell stdout 为输入（finalize-manager.ts L8-9），命令文本缺失影响相对小。
- **修复计划**（具体、可执行、含文件级方向；不实施）：
  1. **最小修复（finalize-manager.ts 内完成）**：新增 `buildFinalizeInput(step, originalInput)` 辅助函数镜像基准回退分支——按 command.type 渲染 `### Agent调用/Prompt模板/Shell命令/Skill调用/MCP工具调用`（取 command.value.promptText|command）+ `### 作业需求`（originalInput），作为 FinalizeStepContext.input 传入 buildStepContextBlock（`<input>` 块）或新增 `<command>` 块。
  2. **忠实修复（对齐基准 parts=实际解析后文本）**：step-runner.ts run() 各分支捕获执行时解析后的任务文本（buildTaskText 结果 / replacePassThroughVars 后的 shell 命令），随 StepRunResult 返回（如 inputText）；stage-executor.ts 写入 ExecutedStepDefault（需同步 types.ts L159 与 schema.ts L335 增加可选字段，注意持久化兼容）；finalize-manager 以该文本为 context.input 前缀（无则回退 originalInput）。
  3. **联动缺陷 16**：verifyArtifacts 已按 outputTo 找文件，可把找到的文件列表填入 context.artifacts（需在 finishCommandNode 收集产物后传入），使 `<artifacts>` 块非空。
  4. **补测试**：finalize-manager.spec.ts 断言 assess/gate 提示词文本含命令文本片段；stage-executor.spec.ts 验证 context.input 含「原始需求 + 命令文本」；workflow-engine.spec.ts 的 gate 用例回归；补「session 类型 assess 的 fork 会话历史未注入」契约测试（runStream messages 只含新提示词）。
- **修复计划状态**：待实施（需用户批准后另行执行；与缺陷 16 联动；「fork 历史注入」留待 Task 4 单独评估）

---

## 缺陷 25：`getRecentStepInput` 缺失

- **状态**：✅ 已判定（部分存在——应并入缺陷 12 修复范围，非独立缺陷；与缺陷 12/16 关联）
- **来源**：engine-defact.md #25（🟡 功能缺失）；与缺陷 12/16 关联
- **报告摘要**：sandore 无 getRecentStepInput，分支评估缺 Step parts.json 聚合输入上下文，历史 Step 输入完全不可见。
- **涉及文件**：`workflow/src/dag-navigator.ts`（L216 条件分支评估硬编码传 `''` / branchEvalOptions L312-321 / 循环跳出评估 L236-240 空上下文）、`microflow/src/branch-evaluator.ts`（buildBranchPrompt L99-126 / BranchEvalOptions L55-70 stdin 字段 L67）、`microflow/src/stage-executor.ts`（buildContext L383-390 / resolveNextNodes 调用点 L429/L625/L768/L795/L835 / toPreviousOutput L154-161）、`workflow/src/types.ts`（ExecutedStepDefault L159-190 含 output/sessionMessages、无 input 字段）、`workflow/src/schema.ts`（ExecutedStepDefaultSchema L335-366）
- **判定**：⚠️ 部分存在（分支评估上下文确为空；但应并入缺陷 12 修复，非独立缺陷）
- **原因/结论**：
  1. **分支评估实际可见上下文**：dag-navigator.ts L216 `this.evaluator.evaluate(branch.condition!, '', this.branchEvalOptions(...))` 硬编码传**空字符串** contextMessage——buildBranchPrompt「### 前置上下文」节为空；branchEvalOptions（L312-321）只注入 branches + passThroughVars + loopTurn/loopMaxIterations + signal，**无任何 executedSteps / 历史输入 / 当前 Step I/O**。循环跳出评估同理（L239 `{ input: '', output: '' }`，属缺陷 4 范围）。shell 分支 stdin 注入（BranchEvalOptions.stdin，注释声称「当前 Step 输出 JSON」）在 dag-navigator 从未设置（全仓仅测试代码赋值）。
  2. **历史 Step 输入可获得**：ExecutedStepDefault 含 output（ContentBlock[]）与 sessionMessages（text/tool/reasoning）；stage-executor runState.executedSteps / previousOutputs（toPreviousOutput 已 textSummary(step.output)）在各 resolveNextNodes 调用点（L429/625/768/795/835）均在手边，只是 buildContext 未透传——**本可以拿到而没拿**，是真缺失而非不可实现。注意 executedSteps **无 input 字段**（仅 originalInput + command 定义 + sessionMessages 可作历史输入来源，与基准「parts 聚合」语义最接近的数据源是 sessionMessages）。
  3. **与缺陷 12/16 的关系**：与缺陷 12 **同一根因、同一代码路径**（L216 空 contextMessage + branchEvalOptions 不注入 executedSteps）——修缺陷 12 时把当前 Step 输出（textSummary(executed.output)）与历史 Step 摘要（executedSteps 聚合）一并注入，缺陷 25 的历史部分即自动覆盖，**不存在独立的「getRecentStepInput 方法缺失」**；sandore 应实现的是从 executedSteps 聚合上下文，而非补 parts 读取器。缺陷 16 相关：sandore 从不收集 parts 文件（全仓无 parts.json 写入），报告「读 parts 文件」机制无数据可读，仅「历史输入不可见」后果成立。报告「25 加剧 12」归因有误——25 就是 12 的历史子集，不是 25 加剧 12。
  4. **影响面**：分支评估 AI 完全看不到任何执行痕迹（当前 + 历史），条件如「输出包含'错误'则走 B」只能盲猜；影响真实存在但量级与缺陷 12 相同（同一 prompt 缺同一批上下文），**不叠加放大**。
- **修复计划**（并入缺陷 12，单点修复覆盖两个编号；具体、可执行、含文件级方向；不实施）：
  1. **dag-navigator.ts**：扩展 ResolveNextNodesContext（或 branchEvalOptions 入参）增加历史 Step 摘要源（如 recentStepInputs: string 或 executedSteps 引用）；L216 将空串替换为构建的 contextMessage（当前节点输出 + 历史 Step 聚合，`### Step N` 格式，取 output/sessionMessages 文本）。
  2. **stage-executor.ts**：buildContext（L383-390）从 state.executedSteps / state.previousOutputs 聚合历史 Step 文本摘要（复用 toPreviousOutput 的 textSummary 思路，对齐基准 getRecentStepInput 的 `### Part N` 聚合语义）注入调度上下文。
  3. **workflow-engine.ts**：L599 绑定处若需引擎级 executedSteps（跨 Stage 历史），从 active.state.executedSteps 聚合透传。
  4. **可选**：dag-navigator.ts 加纯函数 buildRecentStepInput(executedSteps) 并补单测（对齐基准 getRecentStepInput 的过滤/聚合行为），但**不引入 parts 文件读取**——sandore 数据源是 executedSteps/sessionMessages。
  5. **修复后同步更新 docs/design/engine-defact.md**：将缺陷 25 标记为「并入缺陷 12 修复，非独立缺陷」，并修正其「读取 parts 文件」的机制描述。
- **修复计划状态**：待实施（需用户批准后另行执行；并入缺陷 12）

---

## 缺陷 26：`rejectQuestion` 方法缺失

- **状态**：✅ 已判定（部分存在——无公开单问答拒绝入口属实，但「只能整体 abort」夸大；已定修复计划）
- **来源**：engine-defact.md #26（🟡 功能缺失）
- **报告摘要**：sandore 无公开 rejectQuestion API，前端无法精确拒绝单个问答请求，只能整体 abort。
- **涉及文件**：`workflow/src/interaction-manager.ts`（公开方法 ask/replyQuestion/replyPermission/delegateSubagentAsk L193-283 / failQuestion private L299-309 / syncState L319-325）、`workflow/src/workflow-engine.ts`（ask 主循环 L656 无 try/catch / runAndCatch L511-528 / L637-641 无 ask 载荷异常收尾）、`workflow/src/remote.ts`（22 端点无 reject）、`workflow/src/wire.ts`（仅 ReplyQuestionInput/ReplyPermissionInput）、`workflow/src/seam.ts`（事件表 L34-48 无 question_rejected）、`ui/src/client/DiscussionInput.tsx`（QuestionCard ✕ → cancelFlow L256-260）
- **判定**：⚠️ 部分存在（核心缺口属实，但报告两处描述与实际不符）
- **原因/结论**：
  1. **核心缺口属实**：引擎 Service 面（seam.ts SandoreEngine / engine-surface.ts）仅有 startInstance/recoverInstance/abortInstance/replyQuestion/replyPermission/pause*/resume*/retryStep/getState，无 rejectQuestion；InteractionManager 公开方法仅 ask/replyQuestion/replyPermission/delegateSubagentAsk，failQuestion（L299-309）是 private 只在 userQuestions.ask Promise reject 时触发（DSH 卡片通道失败或实例 abort 信号），不是可被外部调用的 API；RPC 层 remote.ts 22 端点无 reject；wire.ts 只有 ReplyQuestionInput/ReplyPermissionInput；事件面 sandore/* 事件（seam.ts L34-48）无 question_rejected 等价物，failQuestion 里 resolvedEntries 记的 status:'rejected' 仅留内存审计，前端看不到 rejected 终态。**权限有 reject 取值（replyPermission(…,'reject')），问答没有对应物。**
  2. **「只能整体 abort」不成立**：sandore UI 问答卡片确有单卡片取消路径——DiscussionInput.tsx QuestionCard 的 ✕（run.question.cancel）走 cancelFlow（L256-260）= 全部题目标记 skipped → 空答案集经 onReplyQuestion → remote.replyQuestion → engine.replyQuestion → interactions.replyQuestion → finishQuestion 单请求解锁引擎等待，**不经过 abort**。但语义是「跳过/空答」（条目变 replied，Step 继续跑），**不是「拒绝 → Step failed」**。
  3. **「取消 = AbortSignal 间接 reject（failQuestion）」不成立**：UI 取消走 replyQuestion（finishQuestion，replied 语义），从不触发 failQuestion；AbortSignal 只有整实例 abortInstance → controller.abort() 一条路径。failQuestion 实际只在整实例中止或卡片通道故障时触发。
  4. **Step 失败语义完全不同（报告隐含假设不存在）**：基准 rejectQuestion → StepRunner 把 Step 标记 failed、实例继续；sandore workflow-engine.ts L656 `await active.interactions.ask(...)` 无 try/catch——waiter 被 reject → 异常直接穿出 runInstance → runAndCatch（L511-528）把**整个实例**落为 failed；Step 在 executedSteps 保持 interacting，无 sandore/step-failed。L637-641 的「无 ask 载荷异常收尾」分支也是保持 interacting 等恢复，从不把 Step 置 failed。即 sandore 既无「拒绝单个问答」，也无「问答被拒 → Step failed、实例续跑」的等价能力。
  5. **影响范围对比**：报告结论方向对（缺精确拒绝 API 属实），但「影响范围更大」夸大——sandore 前端至少能逐卡片跳过/空答解锁；真正缺的是「拒绝并让该 Step 失败」的精确语义 + question_rejected 事件。
- **修复计划**（具体、可执行、含文件级方向；不实施）：
  1. **InteractionManager 增加公开 `rejectQuestion(requestId)`**（workflow/src/interaction-manager.ts）：镜像 finishQuestion 的幂等清理（pending Map 删除 + 终态记录 status:'rejected'），但 reject 等待 Promise；新增依赖回调（如 deps.emitQuestionRejected(entry)）或在 engine 侧双发事件。
  2. **事件面**（workflow/src/seam.ts）：新增 `sandore/question_rejected` 事件（Cordis Events + SessionEventMap），engine 侧 buildActiveInstance（约 L832）注入发射回调。
  3. **引擎方法**（workflow/src/workflow-engine.ts + seam.ts Stub + engine-surface.ts + tool 包 engine 表面桩）：新增 `rejectQuestion(instanceId, requestId)` 转发 active.interactions.rejectQuestion。
  4. **Step-failed 语义落点**（workflow-engine.ts L656 主循环）：包一层 try/catch，捕获 ask 拒绝后把对应 ask Step 标记 failed（写 executedSteps + 发 sandore/step-failed），并决定实例续跑/失败策略（对齐基准「Step failed、实例继续」）；这步是让修复真正等价的关键，否则 reject 只会像现状一样把整个实例搞挂。
  5. **RPC + UI**：remote.ts 增 @Remote('rejectQuestion') + wire.ts 增 RejectQuestionInput（instanceId + requestId）schema + remote-client 类型；ui/src/client/RunView.tsx（RunViewRemote + handler）与 DiscussionInput.tsx QuestionCard 增加「拒绝」按钮（或把 ✕ 改为真拒绝路径），locales.ts 补文案。
  6. **测试**：interaction-manager.spec.ts 补 failQuestion/rejectQuestion 用例；workflow-engine.spec.ts 补「ask 被拒 → Step failed、实例不整体挂」用例；修复后更新 docs/design/engine-defact.md #26 与 engine-defact-analysis.md 状态。
- **修复计划状态**：待实施（需用户批准后另行执行）

---

## 缺陷 27：`clearPendingInteractions(stepId)` 缺失

- **状态**：✅ 已判定（部分存在——暂停残留真实、重试残留被守卫拦截、崩溃恢复与缺陷 9 重叠；已定修复计划）
- **来源**：engine-defact.md #27（🟡 功能缺失）；与缺陷 9 关联
- **报告摘要**：Step 重试或暂停时残留 pending 交互不会被清理，恢复后可能误处理过期的 ask/permission 请求，导致回复失败或 Step 卡在 interacting。
- **涉及文件**：`workflow/src/interaction-manager.ts`（pendingQuestions/pendingPermissions/questionWaiters 三 Map / finishQuestion L286-296 / failQuestion L299-309 / 无 clearPendingInteractions 无 clearAll）、`workflow/src/lifecycle-manager.ts`（pauseStep L114-145 完全不触碰 interactions / resumeStep L154+ / pauseAllSteps）、`workflow/src/recovery-manager.ts`（retryStep L136-235 前置守卫 L149-151 / recover L246-274）、`workflow/src/finalize-manager.ts`（L630 interacting 状态）、`workflow/src/workflow-engine.ts`（recoverInstance L356-416 / ask 主循环 L630-679）
- **判定**：⚠️ 部分存在（报告因果链只有一半成立：暂停/崩溃恢复残留真实，「重试残留」被状态守卫拦截基本不可达）
- **原因/结论**：
  1. **方法缺失确认**：interaction-manager.ts 仅维护 pendingQuestions/pendingPermissions/questionWaiters 三个 Map，无 clearPendingInteractions、无 clearAll、无任何按 stepId 的批量清理（全仓 grep 证实仅 interaction-manager.ts 自身引用这些 Map）。唯一清理路径是 ask 内部的 finishQuestion（回复时删单条 + resolve waiter）/ failQuestion（拒绝/取消时删单条 + reject waiter）。
  2. **补充：permission 侧是死路径**：pendingPermissions 在引擎生产路径**从未被登记**（addPendingPermission 仅测试调用）——sandore 权限走 applyPermission 的 session 级 sandbox + DSH approval 策略，报告里 permission 侧的残留风险实际不成立，仅 question 侧成立。
  3. **重试路径（报告核心场景）不成立**：recovery-manager.ts retryStep 前置校验 `step.status !== 'failed'` 抛 INVALID_OPERATION（L149-151）；pending ask 期间步骤状态为 interacting（finalize-manager.ts L630）或 running（delegateSubagentAsk）——均非 failed → **有 pending 问答时调 retryStep 会被直接拒绝**，重试场景无法在受支持 API 面触发残留。唯一边缘：ask 被 dismiss → failQuestion 清条目 → runAndCatch 把实例置 failed 但步骤留在 interacting（另一处不一致，条目已清，与本缺陷残留无关）。
  4. **暂停路径（本缺陷核心成立点）真实存在**：lifecycle-manager.ts pauseStep（L114-145）**完全不触碰 interactions**——只做 interrupt child + 登记表 add + 步骤/实例置 paused + 发事件；基准在 pauseStep 中调用 clearPendingInteractions(stepId)，sandore 无等价物；resumeStep/resumeAllSteps 同样不触碰。残留实况：暂停发生在 pending ask 期间（引擎级 ask：实例 interacting、主循环挂在 await active.interactions.ask；或委托 ask：步骤 running、runner 挂在 delegateSubagentAsk 的 await）时，pending 条目留在 Map + questionWaiters（waiter 未 resolve/reject）+ 快照 pendingInteractions；主循环不在 waitForResume 上，resumeStep 的 notifyResume 只置标志 → 实例显示 running 实为**僵尸**：用户答旧问题 → 子代理已被 interrupt+resume 双重 followup、上下文错位，续跑可能抛 'subagent produced no assistant output' 落 failed；不答则永远挂着。这是报告影响的真实变体——不是字面「卡 interacting」，而是「暂停没停掉 ask + 恢复后残留 pending 被误处理/僵尸挂起」。
  5. **崩溃恢复路径（与缺陷 9 重叠）**：快照 pendingInteractions 是持久化的；ask 挂起时崩溃 → 恢复时 recoverInstance 用快照重建，InteractionManager 是全新空 Map，**无任何步骤清理快照中的 stale pendingInteractions**（基准 recover 步骤 B 是 clearAll()，缺陷 9 缺失清单已明确列出）。Ghost 条目永久留在快照，UI（partitionInteractions 只筛 status==='pending'）照常展示；用户回复 → pendingQuestions.get(requestId) === undefined → 抛 INVALID_OPERATION → **回复失败**。这正是报告声称的「用已失效 requestId 回复 → 回复失败」。
  6. **与缺陷 9 重叠关系**：同一根因的两个入口——缺陷 9（recover 简化）管崩溃恢复时 clearAll；缺陷 27 管 pauseStep/retryStep 时按 stepId 清理。缺陷 27 的暂停清理部分不被缺陷 9 覆盖（缺陷 9 只管 recover），属于 27 独有；崩溃恢复 stale 清理与缺陷 9 完全重叠，修复时应合并实现（一个 clearAll 供 recover，一个 clearPendingInteractions(stepId) 供 pause）。
- **修复计划**（具体、可执行、含文件级方向；不实施）：
  1. **InteractionManager 增加批量清理原语**（workflow/src/interaction-manager.ts）：`clearPendingInteractions(stepId)`——遍历 pendingQuestions/pendingPermissions，按 entry.stepId === stepId（可回退 entry.id）匹配，终态化 + 删 Map + 删 questionWaiters 对应 waiter 并 **resolve 一个「已取消」占位答案**（注意：不能 reject——reject 会冒泡到 runAndCatch 把实例落 failed；resolve 后主循环才能解挂走 paused 分支）；`clearAll()`——同上但全量，供崩溃恢复用（与缺陷 9 合并实现）；syncState() 已自动重持久化 → 快照/UI 自愈。
  2. **LifecycleManager 接入清理**（workflow/src/lifecycle-manager.ts L114-145）：pauseStep/pauseAllSteps 在 interrupt + 登记后，经注入回调调用 interactions.clearPendingInteractions(stepId)（依赖经 options 注入，保持纯协调器可单测，对齐现有 commitStepStatus 注入模式）。
  3. **主循环路由修正**（workflow-engine.ts interacting 分支 L630-679）：ask 返回「已取消」信号后，先查 isPausedStep 命中则**跳过 followup**、转入 paused 分支（waitForResume），并让 StageExecutor 把 ask 断点转 pendingPaused（stage-executor.ts 需在 execute() 入口增加「pendingAsk 但步骤已暂停 → 走 pendingPaused 续跑」的路由，否则 resumePendingAsk 会对被中断子代理重收集输出而落 failed）。
  4. **RecoveryManager 接入 clearAll**（recovery-manager.ts recover 或 workflow-engine.ts recoverInstance L396 后）：恢复重建实例后调用 interactions.clearAll() 清快照 stale pendingInteractions（与缺陷 9 修复合并落地）。
  5. **retryStep 防御性清理**（recovery-manager.ts retryStep L171 commitRunningStep 前后）：低成本调用 clearPendingInteractions(stepId)，防未来状态守卫变化引入残留。
  6. **测试**：interaction-manager.spec.ts 增 clearPendingInteractions/clearAll 单测（含 waiter resolve 语义）；lifecycle-manager.spec.ts 增「pause mid-ask → 条目清空 + waiter 解挂」；workflow-engine.spec.ts 增「interacting 中 pause → resume → 主循环不僵尸、不落 failed」与「快照含 stale pendingInteractions → recover 后回复抛 INVALID_OPERATION 消失」两条回归。
- **修复计划状态**：待实施（需用户批准后另行执行；与缺陷 9 合并实现）

---

## 缺陷 28：`autoReplyPermission` 缺失

- **状态**：✅ 已判定（非缺陷，架构差异：sandore 为 DSH 插件，per-tool 权限判定由宿主 DSH approval/sandbox 栈承担）
- **来源**：engine-defact.md #28（🟡 功能缺失）
- **报告摘要**：sandore 无 per-permission 自动审批，仅创建时设置 session 级 sandbox 模式（workspace-write 整体放行，无法区分编辑类和其他类权限），基准 acceptEdits 只自动批编辑类。
- **涉及文件**：`workflow/src/workflow-engine.ts`（PERMISSION_SPECS L117-121 / applyPermission L275-294 / startInstance 应用点 L260-261 / 宿主主代理 L229-244）、`workflow/src/interaction-manager.ts`（addPendingPermission L179 / replyPermission L235-247 仅镜像兼容路径）、`microflow/src/step-runner.ts`（shell 走 ctx.shell.run L400-401 宿主受管执行器）、`workflow/src/schema.ts`（无 permissionMode 字段）
- **判定**：❌ 非缺陷（架构差异：权限判定由宿主 DSH 承担，sandore 引擎收不到 permission request；等价覆盖成立）
- **原因/结论**：
  1. **sandore 权限设置实况**：workflow-engine.ts L117-121 PERMISSION_SPECS（read-only/workspace-write/danger-full-access），L260-261 在 startInstance（实例创建时）经 applyPermission（L275-294）写宿主会话：`sandbox/mode` 事件 + `ctx.approval.setPolicy(agent,'ask'|'never')`，注释明确「对齐 DSH permission-presets 的默认表」。InteractionManager.addPendingPermission/replyPermission（interaction-manager.ts L179/L235）仅为镜像/兼容路径，全仓只有 spec 测试调用；真实运行时 Step 的 shell 走 ctx.shell.run（step-runner.ts L400-401 宿主受管执行器），权限请求从不流向引擎。
  2. **宿主 DSH 承担 per-tool 判定**：dsh-user-approval ApprovalPolicy 仅 'ask'|'never'（会话级）；'ask' 经 approval/request waterfall 由 apiproxy 转 Web 交互卡，'never' 确定性拒绝。宿主无 per-tool 自动批准策略，但第二根轴 dsh-sandbox-policy 的 sandbox 模式按能力域放行：tool-fs 的 write/edit 不发起 approval，由 sandbox mode 决定放行或 [sandbox: …] 拒绝标记（再走 escalation→ask）。
  3. **架构归属**：sandore 宿主主代理是「纯 DSH 默认主代理」（workflow-engine.ts L229-244），工具/权限全由宿主栈处理；基准 autoReplyPermission 是独立 SDK 引擎（自己收 permission request）的专属机制，sandore 收不到此类请求——在 sandore 中既无处挂钩、也不应重复实现。
  4. **等价覆盖成立**：bypassPermissions ≈ danger-full-access + never（无可问事项）；acceptEdits ≈ workspace-write + ask（工作区编辑静默放行 = 自动批编辑类，越权/工作区外走 approval ask = 其余 interacting），与 DSH 官方预设描述一致（permission-presets 默认表就是 workspace-write+ask 与 danger-full-access+never，sandore 的 PERMISSION_SPECS 与之相同）。唯一语义差：DSH workspace-write 允许 shell 在工作区内写（能力域模型 vs 基准工具类模型），属宿主产品设计；DSH 自身也无 per-tool 分类策略，故「粗粒度」只是 DSH 的默认配置，非 sandore 缺失。
  5. **影响面**：无实际功能损失，三档权限选择覆盖两种基准模式场景，宿主 approval 交互通道在 sandore 实例中正常工作（DiscussionInput approval 卡片）。
- **修复计划**（无需修复）：
  1. 无需修复——若未来确需「仅自动批编辑类、shell 逐条确认」更细预设，属宿主功能演进：应在 DSH 层 dsh-permission-presets 预设表新增 preset 行（注意 audit 成对日志机制），不应在 sandore 引擎内实现 autoReplyPermission（引擎收不到权限请求，且会破坏与宿主权限栈一致性与 approval/asked+decided 审计）。
- **修复计划状态**：无需修复；（可选）宿主预设演进建议待评估

---

## 缺陷 29：`updateInstancePermissionMode` 缺失

- **状态**：✅ 已判定（部分存在——无原生 RPC 端点属实，但「必须中止重建」不成立；已定修复计划）
- **来源**：engine-defact.md #29（🟡 功能缺失）
- **报告摘要**：sandore 无 updateInstancePermissionMode，运行中实例无法动态切换权限模式，必须中止后重新创建。
- **涉及文件**：`workflow/src/remote.ts`（22 端点无权限切换端点 / replyPermission L235-247）、`workflow/src/workflow-engine.ts`（applyPermission private L275-294 / startInstance 应用点 L260-261 / PERMISSION_SPECS L117-121）、`workflow/src/schema.ts`（无 permissionMode 字段，schema.spec.ts L141 断言）、`ui/src/client/DiscussionInput.tsx`（PermissionSelectSandore L582-588）、`ui/src/client/composer-selects.tsx`（L360+ / runCommand /permission L421）、`ui/src/client/index.ts`（runCommand L110-116 / queryPermission L117-122）
- **判定**：⚠️ 部分存在（缺 API 端点属实；但报告核心影响面「必须中止重建」不成立——UI 已有 /permission 运行中切换路径）
- **原因/结论**：
  1. **API 缺口属实（报告 L2123 准确）**：remote.ts 端点仅定义 CRUD、startInstance、replyPermission（回复单个待办权限请求）、生命周期 RPC 等，无 updateInstancePermissionMode 或任何权限模式切换端点；引擎 SandoreEngineRuntime 无 setPermissionMode 方法；权限仅在 startInstance 时经 applyPermission（workflow-engine.ts L275-294）应用一次；schema 无 permissionMode 字段（schema.spec.ts L141 断言）。
  2. **「运行中无法切换、必须中止重建」不成立**：DSH 宿主权限机制是**动态折叠、非创建时快照**——setSandboxMode = 追加 sandbox/mode 事件，每次受限调用折叠读取（「Takes effect on the session's next confined call」）；approval.setPolicy 同理（追加 approval/policy 事件、请求时折叠）。sandore 的 applyPermission 用的正是这两个原语（L282-290），运行时重放完全可行。
  3. **UI 已有运行中切换入口**：实例详情 composer 的 PermissionSelectSandore（DiscussionInput.tsx L582-588），设计注释明言「模型/权限是会话级设置，与工作流运行状态无关，仅动作进行中禁用」——运行中可用。点击 → runCommand(instanceId, '/permission <id>')（ui/src/client/index.ts L110-116）→ DSH 宿主 /permission 命令 → 运行时 setSandboxMode + approval.setPolicy；权限投影宿主计算可订阅，切换后 UI 即时反映。结论：属「缺 API 端点」（增量开发、低成本）而非「引擎架构不支持」。
  4. **报告未覆盖的语义差异**：sandore Step 以子代理运行（step-runner.ts L474 subagents.startContinuable，parent=宿主），委派时快照宿主 sandbox+approval。故运行中切换对宿主会话与**切换后新委派的 Step** 即时生效，但**已运行 Step 子代理保持委派快照**——与基准「StepRunner 闭包每次权限请求读最新值」语义不同。**需补契约测试固化此语义**：运行中切换权限 → 断言①宿主会话 effectiveSandboxMode 变化（新委派 Step 生效）；②已运行 Step 子代理的委派快照保持不变（其权限请求仍按旧模式判定）。
  5. **影响面**：中低。场景真实存在（只读试运行 → 中途放开写权限，避免中止丢进度），但已有替代路径；报告「必须中止后重新创建」不准确。
- **修复计划**（具体、可执行、含文件级方向；不实施；纯增量、成本低）：
  1. **workflow-engine.ts**：给 SandoreEngineRuntime 加 `setPermissionMode(instanceId, mode)`：从 instances 取 ActiveInstance，复用/抽出 applyPermission（现为 private，改为可重入）对宿主 session + hostAgent 重新应用；终态实例抛 INVALID_OPERATION（复用 TERMINAL_STATUSES 守卫）。
  2. **wire.ts**：新增 UpdateInstancePermissionModeInputSchema = { instanceId: z.string(), mode: z.enum(['read-only','workspace-write','danger-full-access']) }。
  3. **remote.ts**：新增 @Remote('updateInstancePermissionMode') 端点：zod 校验 + 终态守卫 + 转发 ctx.sandoreEngine.setPermissionMode。
  4. **UI**：现 composer 选择器（复用 /permission 路径）已覆盖用户需求，非必需改动；如需语义对齐可让 RunView 改走新 RPC，可选。
  5. **测试**：remote.spec.ts 加端点用例；workflow-engine.spec.ts 加 setPermissionMode 用例（切换后 effectiveSandboxMode(session.events) 与 approval 策略变化、终态实例抛错）。
- **修复计划状态**：待实施（需用户批准后另行执行；可选低优先级，现有 /permission 路径已覆盖用户需求）

---

## 缺陷 30：`importWorkflowFromYaml` 缺失

- **状态**：✅ 已判定（部分存在——文件导入可 RPC 组合达成、V1 转换已内建；真实缺口是幂等导入语义；已定修复计划）
- **来源**：engine-defact.md #30（🟡 功能缺失）
- **报告摘要**：sandore 无文件导入能力（只能 RPC 传 YAML 文本），批量导入或 CI/CD 管道导入场景无法支持。
- **涉及文件**：`workflow/src/remote.ts`（createDefinition L87-103 强制新 uuid / updateYaml L138-153 无条件覆盖 / listDefinitions）、`workflow/src/wire.ts`（CreateDefinitionInput 仅 { yaml } L45-46）、`workflow/src/yaml-parser.ts`（parseWorkflowYaml L245 / convertLegacyToV2 L125-152 V1 转换内建）、`workflow/src/schema.ts`（WorkflowDefinitionSchema.version L181 / WorkflowDefinitionRecord.version L437）、`workflow/src/remote.spec.ts`（L187-188 顶层 id 改写测试 / L196-221 CRUD 测试）
- **判定**：⚠️ 部分存在（API 便利性缺口 + 幂等导入语义缺失真实；「批量/CI 场景无法支持」过度夸大）
- **原因/结论**：
  1. **createDefinition 语义**（remote.ts L87-103）：CreateDefinitionInput 仅 { yaml: string }（wire.ts L45-46），无 id/version/path 字段；每次调用强制生成新 id `wfl-{uuid}`，**永远新建**——无 upsert、无版本比对、无 skip。同一 YAML 重复导入会产生重复定义。版本概念存在（WorkflowDefinitionSchema.version，schema.ts L181；记录层 WorkflowDefinitionRecord.version L437），但**无任何版本冲突/跳过逻辑**：updateYaml(id, yaml)（remote.ts L138-153）无条件覆盖，不比对版本。
  2. **文件导入可组合达成**：核心能力已具备——parseWorkflowYaml（解析+V1 转换+引用校验）+ createDefinition/updateYaml/listDefinitions 已覆盖「读文本 → 创建/覆盖」；前端文件选择器或 CI 脚本读文件后调 RPC 即可完成导入——**纯服务端文件读取封装缺失**，属 API 便利性缺口，报告称「批量导入/CI/CD 场景无法支持」**过度夸大**。
  3. **幂等导入语义无法复现（真实缺口）**：基准按 def.id/harnessId 匹配做 created/updated/skipped（engine-defact.md L2149-2160），而 sandore 丢弃 YAML 顶层 id、改写为随机 uuid（remote.spec.ts L187-188 明确测试此行为），客户端无法以稳定身份表达「同一工作流，同版本跳过、新版本更新」——CI 重放同一文件会持续产生重复定义，或需客户端自建 id↔name 映射且仅能按 name（不唯一）匹配。
  4. **V1 转换不缺失**：parseWorkflowYaml 内置 convertLegacyToV2（yaml-parser.ts L125-152、L252），V1（stages[].scenarios[]）文本经 createDefinition/updateYaml 导入时自动转换，yaml-parser.spec.ts 有 V1 转换测试。报告隐含的「V1 文件直接报错」不成立。
  5. **影响面**：当前 GUI 使用者低（定义创建已有 DagEditor 前端流）；CI/CD / 批量导入中高（缺服务端导入封装便利性 + 幂等 skip/update 语义功能性）。
- **修复计划**（具体、可执行、含文件级方向；不实施）：
  1. **新增幂等导入 RPC**（workflow/src/remote.ts）：`importDefinitionFromYaml(yaml: string, options?: { matchBy?: 'id' | 'name' })`——parseWorkflowYaml → 按 YAML 顶层 id（或 name）在 definitions 表查找现有 → 同版本返回 { status: 'skipped', id }；不同版本 updateYaml 返回 { status: 'updated', id }；不存在 createDefinition 返回 { status: 'created', id }。返回结构对齐基准 { created? | updated? | skipped? }。**matchBy:'name' 多匹配歧义需定义**：name 非唯一键（分析自身缺陷 3 已承认同名定义可并存）——多匹配时定义确定性策略：取最新 updatedAt 的记录（或首个匹配），并在返回中注明 matchedCount 供调用方识别；推荐默认 matchBy:'id'（唯一），'name' 仅作显式选择且文档说明歧义处理。
  2. **身份稳定性（关键前置）**：因 createDefinition 强制新 uuid，需在导入路径中支持「保留 YAML 顶层 id 作为记录键」或「按 name 查找现有定义」二者择一（推荐后者，避免破坏现有 CRUD 的 uuid 语义与 remote.spec.ts L196-221 测试）。
  3. **wire.ts**：新增 ImportDefinitionInputSchema / 返回 schema 类型；**remote.spec.ts** 补 created/updated/skipped 三分支测试（含 V1 文本导入断言转换后 name/version 正确）。
  4. **文件读取归属**：workflow 包为浏览器安全包（无 Node fs），文件读取留在调用方——CI 脚本/CLI 层 fs.readFileSync 后调 RPC；如需服务端路径导入，则在 Host 侧（plugin.ts 或独立 CLI 入口）包一层 readFileSync，不建议塞进 browser-safe 包。
  5. **无需改动**：V1 转换（已内建）、createDefinition/updateYaml 本体（导入 RPC 复用即可）。
- **修复计划状态**：待实施（需用户批准后另行执行）

---

## 缺陷 31：实例讨论 API 缺失

- **状态**：✅ 已判定（部分存在——查看历史已被宿主 Session 日志替代覆盖；发消息给 Step 真实缺失但宿主 followup 能力现成；已定修复计划）
- **来源**：engine-defact.md #31（🟡 功能缺失）
- **报告摘要**：sandore 完全无实例讨论 API，用户无法查看实例聊天历史、无法向 Step 发送 @mention 消息。
- **涉及文件**：`workflow/src/remote.ts`（22 端点无 discussion/chat）、`workflow/src/wire.ts`（无对应 schema）、`microflow/src/subagents.ts`（followup 接口 L203 / collectSessionMessages L300）、`workflow/src/workflow-engine.ts`（ask 回答 followup L656-664）、`workflow/src/lifecycle-manager.ts`（resumeStep L148-205 经 followup 续跑 L164/L197）、`workflow/src/recovery-manager.ts`（followup L215/L269 / forkSession）、`ui/src/client/DiscussionInput.tsx`（状态驱动动作条 / 不做向实例发消息）、`ui/src/client/open-discussion.ts`（跳宿主会话 sessions.open）
- **判定**：⚠️ 部分存在（RPC 层缺失属实；「查看历史」已被架构替代覆盖；「发消息给 Step」缺的是封装端点而非宿主能力）
- **原因/结论**：
  1. **RPC 层事实准确**：remote.ts 22 个端点确无 getDiscussion/addChatMessage；wire.ts 无对应 schema；全仓无 chat.json/loadChatState；userChatMessages 字段已在迁移时废弃（改为 state.userMessages，kind 限 input/resume/retry/answer）。报告「无独立讨论 RPC」属实。
  2. **查看历史已被架构替代覆盖（非独立缺口）**：chat.json 语义由**宿主 Session 事件日志**承载（决策 D4/D8，task-4-lifecycle/design.md L272 明确「讨论数据从宿主 Session 日志直读，无需冗余 RPC」）；sandore/* 13 事件全部双发（Cordis + Session append）；子代理会话消息由 collectSessionMessages（microflow/src/subagents.ts L300）归一化进 executedSteps[].sessionMessages（step-runner.ts L551）随 getInstanceState 持久化可达；UI 有 UnifiedTimeline +「Open discussion」跳宿主会话（open-discussion.ts → sessions.open(instanceId)）。唯一残留是基准 recovered:true 惰性恢复语义，已在 engine-defact-analysis.md #14（recoverInstance）登记，非本报告独立缺口。
  3. **发消息给 Step 真实缺失，但缺的是「封装端点」而非「宿主无能力」**：UI 输入区 DiscussionInput.tsx 是状态驱动动作条（running→pauseAll、paused→resumeStep/resumeAll、failed→retryStep、问答应答），ui-redesign-plan.md L29 明确「不做『向实例发消息』」；13 事件无 step-message/discussion-message；@Step 选择只作 resume/retry 目标，无 @mention 解析发消息路径。但 DSH 宿主 ctx.subagents.followup(parent, childId, content, {source:'user', signal}) 就是「向子代理会话追加消息并取回新回复」的现成能力，sandore **已在两条链路直接使用**：①ask 回答闭环（workflow-engine.ts L656-664：用户回答→followup 注回子代理→继续执行）；②resumeStep/resumeAll（lifecycle-manager.ts L148-205：interrupt→followup 续跑）。childId 反查（executedSteps[].sessionMeta.childId + findStepByChildId）与 fork 续接（recovery-manager forkSession + seed 回放）机制全部现成——新增 sendStepMessage RPC 是低成本封装。
  4. **与 ask 机制的关系**：方向相反。ask（interaction-manager askQuestion）是 **Step 主动问用户**，回答链路已闭环；讨论 API 是 **用户主动向 Step 发消息**（缺失方向），ask 无法覆盖「用户主动追问」——只有当 Step 自己 ask 时用户才能回复。
  5. **影响面**：对工作流调试/人工介入有真实价值（运行中定向引导 Step），但 sandore 已有两个替代通道（paused→resumeStep(resumePrompt)、failed→retryStep(message)），缺的是「running 中不打断追加消息」+「统一讨论面板」。报告「完全无此 API」对 RPC 层准确、对能力层过度概括。严重度 P2。
- **修复计划**（具体、可执行、含文件级方向；不实施）：
  1. **wire.ts**：新增 SendStepMessageInputSchema = z.object({ instanceId, stepId, message: min(1) }) + 类型导出（@mention 由 UI 端 @Step 选择器产出 stepId，引擎端不做文本解析）。
  2. **seam.ts + engine-surface.ts**：SandoreEngine 抽象类与接口面新增 `sendStepMessage(instanceId, stepId, message): Promise<void>`。
  3. **workflow-engine.ts**：实现 sendStepMessage——requireInstanceState/requireActive 校验 → 按 stepId 反查最后活跃段 sessionMeta.childId → synthetic===false 才 subagents.followup(hostAgent, childId, [{type:'text',text:message}], {source:{kind:'user'}, signal})（synthetic 步骤抛 INVALID_OPERATION）→ 追加 userMessages **{kind:'message', target:stepId}**（**不复用 kind:'input'**——'input' 语义为原始需求/resume 输入，与讨论消息混淆会污染 originalInput 语义；新增独立 kind:'message'（或 'mention'）供时间轴区分渲染）→ persistState → 双发 sandore/step-message（Session append + Cordis）。
  4. **seam.ts 事件表**：新增 'sandore/step-message' 事件类型（供 UI 刷新）。
  5. **remote.ts**：新增 @Remote('sendStepMessage') 转发 + zod 校验 + 错误透传（对齐 retryStep 风格）。
  6. **UI（可选，推荐）**：DiscussionInput 在 running 态增加「向 @Step 发消息」模式（复用 lastActiveSegmentsOf @Step 选择器）；UnifiedTimeline 的 buildTimeline 已支持 userMessages kind 渲染，消息自动进时间轴。
  7. **补测试**：remote.spec 转发桩；workflow-engine.spec 用例（运行中 Step followup 收到消息 + userMessages kind:'message' 落盘 + synthetic Step 拒绝）。
  8. **明确不做**：chat.json 文件与 getInstanceDiscussion RPC（查看历史由宿主 Session 视图 + getInstanceState 覆盖；recovered:true 惰性恢复语义并入 #14 recoverInstance 修复）。
- **修复计划状态**：待实施（需用户批准后另行执行；与缺陷 14 部分关联）

---

## 缺陷 32：`workflow:` 包装层解包缺失

- **状态**：✅ 已判定（部分存在——缺失真实、影响窄、修复成本一行；报告「Zod 拒未知键」机制描述不实；已定修复计划）
- **来源**：engine-defact.md #32（🟡 功能缺失）
- **报告摘要**：`{ workflow: {...} }` 顶层包装格式 YAML 无法解析，Zod 校验直接失败（顶层多了 workflow 字段不在 schema 中）。
- **涉及文件**：`workflow/src/yaml-parser.ts`（parseWorkflowYaml L245-261 无解包 / convertLegacyToV2 L125-152 只处理 V1 scenarios / isRecord L31-33）、`workflow/src/schema.ts`（WorkflowDefinitionSchema L178-192 普通 z.object 默认 strip 无 .strict）、`workflow/src/yaml-parser.spec.ts`（无包装用例）、`workflow/src/remote.ts`（createDefinition L90 / updateYaml L140 汇入 parseWorkflowYaml 单一漏斗）、`workflow/src/workflow-engine.ts`（载入记录 L222/L379）、`ui/src/client/DagEditor.tsx`（打开 L692）
- **判定**：⚠️ 部分存在（缺失机制属实；但报告失败机制描述不准确，影响面窄）
- **原因/结论**：
  1. **缺失机制属实**：sandore parseWorkflowYaml（yaml-parser.ts L245-261）确实无 `workflow:` 顶层解包——convertLegacyToV2(document.toJS()) 后直接 WorkflowDefinitionSchema.parse(data)；convertLegacyToV2（L125-152）只处理 V1 stages[].scenarios[] 转换，raw.stages 非数组时原样返回——{ workflow: {...} } 输入不会被它触碰。
  2. **报告失败机制不准确**：WorkflowDefinitionSchema（schema.ts L178-192）是普通 z.object()，Zod 默认 **strip** 未知键而非拒绝（无 .strict()）。真实失败路径是：包装 YAML 顶层只剩 workflow 一个键 → strip 后为空对象 → 必填 id/name/version/stages 缺失 → 抛 DEFINITION_INVALID。**结果（包装格式无法解析）属实，机制（未知键被拒）不实**。
  3. **格式来源与影响面窄**：workflow: 顶层包装是**基准引擎前端编辑器**的 V2 导出格式（dynamic-workflow-engine.md §23.6 dagStateToYaml L5038，基准 updateWorkflow 按 yamlObj.workflow ?? yamlObj 双格式兼容 L4720）；sandore 自己的 DagEditor 序列化是 serializeWorkflowYaml = stringify(definition)（平铺、无包装），UI 源码无任何包装产出；全仓测试/规范样例（yaml-parser.spec.ts v2Yaml、附录 A.1）全是平铺格式。包装 YAML **只能经外部导入**进入 sandore（粘贴基准前端或仿照该格式的第三方工具导出文件），所有入口（remote.ts createDefinition L90、updateYaml L140，workflow-engine.ts 载入，DagEditor 打开 L692）都汇入 parseWorkflowYaml 单一漏斗——修解析器即全覆盖。
  4. **修复成本与风险极低**：一行守卫 + 现成 isRecord 收窄（yaml-parser.ts L31-33），语义与基准完全一致（typeof source.workflow === 'object' 才解包）；不会误伤合法定义（schema 顶层无 workflow 字段）；workflow: "字符串" / workflow: [] 不解包仍按缺失必填报错；解包须在 convertLegacyToV2 **之前**（包装是容器，内层才做 V1/V2 检测——包了 V1 的 workflow: { stages: [{scenarios}] } 同样受益）；当前无任何测试锁定「拒绝包装格式」的行为，补测试安全。
  5. **报告夸大**：影响面「某些工具」实指基准前端编辑器导出（及仿照者），sandore 自身编辑器往返（serialize→parse）完全不受影响；机制描述（Zod 拒未知键）不实。但缺失本身真实、修复成本一行。严重度 P3 合理。
- **修复计划**（具体、可执行、含文件级方向；不实施）：
  1. **yaml-parser.ts**（parseWorkflowYaml L252）：解包前置到 V1 转换之前——`let data: unknown = document.toJS(); if (isRecord(data) && isRecord(data.workflow)) { data = data.workflow }; data = convertLegacyToV2(data)`（随后 schema.parse / validateReferences 不变；isRecord 已存在无需新增依赖）。
  2. **yaml-parser.spec.ts** 补三组用例：① workflow: 包装的 V2 YAML 解析成功且结果与平铺等价；② workflow: 包装的 V1 YAML（内层 stages[].scenarios[]）解析成功（验证解包先于 V1 转换）；③ workflow: "文本" / workflow: [] 不解包，仍抛 DEFINITION_INVALID（缺失必填）。
  3. **构建与验证**：重新构建 workflow 包（tsdown 产物 lib/yaml.js、lib/index.js）及 ui bundle（ui/lib/client.js 内联的 parseWorkflowYaml），重启 dev 实例（端口 3090）后手工验证：粘贴 workflow: 包装 YAML 到 createDefinition/updateYaml 成功；编辑器保存-重开往返仍相等。
  4. **文档同步**：将 docs/design/engine-defact-analysis.md 缺陷 32 状态改为「已分析 ⚠️ 部分存在」；可在 docs/engine/dynamic-workflow-engine.md L4720 附近或 design.md §5.9 标注 sandore 已兼容包装格式。
  5. **明确不做**：不改 WorkflowDefinitionSchema（保持 strip 即可——解包后必填字段天然校验；加 .strict() 反而会让平铺 + 未知顶层字段的定义从「宽容接受」变「拒绝」，属行为倒退）。
- **修复计划状态**：待实施（需用户批准后另行执行）

---

## 缺陷 33：`hasUnresolvedVars` 缺失

- **状态**：✅ 已判定（非缺陷——纯工具函数组织差异，无功能缺口；并入缺陷 34 实现时顺带提取）
- **来源**：engine-defact.md #33（🟡 功能缺失）；与缺陷 34 关联
- **报告摘要**：sandore 无通用 hasUnresolvedVars 函数，finalize-manager 内联正则检查 passThroughVars 值，无法被其他模块复用（如 outputTo 路径检查）。
- **涉及文件**：`microflow/src/finalize-manager.ts`（hasUnresolvedPassThroughVars L340-342 / fillUnresolvedSingleVar L707-717 两处内联正则）、`microflow/src/file-utils.ts`（replacePassThroughVars L62-67 同族正则 / writeOutputJson/readOutputJson L180-240 无生产调用）、`microflow/src/finalize-manager.spec.ts`（L467/L489/L518 等 ${v} 用例）、`workflow/src/schema.ts`（OutputToItemSchema L77-82）
- **判定**：❌ 非缺陷（能力存在且正确，仅内联未提取为命名函数；报告影响段不实）
- **原因/结论**：
  1. **sandore 内联正则实况（能力存在且起作用）**：全仓 `/\$\{[^}]+\}/` 仅 2 处，均在 finalize-manager.ts——L340-342 hasUnresolvedPassThroughVars（决定 needsAssess 跳过检查）、L707-717 fillUnresolvedSingleVar（单未解析变量回退提取）；两处均只作用于 passThroughVars[].value，语义与基准 hasUnresolvedVars 完全等价，且被 spec 覆盖（finalize-manager.spec.ts L467/L489/L518 等 value: '${v}' 用例）。「未解析变量检查」能力在 sandore 存在、正确、有测试——只是内联未提取为命名函数。
  2. **补充：replacePassThroughVars（file-utils.ts L62-67）已内嵌同族正则** `/\$\{([^}]+)\}/g`，检测能力本可由此派生（str !== replacePassThroughVars(str, {})）。变量替换原语齐全，能力面不缺。
  3. **outputTo 路径的 ${xxx} 场景在 sandore 无任何真实使用点（属缺陷 34 范畴）**：verifyArtifacts（finalize-manager.ts L572-590）直接以原始 pattern 走 findFilesByGlob/findFilesByRegex，全程无变量替换；glob 分支 globToRegex 将 ${} 转义为字面量，regex 分支 $ 当锚点——路径含 ${xxx} 时永远匹配不到文件 → gate 报 missing。机械影响链真实存在，但这是缺陷 34（resolveOutputToVars 缺失）的 subject。全仓无任何测试/示例/文档在 outputTo path/regex 中使用 ${}（spec 中 outputTo 均为字面量）。
  4. **报告影响段自相矛盾**：「inputFrom path/regex 的未解析变量检查不完整」不实——sandore 的 inputFrom path 是 step-id 就近匹配（resolvePathSegments），regex 是 Step 输出文本匹配，两者均无 ${} 语义；基准 hasUnresolvedVars 也只用于 outputTo（resolveOutputToVars 内），inputFrom 从不是调用方。报告唯一站得住的 impact「无法被其他模块复用（如 outputTo 路径检查）」——其唯一潜在调用点就是缺陷 34 的 resolveOutputToVars，该调用点当前不存在 → 无功能缺口，纯代码组织差异（可内联可提取）。
  5. **与缺陷 34 的关系**：若 34 判为缺失（⚠️ 设计过未实现，证据 dynamic-workflow-engine.md §15.1/§15.2/§21.6 与 §5.5 API 表 L1472），33 只是 34 的工具函数前置，应并入 34 实现；两种情形下 33 都不应单独成缺陷。
  6. **影响面**：无运行时功能缺口——needsAssess 门控与单变量回退提取均正确工作；仅同一文件内正则重复 2 次 + 与 replacePassThroughVars 同族的 DRY 组织差异。
- **修复计划**（并入缺陷 34 实现，不单列）：
  1. 在缺陷 34 的修复中一并完成：`file-utils.ts` 新增导出 `hasUnresolvedVars(str): boolean { return /\$\{[^}]+\}/.test(str); }`（与 replacePassThroughVars 同文件，共享同一变量语法语义）。
  2. `finalize-manager.ts` L341 与 L713 两处内联正则改调 hasUnresolvedVars，消除重复。
  3. 否则保持现状，不新增任何代码。
- **修复计划状态**：无需修复（作为独立缺陷）；并入缺陷 34 修复时顺带提取共享函数

---

## 缺陷 34：`resolveOutputToVars` 缺失

- **状态**：✅ 已判定（部分存在——设计内特性、实现完全缺失、影响窄、低优先级增强；已定修复计划；与缺陷 33/16 联动）
- **来源**：engine-defact.md #34（🟡 功能缺失）；与缺陷 33/16 关联
- **报告摘要**：outputTo 路径中 passThroughVars 占位符的解析与延迟机制缺失，产物收集时路径仍含 `${xxx}` 字面量无法匹配。
- **涉及文件**：`microflow/src/finalize-manager.ts`（GateEvaluator.evaluate L537 / verifyArtifacts L571-590 原样传入无替换 / persistFinalize 回写 L699-701）、`microflow/src/file-utils.ts`（replacePassThroughVars L62-67 从不作用于 outputTo）、`microflow/src/stage-executor.ts`（toVarMap L387 / state.passThroughVars 累加器 L513/L602）、`microflow/src/finalize-manager.spec.ts`（无 ${} outputTo 用例）、`workflow/src/schema.ts`（OutputToItemSchema L77-82 无约束）、`ui/src/client/DagEditor.tsx`（OutputRow L481-515 自由文本可输 ${xxx} 无提示）、`docs/engine/dynamic-workflow-engine.md`（§15.1 outputTo 变量用例 / §15.2 运行时替换清单 / §15.3/§21.6 延迟解析决策 / §5.5 API 表 L1472）
- **判定**：⚠️ 部分存在（真实功能缺口：设计文档明示支持 + 实现完全缺失；影响窄、低优先级增强）
- **原因/结论**：
  1. **outputTo 变量替换是设计内特性**：仓库自带设计文档 dynamic-workflow-engine.md（sandore 的活设计参考——schema.ts 注释与其 DEFAULT_SETTINGS 对齐）§15.1 明确给出 outputTo 变量用例：「步骤 B 的 outputTo 路径中需要使用 `artifacts/${projectName}/report.md`，透传变量让 `${projectName}` 在运行时被替换为 my-project」；§15.2 运行时替换清单含 resolveOutputToVars() → 替换 outputTo 中的 ${xxx}；§15.3/§21.6 记录延迟解析决策（未解析时保存原始 outputTo、finalize 后恢复重解析）；§5.5 API 表（L1472）亦列出 resolveOutputToVars。这不是「把基准特性当默认」，而是设计文档明示、实现遗漏。
  2. **sandore 实况**：resolveOutputToVars 全仓不存在；replacePassThroughVars（file-utils.ts L62）只作用于 shell command（step-runner L373）、prompt/agent taskText（L230）、条件 promptText/command（branch-evaluator L258-285）、shell env，**从不作用于 outputTo**。outputTo.path/regex 的唯一生产消费点是 GateEvaluator.verifyArtifacts（finalize-manager.ts L571-590，L537 调用），**原样传入** findFilesByGlob/findFilesByRegex，无任何替换。
  3. **时序（延迟解析数据条件天然具备）**：verifyArtifacts 位于 finalize 门禁阶段，前置 Step 已提取变量已在 state.passThroughVars 累加器（stage-executor L387/513/602），但本 Step 当次新提取变量要等 gate 之后 persistFinalize（L699-701）才回写——「延迟到 finalize 再解析」的条件具备，只是没人做替换（自引用变量需回写提前或把 assessResult.passThroughVars 传入 evaluate 才能解析）。
  4. **真实故障模式（比报告机制更硬、触发面更窄）**：报告称「产物收集时路径含 ${xxx} 无法匹配」，但 sandore 实际**没有产物收集**（缺陷 16：finalizeStageContract files 硬编码 []、FinalizeStepContext.artifacts 生产代码从不传入），收集类消费不存在。真实影响收窄为门禁校验：outputTo.path 含 ${xxx} 且任一门禁 enabled 时——无 * /? 走 findFilesByRegex，`new RegExp('${projectName}')` 的 $ 行尾锚 + 花括号字面量**永不匹配**（形如 ${2} 还抛 invalid regex）；含 glob 字符则 globToRegex 转义后按字面 ${xxx} 目录匹配同样不命中 → 确定性报 missing output files → gatesPassed 覆盖为 false → Step 失败。门禁未启用时 outputTo 路径完全不被使用，无任何影响。
  5. **UI/示例依据**：DagEditor OutputRow（L481-515）为自由文本输入，可输入 ${xxx} 且无禁用/提示；schema OutputToItemSchema（L77-82）仅 id/path/regex，无字段语义约束；仓库内全部 YAML 示例与测试 outputTo 均为字面路径，无任何 ${} 用例 → 实际使用面窄、当前大概率无人踩中，与 🟡 低严重度匹配。
  6. **与缺陷 33/16 的关联**：①缺陷 33（hasUnresolvedVars 缺失）：34 的「检查未解析→延迟」机制依赖通用工具，sandore 只有 finalize-manager 内联正则（L341/L713）查 passThroughVars 值，不可复用于 outputTo——修 34 应一并补 33 的共享函数；②缺陷 16（collectStepArtifacts 缺失）：一旦修 16，变量替换就成为收集正确性的前置——34 与 16 共享「解析 outputTo→匹配文件」核心，宜同批修复。
- **修复计划**（具体、可执行、含文件级方向；不实施）：
  1. **共享工具**（microflow/src/file-utils.ts）：新增 hasUnresolvedVars(str)（对应缺陷 33）+ 纯函数 resolveOutputToVars(outputTo, vars)：对 path/regex 用现有 replacePassThroughVars 替换，替换后仍含 ${} 的项标记为延迟项返回。
  2. **执行前预解析**（microflow/src/stage-executor.ts finishCommandNode 附近）：用 toVarMap(state.passThroughVars) 对 outputTo 预替换（对应基准「已解析立即替换」）。
  3. **门禁时解析**（microflow/src/finalize-manager.ts）：GateEvaluator.evaluate 增加 vars 入参（toVarMap(request.passThroughVars) + 当次 assessResult.passThroughVars）；verifyArtifacts（L571-590）在 findFilesBy* 前先替换 item.path/regex；或将回写提前到门禁评估前，使自引用变量可解析（对应「未解析延迟到 finalize」）。**时序兼容注意**：若采用「回写提前」，需保证与 persistFinalize（L689-703）的时序一致——当次 assessResult.passThroughVars 是快照（评估时的提取结果），提前回写后 persistFinalize 的最终回写不得覆盖已应用值或产生中间态不一致；建议在 evaluate 内用「传入的 vars 副本」解析 outputTo，不依赖提前持久化（避免 assess 与 gate 之间的变量竞态）。
  4. **测试**（finalize-manager.spec.ts）：补 outputTo.path: "artifacts/${projectName}/report.md" + 累加器含 projectName 时文件存在→门禁通过、缺失→报 missing 两态用例；yaml 往返含 ${} outputTo 用例。
  5. **与缺陷 16 联动**：实现 collectStepArtifacts 时复用同一份「已解析 outputTo」列表，保证收集、门禁校验、<artifacts> 提示词块三方一致；docs/design/engine-defact-analysis.md 缺陷 33/34 条目更新结论。
- **修复计划状态**：待实施（需用户批准后另行执行；与缺陷 33/16 联动）

---

## 缺陷 35：`ConflictError` 缺失

- **状态**：✅ 已判定（非缺陷——架构性消除资源冲突场景，错误码完备性理论差异）
- **来源**：engine-defact.md #35（🟡 功能缺失）
- **报告摘要**：sandore 的 SandoreErrorCode 无 CONFLICT 码，最接近的是 INVALID_OPERATION，前端按 code 路由错误时无法区分「操作不合法」与「资源冲突」。
- **涉及文件**：`microflow/src/errors.ts`（SandoreErrorCode L20-36 12 个码无 CONFLICT / SandoreError L45-53）、`workflow/src/errors.ts`（re-export）、`workflow/src/remote.ts`（createDefinition L91 强制 uuid / startInstance L179 workflow 不存在用 INVALID_OPERATION / deleteDefinition L124-128 幂等）、`workflow/src/workflow-engine.ts`（startInstance L223 instanceId = randomUUID / abort/recover 终态守卫 L321-373）、`workflow/src/recovery-manager.ts`（retryStep L144-155 状态守卫）、`workflow/src/lifecycle-manager.ts`（pauseStep L117-128 / resumeStep L157-161 状态守卫）、`workflow/src/interaction-manager.ts`（replyQuestion L223 / replyPermission L238）、`workflow/src/yaml-parser.ts`（重复 id DEFINITION_INVALID L167-189）、`ui/src/client/describe-error.ts`（L10 只取 message）、`ui/src/client/remote.ts`（SandoreRemoteError 保留 code L23-35）、`ui/src/client/sandore-save.ts`（describeSaveError L86-97 唯一按 code 分支）、`ui/src/client/run-view-model.ts`、`ui/src/client/locales.ts`（全 {message} 模板）
- **判定**：❌ 非缺陷（事实断言属实但空洞：sandore 不存在任何真实「资源冲突」调用点，前端不按 code 路由运行类错误）
- **原因/结论**：
  1. **事实断言属实但空洞**：microflow/src/errors.ts L20-36 的 SandoreErrorCode（12 个码）确实无 CONFLICT，最接近的是 INVALID_OPERATION——报告的「缺码」这一事实陈述为真。
  2. **sandore 不存在任何真实「资源冲突」调用点**：createDefinition（remote.ts L91）每次强制 wfl-${crypto.randomUUID()}，客户端哨兵 id（wfl-new）不回写持久化文本——永无重复定义 id；name/version 仅元数据、非唯一键（同名定义可并存，不冲突）。startInstance（workflow-engine L223）instanceId = randomUUID()，且不禁止同一 workflow 并发多开（设计上允许）——实例模型根本没有 name，「重复创建同名实例」场景在 sandore 被架构性消除（基准的冲突源是命名实例，sandore 用 uuid 寻址替代）。updateYaml/updateDefinition：无版本号、无乐观锁（If-Match），last-write-wins——无版本冲突。删除幂等（remote L124-128/L192-195）、重复 pause 幂等 no-op（lifecycle-manager L132）、persistence 的 KvTable.put 为 upsert 语义不拒绝重复键。唯一「重复」场景是 YAML 内重复 stage/step id → 已由 WorkflowYamlError('DEFINITION_INVALID')（yaml-parser L167-189）覆盖，属定义校验语义而非运行时资源冲突。
  3. **全部 20+ 处 INVALID_OPERATION 均为该码本义**：状态守卫「操作不合法」——pauseStep 对终态/非子代理 Step（lifecycle-manager L117-128）、resumeStep 对未暂停（L157-161）、retryStep 对非 failed/非子代理（recovery-manager L144-155）、abort/recover 对终态实例（workflow-engine L321-373）、replyQuestion/replyPermission 对未知或已回复 requestId（interaction-manager L223/L238，二次提交亦属状态守卫）。无一处是「重复创建/重名/版本冲突」语义。附带发现：remote.startInstance L179 对「workflow 不存在」用 INVALID_OPERATION 属 not-found 标错码（应 NODE_NOT_FOUND），但与 CONFLICT 无关，不改变判定。
  4. **前端不按 code 路由，报告影响面不成立**：describeError（describe-error.ts）只取 .message，注释明确「调用方永不按消息内容路由控制流」；SandoreRemoteError 确实保留 code（remote.ts L23-35），但所有 UI 组件（RunView/DagEditor/InstanceList/DefinitionList/NewInstanceDialog）一律 describeError 平铺展示，无任何按 code 分支；唯一按 code 处理的是保存流程 describeSaveError（sandore-save.ts L86-97），分支对象是 YAML 校验详情，与 CONFLICT 无关；locales 全部是 {message} 模板、无 code 键文案。因此「无法区分两种错误、展示不合适提示或重试策略」目前无发生路径。
  5. **影响面评估**：缺 CONFLICT 仅是错误码完备性的理论差异，补码将产生零调用点的死码；而 INVALID_OPERATION 的全部现有调用点语义均准确。
- **修复计划**（无需修复）：
  1. 无需修复——sandore 的 id 生成策略（定义/实例/请求全 uuid）使资源冲突在架构上不可达，「重名实例」「版本冲突」等基准 ConflictError 场景在 sandore 无对应物；现有 INVALID_OPERATION 调用点全部准确（状态守卫/不存在语义），无一处被 CONFLICT 语义掩盖；前端不按 code 路由运行类错误，缺码不影响任何用户可感知的错误质量。
  2. 若未来引入可碰撞的用户命名资源（如定义 name 唯一约束）或乐观锁版本控制，届时再补 CONFLICT 码并让对应抛出点使用之——当前引入只会成为无调用点的死码，违反代码库「路由只按 code、不产生死码」的既有约束。
  3. **附带登记（not-found 标错码）**：remote.startInstance L179 对「workflow 不存在」抛 INVALID_OPERATION（应 NODE_NOT_FOUND）——与本缺陷（CONFLICT）无关，但已登记为独立小修复项（改码零回归，前端 describeError 平铺展示不受影响），建议并入后续错误码整理批次。
- **修复计划状态**：无需修复；（可选）未来引入可碰撞命名资源时再补 CONFLICT 码

---

## 补充发现 36：Step 上下文传递缺「按需压缩总结」（Workflow-Lab 式 fork 总结机制）

- **状态**：✅ 已判定（非缺陷——基准侧误判已修正：Workflow-Lab 并无 fork 总结机制，每 Step 新建会话与 sandore 同构；sandore 全量注入为与基准同构的合理行为；「压缩/截断」为低优先级增强）
- **来源**：用户提问（非 engine-defact.md 35 项内）；Workflow-Lab 基准机制对照（用户澄清基准无 fork 总结）；与缺陷 12/25 关联
- **报告摘要**：Workflow-Lab 在每个 Step 的会话 fork 分支中总结，按下一个 Step 的输入要求做类压缩（轻量），只传递足够且精简的上下文；分支、循环判断也走 fork 分支。sandore 无此机制。
- **涉及文件**：`microflow/src/step-runner.ts`（renderPreviousOutputs L190-211 全量注入 / buildPromptText L247-268 / textSummary 经 internal.ts L35-46 仅提 text 无压缩）、`microflow/src/stage-executor.ts`（toPreviousOutput L154-161 全量收集 / state.previousOutputs L591）、`microflow/src/branch-evaluator.ts`（分支判断走 ctx.llm.stream 一次性临时会话 L5-12）、`microflow/src/loop-manager.ts`（checkLoopBreak L179-207 同样临时会话）、`workflow/src/dag-navigator.ts`（L216 分支评估传空上下文）、`microflow/src/file-utils.ts`（resolveShellStdin 按 inputFrom 选 stdin 是「选择性」先例 L300-333）
- **判定**：❌ 非缺陷（基准同构——基准无 fork 总结机制，sandore 全量注入为合理行为）；「截断上限」为低优先级增强（非缺陷修复）
- **原因/结论**：
  1. **基准侧误判已修正（用户澄清）**：Workflow-Lab **并无**「每 Step 会话 fork 分支中总结压缩」机制——其执行模型同样是每 Step 新建会话、上下文靠 prompt 注入传递，与 sandore **同构**。原分析把 Workflow-Lab 描述为「fork 总结压缩」是主代理对基准机制的误读；基准的 `fork` 仅用于重试/恢复（与 sandore recovery-manager 的 revert/fork 语义一致），不用于上下文总结。因此「sandore 缺 Workflow-Lab 式压缩」**不构成缺陷**。
  2. **sandore 上下文传递实况（与基准同构）**：previousOutputs 机制（stage-executor.ts L154-161 → step-runner.ts L190-211）把前置 Step 的 `textSummary(step.output)`（internal.ts L35-46，仅提取 text 块）拼进下一 Step 的 prompt「## 前置Steps输出与产物」——**与基准的 prompt 注入方式一致**，无压缩是两引擎共有行为而非 sandore 缺失。
  3. **分支/循环判断**：BranchEvaluator（branch-evaluator.ts）走 `ctx.llm.stream()` 一次性临时会话，shell 条件走 ctx.shell.run，循环跳出走 checkLoopBreak（loop-manager.ts L179）同样临时会话——与基准判断机制同构（基准同样以独立评估调用判断分支/循环），「判断走会话延续」非基准特性。
  4. **增强价值（保留为低优先级）**：多 Step 链式工作流（前置输出大、Step 多）prompt 线性膨胀是真实工程问题（成本上升、上下文稀释）——但这是**两引擎共有**的通用优化空间，非与基准的差异缺陷。作为增强建议记录：硬截断（`.slice(0, 4000)` 对齐 loop-manager BREAK_OUTPUT_MAX 先例）成本极低、风险极小，可先行；「按需 AI 总结」属新增能力（基准亦无），非补齐项。
  5. **与缺陷 12/25 的关联（不变）**：缺陷 25/12 说的是「分支评估缺历史 Step 输入」（判断侧上下文空），与本条目的「传递侧无压缩」是不同层面；缺陷 12/25 修复（注入 I/O）独立于本条目，不受定性降级影响。
- **修复计划**（非缺陷，无行为修复；附低优先级增强建议）：
  1. **硬截断（推荐，低成本增强）**：`step-runner.ts` renderPreviousOutputs（L190-211）或 `stage-executor.ts` toPreviousOutput（L154-161）对每前置 Step 输出 `.slice(0, 4000)`（对齐 loop-manager.ts L51 BREAK_OUTPUT_MAX 先例）+ 超长追加「…（已截断）」标记——防 prompt 线性膨胀，零 LLM 成本、零回归风险。
  2. **按需总结（可选增强，基准亦无，非补齐）**：新增 `summarizeStepOutput`（面向下一 Step 任务的一次性临时会话总结）——作为新能力评估，默认关闭防额外 LLM 成本；与「缺陷 36」的压缩语义无基准对照关系，仅产品增强。
  3. **测试**：多 Step 链式工作流断言 prompt 不含超长历史（截断生效）。
  4. **文档同步**：在 docs/engine/dynamic-workflow-engine.md 或 docs/design/task-3-full-dag/design.md 上下文传递章节补一句 sandore 的「全量注入 + 可选截断」策略说明。
- **修复计划状态**：无需修复（非缺陷）；（硬截断）低优先级增强待用户批准后另行评估

---

## 补充发现 37：SessionIdleWaiter 会话空闲等待机制未审计

- **状态**：✅ 已判定（机制等价覆盖但形态不同；当前串行模型足够，并发改造后需扩展；已定修复计划）
- **来源**：用户指出的审计遗漏（engine-defact.md 中 idleWaiter 仅 L654 构造参数片段出现一次，从未作为能力审计）；与缺陷 10 关联
- **报告摘要**：lab-3 的 SessionIdleWaiter（workflow-engine-v2.ts:512-514,963-969）是会话空闲等待 resolver 注册机制，与暂停/恢复协调相关；sandore 是否等价覆盖未审计。
- **涉及文件**：`microflow/src/subagents.ts`（Agent.whenIdle L47「当前整代理活动达到静止后 resolve」）、`microflow/src/step-runner.ts`（collectSubagentOutput L504-549 `await child.whenIdle()` L515/L538）、`workflow/src/workflow-engine.ts`（waitForResume L995-1012 / notifyResume L1015-1024 / resumeRequested 标志 / resumeWaiters）、`workflow/src/lifecycle-manager.ts`（resumeStep/resumeAllSteps 触发 notifyResume）、`microflow/src/stage-executor.ts`（暂停判定 isPausedStep L533-540）
- **判定**：⚠️ 机制等价覆盖但形态不同（基准「按会话维度注册 resolver 的统一注册表」vs sandore「直接 await 单 child 的 whenIdle + 引擎级 resume waiter」）
- **原因/结论**：
  1. **职责拆分为两个原语**：lab-3 SessionIdleWaiter 的「会话空闲等待」职责在 sandore 被拆成——①会话级空闲等待 = DSH 子代理原生 `Agent.whenIdle()`（subagents.ts L47），step-runner.ts L515 每次执行后 await 子代理静止；②暂停/恢复协调 = 引擎级 `waitForResume`/`notifyResume`（workflow-engine.ts L995-1024）。两原语分工明确：whenIdle 等**子代理执行静止**，waitForResume 等**用户 resume 信号**（resume 先行标志 + waiter 注册 + abort 监听竞争，防 paused 期中止永久悬挂）。
  2. **与基准的语义差异**：lab-3 的 SessionIdleWaiter 是「会话级 resolver 注册表」（可对任意 sessionId 注册/触发空闲等待回调）；sandore 是「单 child 直接 await + 实例级 resume waiter」——粒度不同但当前覆盖等价：串行模型下至多一个活跃子代理，whenIdle await 即等价于「等当前 Step 的会话静止」。
  3. **暂停路径的协调**：pauseStep（lifecycle-manager.ts L114-145）interrupt 子代理 → whenIdle 以取消类错误拒绝 → stage-executor isPausedStep（L533-540）命中登记表判定 paused → 主循环进入 waitForResume（workflow-engine.ts L684）；resumeStep 经 notifyResume（L1015-1024）唤醒——resume 竞态（resume 先于主循环进入等待）由 resumeRequested 标志覆盖（L996-999）。
  4. **并发改造影响（关联缺陷 10）**：队列驱动真并发后多 Step 同时 running，`await child.whenIdle()` 需扩展为 `Promise.all(multiChildren.map(c => c.whenIdle()))`，waitForResume 的多路唤醒（多 Step 各自暂停/恢复）也需按 Step 维度拆分 waiter——当前单 waiter 模型在并发下不够（与缺陷 10 的恢复多路续跑同批处理）。
  5. **影响面**：当前串行模型无功能缺口（暂停/恢复/竞态均已覆盖且有测试：lifecycle-manager.spec L273-323/L522-602 暂停恢复、workflow-engine.spec L1295 whenIdle 挂起）；并发改造后成为前置条件。
- **修复计划**（具体、可执行、含文件级方向；不实施）：
  1. **当前无需改动**：串行模型下 whenIdle + waitForResume/notifyResume 已等价覆盖 SessionIdleWaiter 职责；补文档说明（本条目即补审计）。
  2. **并发改造时（随缺陷 10 统一实施）**：step-runner collectSubagentOutput（L504-549）对多 child 用 `Promise.all(whenIdle)`；workflow-engine waitForResume/notifyResume（L995-1024）改为按 Step 维度维护 resumeWaiters（Map<stepId, resolve[]>），resumeStep 只唤醒目标 Step 的 waiter，resumeAllSteps 唤醒全部。
  3. **补测试**：并发后多 child 同时 whenIdle 挂起 → 全部静止才推进；暂停其中一个 Step 只阻塞该 Step 的 waiter、其他 Step 继续（并发语义）。
  4. **文档同步**：engine-defact.md L654 处或分析文档标注「idleWaiter 已审计，等价覆盖见补充发现 37」。
- **修复计划状态**：当前无需修复；（并发扩展）随缺陷 10 队列驱动真并发改造统一实施

---

## 补充发现 38：SSE 断线重连 + 客户端状态重放未审计

- **状态**：✅ 已判定（「推送+增量重放」被「轮询全量状态」架构替代——断线重连问题被消解，真实损失为实时性与事件驱动；已定修复计划）
- **来源**：用户指出的审计遗漏（engine-defact.md L21 判「合理」未展开；task-4-lifecycle design.md D5 L853-858 决策全用 DSH）；与缺陷 9/11/14 关联
- **报告摘要**：lab-3 的 SseManager 在 engine 包内含断线重连逻辑（指数退避 1s→30s）；sandore 改用 DSH 原生后「浏览器断线重连后如何补齐增量状态」是否等价未验证。
- **涉及文件**：`ui/src/client/RunView.tsx`（getInstanceState 轮询 L9/L95-130，运行中 5s 终态停）、`ui/src/client/InstanceList.tsx`（POLL_INTERVAL_MS=1500 即 1.5s 轮询 L27/L28/L119-153）、`ui/src/client/run-view-model.ts`（isRunning L88-90 驱动轮询 / isTerminal L97）、`workflow/src/remote.ts`（getInstanceState 全量状态返回）、`workflow/src/workflow-engine.ts`（sandore/* 事件双发 Cordis + Session.append）、`docs/design/task-4-lifecycle/design.md`（D5 L853-858 决策）、`docs/engine/dsh-workflow.md`（L593-610 决策 D5 明细：SSE 重连由 apiproxy SSE 客户端与 ctx.sessionPersistence 承担）
- **判定**：⚠️ 架构替代成立但报告「合理」未展开——断线重连+增量重放被轮询全量状态消解；真实损失 = 实时性 + 无事件驱动 UI
- **原因/结论**：
  1. **sandore 前端实况（关键发现）**：sandore 工作流 UI **根本不用 SSE**——RunView 用 `getInstanceState` 轮询（运行中 5s、终态停，RunView.tsx L9/L116-130），InstanceList 轮询（L27/L119-153，`POLL_INTERVAL_MS=1500` 即 1.5s，InstanceList.tsx L28）；`sandore/*` 事件双发（Cordis + Session.append）仅供宿主主会话 UI 消费，工作流视图不订阅事件流（无 EventSource/subscribe 命中）。
  2. **断线重连问题被消解**：lab-3 的「浏览器断线 → SSE 断 → 指数退避重连 → 增量事件补发」在 sandore 不存在——断线不刷新、重连后**下一轮询即拿到全量状态快照**（getInstanceState 返回 WorkflowTaskState），无增量补齐需求、无 partId 修复、无事件序号对齐问题。`ctx.sessionPersistence` 持久化的是宿主会话事件（供主会话 UI 与 open-discussion 跳转），工作流状态本身靠 state 表全量快照。
  3. **与崩溃恢复的关系（缺陷 9/11/14）**：断线期间引擎继续执行 → 快照持续落盘（onPersist 逐 Step）→ 重连后轮询读到最新快照——恰好规避了「断线期间状态丢失」；真正的状态恢复问题（引擎侧 recoverInstance / recoverOrphanedInstances）由缺陷 9/11/14 覆盖，前端侧无需状态重放协议。
  4. **真实损失**：①**实时性**——推送（事件到达即渲染）→ 轮询（最长 5s 延迟），Step 完成/ask 弹出/权限请求的 UI 呈现延迟；②**无事件驱动 UI**——依赖轮询的 isRunning/isTerminal 判定（run-view-model.ts L88-97），无 push 通知；③**RPC 成本**——轮询全量状态（含 executedSteps/sessionMessages）每 5s 一次，大工作流状态序列化开销。
  5. **判定定性**：功能等价（状态可达性、断线恢复）但体验降级（实时性）；「合理」判定方向对，但未审计「重连后增量补齐」的替代机制——补审计结论：**无需重连协议，轮询全量已覆盖**。
- **修复计划**（具体、可执行、含文件级方向；不实施）：
  1. **保持轮询（当前架构，无缺陷修复）**：轮询全量状态已等价覆盖断线重连+增量重放；补文档说明（本条目即补审计）。可优化轮询间隔（5s → 3s）或按事件触发局部刷新（低优先级）。
  2. **可选事件驱动增量（增强，非缺陷修复）**：前端订阅 `sandore/*` 事件（经 DSH Session append 通道，若宿主主会话已消费则可复用）实现「事件到达 → 主动 getInstanceState 刷新」——保留全量快照语义同时消除轮询延迟；需接入 Session 事件订阅（当前 RunView 无此接线，评估宿主通道可达性）。
  3. **状态体积优化（可选）**：getInstanceState 返回分页/裁剪（如 executedSteps 超 N 条截断或增量游标），降低轮询序列化成本。
  4. **补测试**：轮询逻辑已有覆盖（run-view-model.spec）；如做事件驱动增量，补「事件到达触发刷新、去抖合并」用例。
  5. **文档同步**：engine-defact.md L21 处或分析文档标注「SSE 断线重连已审计：轮询全量状态替代，等价覆盖见补充发现 38」。
- **修复计划状态**：当前无需修复（架构替代成立）；（事件驱动增量）可选增强待用户批准后另行评估

---

## 补充发现 39：maxConcurrentSteps 死配置 + 并发 batch 内行为回归

- **状态**：✅ 已判定（**已在缺陷 10 完整覆盖，非遗漏**；本条目为交叉引用收口，避免重复分析）
- **来源**：用户指出的审计遗漏（源报告 engine-defact.md L2392 只列「合理适配」未点出）；完整分析见缺陷 10
- **报告摘要**：源报告把「Promise.race 真并发 → Stage 级线性循环 + batch」列为低严重度合理适配，但漏审两点：①batch 内是否真并发；②maxConcurrentSteps 死旋钮。
- **判定**：✅ 已判定（非遗漏——分析文档缺陷 10 已完整覆盖；本条目为源报告 L2392 漏审的收口说明）
- **交叉引用**：→ 详见 **缺陷 10**（engine-defact-analysis.md L226-246）「多并发 running 步骤只恢复第一个」
- **原因/结论**（摘要，完整论证见缺陷 10）：
  1. **batch 内严格串行（已在缺陷 10 L234 点出）**：StageExecutor.runLoop（stage-executor.ts L393-424）内层逐个 `await processCommandNode`（L415），无 Promise.all/race——并行分支只是把多个 nextNodeIds 塞进 nextBatch，晋升 batch 后仍逐个串行执行，并行分支吞吐回归；microflow 全仓 Promise.all/race 零命中。
  2. **maxConcurrentSteps 死旋钮（已在缺陷 10 L235 点出）**：schema 声明（workflow-engine.ts L194 / seam.ts L124 / lib/types/seam.d.ts L151）但引擎从未读取（grep this.config. 仅 defaultTimeoutMs/defaultProvider/defaultModel），microflow 执行路径零引用——配置了也无法恢复并发。
  3. **用户决策**：用户已确认需**队列驱动真并发改造**（pendingQueue 出队→执行→解析→入队、并行分支同时执行、maxConcurrentSteps 真正生效），在 35 项缺陷分析完成后统一规划——缺陷 10 已含完整修复计划（L239-246）。
  4. **本条目定位**：仅为源报告 L2392「合理适配」漏审的收口说明——分析文档在缺陷 10 已覆盖，无需新增分析；源报告该行应标注「未审计点已并入缺陷 10」。
- **修复计划**（见缺陷 10，不重复）：
  1. 队列驱动真并发改造（stage-executor runLoop 重写 / maxConcurrentSteps 生效 / pendingQueue 驱动）——详见缺陷 10 修复计划 1-6。
  2. 文档同步：engine-defact.md L2392 处标注「maxConcurrentSteps 死配置与 batch 串行已并入缺陷 10 分析」。
- **修复计划状态**：待实施（随缺陷 10 队列驱动真并发改造统一实施）

---
