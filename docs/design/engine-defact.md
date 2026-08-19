# sandore vs workflow-lab-3/engine 工作流引擎对比报告

> **对比范围**：`sandore`（适配 DSH web 插件）vs `workflow-lab-3\package\engine`（基准引擎）
> **对比方法**：7 个并行子代理逐模块、逐函数对比，覆盖 46 个基准文件和 30 个 sandore 源文件
> **重点**：基准有但 sandore 缺失的功能，以及两者不一致的逻辑错误
> **分类**：🔴逻辑错误 / 🔴功能缺失 / 🟡逻辑差异 / 🟡功能缺失 / 🟢合理适配差异

---

## 一、架构范式差异（合理适配，非缺陷）

sandore 将基准的「独立 EventEmitter 引擎 + SDK 会话 + SQLite + 文件持久化 + SSE 事件总线」整体迁移为 DSH 原生范式。这些差异是架构迁移的合理结果，不影响功能正确性：

| 基准 (workflow-lab-3) | sandore | 判定 |
|---|---|---|
| `WorkflowEngineV2 extends EventEmitter` | `SandoreEngineRuntime extends Service` | 合理 |
| SDK session (createSession/sendChat) | DSH subagents (agents.create/followup) | 合理 |
| SQLite DDL + Mapper | DSH storageDomain KvTable | 合理 |
| work.json / chat.json 文件持久化 | KvTable state 表 + Session.append | 合理 |
| WorkflowEventBus (EventEmitter) | Cordis ctx.emit + Session.append | 合理 |
| WorkflowSseManager (SDK SSE) | DSH 子代理系统原生管理 | 合理 |
| 纯函数 API (api/\*.ts) | TypertRemoteService RPC (@Remote) | 合理 |
| Job 概念 (DDL + API + Mapper) | 有意移除（实例直接绑定定义） | 合理 |
| node:child_process exec | ctx.shell.resolve/run | 合理 |

---

## 二、高严重度问题（需优先修复）

### 🔴 逻辑错误 1：`matchesExpectation` 实现完全不同

**模块**：辅助函数 / 分支评估 / 循环跳出

**影响**：`matchesExpectation` 是分支路由和循环跳出判定的核心匹配函数，被 `evaluateBranches`（条件分支匹配）、`checkLoopBreak`（shell 类型 breakCondition 匹配）和 `decideCondition`（shell 类型 condition 匹配）三处调用。两个引擎的行为完全不同，会导致同一工作流在两个引擎下分支路由和循环跳出判定结果不同。例如 `output="Task completed successfully"`, `expectation="task"`：基准匹配成功（包含 + 大小写不敏感），sandore 不匹配（精确 + 大小写敏感）。
**基准实现**（`internal/engine/workflow-engine-helpers.ts`）— 大小写不敏感的相等或包含匹配：

```typescript
/** Check if the model output matches an expectation.
 *  Supports exact match and case-insensitive contains match. */
export function matchesExpectation(output: string, expectation: string | undefined): boolean {
  if (!expectation) return false; // parallel branches are never matched by condition output
  const normalizedOutput = output.toLowerCase().trim();
  const normalizedExpectation = expectation.toLowerCase().trim();
  return normalizedOutput === normalizedExpectation || normalizedOutput.includes(normalizedExpectation);
}
```

基准的语义是：先把 output 和 expectation 都转小写再 trim，然后判断「完全相等」或「output 包含 expectation」。

**sandore 实现**（`microflow/src/branch-evaluator.ts`）— 区分 regex 元字符，无元字符时精确匹配（大小写敏感）：

```typescript
/** 含 regex 元字符时判定 expectation 为正则，否则视为字面字符串。 */
function hasRegexMetacharacters(value: string): boolean {
  return /[\\^$.*+?()[\]{}|]/.test(value);
}

/**
 * 判定分支评估结果是否匹配 expectation：expectation 含 regex 特征时做正则匹配
 * （正则非法视为不匹配），否则字符串相等比较。
 */
export function matchesExpectation(result: string, expectation: string): boolean {
  if (hasRegexMetacharacters(expectation)) {
    let regex: RegExp;
    try {
      regex = new RegExp(expectation);
    } catch {
      return false;
    }
    return regex.test(result);
  }
  return result === expectation;
}
```
sandore 的语义是：如果 expectation 含 regex 元字符（如 `.` `*` `+` 等），就当正则用；否则做大小写敏感的精确字符串比较。

**关键差异总结**：
- 基准：`output.toLowerCase().includes(expectation.toLowerCase())` — 包含匹配，大小写不敏感
- sandore：`result === expectation` — 精确匹配，大小写敏感
- sandore 额外引入 regex 模式匹配（基准无此能力，但 regex 能力在分支场景中用处不大且引入了元字符误判风险）

---

### 🔴 逻辑错误 2：`decideCondition` 与 `buildBranchPrompt` 格式不匹配

**模块**：分支评估器

**影响**：**所有条件分支永远不通过**，条件分支路由完全失效。这是当前最严重的 bug——任何使用 `condition` 的条件分支 Step 都无法被正确路由。问题链路是：sandore 的 `buildBranchPrompt` 要求 AI 返回 `{"shouldExecute": true}` JSON 格式，但 `decideCondition` 检查 `output.trim().toLowerCase() === 'true'`。当 AI 遵循提示词指令返回 JSON 时，`output` 的值是 `{"shouldExecute": true}`，不等于字符串 `'true'`，布尔判定永远失败。根因是 sandore 的 `collect()` 不做 `extractExpectation` 提取（基准的 `collect()` 内部会从 AI 输出中提取字段值）。

**sandore `buildBranchPrompt`**（`microflow/src/branch-evaluator.ts`）— 要求 AI 返回 JSON：
```typescript
/** 构建结构化分支评估提示词（主头部 + 任务 + 上下文 + 分支列表 + 返回格式 + 红线规则）。 */
function buildBranchPrompt(taskText: string, contextMessage: string, branches: readonly DagBranch[]): string {
  const sections: string[] = [BRANCH_PROMPT_HEADER];
  sections.push('');
  sections.push('## 你的任务');
  sections.push(taskText);
  sections.push('');
  sections.push('## 参考信息');
  sections.push('### 前置上下文');
  sections.push(contextMessage);
  sections.push('');
  sections.push('## 候选分支');
  if (branches.length === 0) {
    sections.push('（无显式分支，请依据任务判断返回 shouldExecute）');
  }
  for (const branch of branches) {
    const label = branch.label ?? branch.next;
    sections.push(`- ${label}`);
  }
  sections.push('');
  sections.push('## 返回格式');
  sections.push('请仅返回 JSON，格式为：{"shouldExecute": true} 或 {"shouldExecute": false}，其中 shouldExecute 表示是否执行当前候选分支。');
  sections.push('');
  sections.push('## 红线规则');
  for (const rule of BRANCH_RED_LINES) {
    sections.push(`- ${rule}`);
  }
  return sections.join('\n');
}
```

**sandore `collect()` 不提取字段**（`microflow/src/branch-evaluator.ts`）— 直接返回原始输出文本：

```typescript
  /** 收集评估结果：聚合 AI 输出文本（shell 直接返回 stdout）。 */
  async collect(partial: BranchEvalPartial): Promise<BranchEvalResult> {
    const output = await partial.outputPromise;
    return { output, sessionHandle: partial.sessionHandle };
  }
```
**sandore `decideCondition`**（`workflow/src/dag-navigator.ts`）— 检查纯文本 `'true'`：

```typescript
  /** 按 condition 类型判定条件分支是否通过。 */
  private decideCondition(condition: CommandConfig, output: string, expectation: string | undefined): boolean {
    if (condition.type === 'shell') {
      if (expectation === undefined) {
        return false;
      }
      return matchesExpectation(output.trim(), expectation);
    }
    return output.trim().toLowerCase() === 'true';
  }
```

**基准的对照**：基准的 `evaluateBranches` 用 `extractExpectation` 从 JSON 中提取 `branchExpectation` 字段值，然后用 `matchesExpectation` 匹配分支的 `expectation`：

```typescript
  async evaluateBranches(node: DagNodeRef): Promise<string[]> {
    const branches = node.branches!;
    const parallelBranches = branches.filter(b => !b.expectation);
    const conditionalBranches = branches.filter(b => b.expectation);

    if (node.condition && conditionalBranches.length > 0) {
      const evaluator = new BranchEvaluator(this.engine.getCwd(), this.engine.getDefaultTimeoutMs(), this.engine.getJobId(), this.engine.getTaskId(), node.id);

      // 基准构建详细上下文提示词（含 Step I/O + 分支列表），完整实现见 #12
      const partial = await evaluator.start(node.condition, contextMsg);
      const result = await evaluator.collect(partial);

      const matchedTargets: string[] = [];
      for (const branch of conditionalBranches) {
        if (matchesExpectation(result.output, branch.expectation)) {
          logger.info(`[WorkflowEngineV2] Branch matched: expectation="${branch.expectation}", next=${branch.next}`);
          matchedTargets.push(branch.next);
        }
      }

      for (const branch of parallelBranches) {
        matchedTargets.push(branch.next);
      }
      return matchedTargets;
    }
    return branches.map(b => b.next);
  }
```
**修复方向**：要么让 `decideCondition` 解析 JSON 提取 `shouldExecute` 字段（类似基准的 `extractExpectation`），要么让 `buildBranchPrompt` 要求 AI 直接返回 `true`/`false` 纯文本。

---

### 🔴 逻辑错误 3：`checkLoopBreak` 调用时机 off-by-one

**模块**：DAG 导航器 / 循环管理

**影响**：sandore 先递增 `visitCount` 再调用 `checkLoopBreak`，导致 `checkLoopBreak` 看到的 visitCount 比实际迭代次数大 1。如果 `maxIterations` 检查基于 visitCount，sandore 可能**提前一轮跳出循环**。举例：假设 `maxIterations=3`。第一次迭代时 visitCount 应为 1，第二次为 2，第三次为 3（达到上限跳出）。但 sandore 在调用前就 +1，所以第一次迭代时传入的 visitCount 已经是 2，第三次迭代时传入的是 4 ≥ 3，提前一轮跳出。

**基准**（`internal/engine/workflow-dag-navigator.ts`）— **递增前**调用 `checkLoopBreak`：

```typescript
  async resolveNextNodes(node: DagNodeRef): Promise<void> {
    if (node.loop) {
      // 确定 loopToNodeId（同 Stage 的回边目标，省略 loopToNodeId 匹配逻辑）
      const isCurrentLoopContinuation = this.engine.getLoopManager().activeLoopNodeId !== null && loopToNodeId &&
        (this.engine.getLoopManager().activeLoopNodeId === loopToNodeId || this.engine.getLoopManager().activeLoopNodeId!.startsWith(loopToNodeId + '-') || loopToNodeId.startsWith(this.engine.getLoopManager().activeLoopNodeId! + '-'));

      const wasInLoop = this.engine.getLoopManager().activeLoopNodeId !== null;

      // checkLoopBreak BEFORE increment/push — the step's loopIteration matches the current (pre-increment) path
      const shouldBreak = await this.engine.getLoopManager().checkLoopBreak(node);
      if (shouldBreak) {
        logger.info(`[WorkflowEngineV2] Loop break on node ${node.id}, exitTo=${node.loop.exitTo}`);
        if (wasInLoop && isCurrentLoopContinuation) {
          this.engine.getLoopManager().resetLoopVisitCounts(node.id);
          this.engine.getLoopManager().popActiveLoop();
        }
        if (node.loop.exitTo) {
          const exitToNode = this.nodeIndex.get(node.loop.exitTo);
          if (exitToNode && exitToNode.stage.id === node.stage.id) {
            await this.enqueueTargetNode(node.loop.exitTo);
          }
        }
        return;
      }

      // Loop continues — apply pending meta BEFORE increment/push (uses current path)
      this.engine.getLoopManager().applyPendingLoopMeta();

      // Now increment/push for the next iteration
      if (wasInLoop && isCurrentLoopContinuation) {
        this.engine.getLoopManager().incrementLoopIteration();
      } else if (wasInLoop && !isCurrentLoopContinuation && loopToNodeId) {
        this.engine.getLoopManager().pushActiveLoop(loopToNodeId);
      } else if (!wasInLoop && loopToNodeId) {
        this.engine.getLoopManager().pushActiveLoop(loopToNodeId);
      }
      // 继续循环（enqueue loop.next / 评估 branches / 处理 node.next）
    }
  }
```

基准的 `checkLoopBreak` 内部从引擎获取 visitCount（递增前的值）：
```typescript
  async checkLoopBreak(node: DagNodeRef): Promise<boolean> {
    const loop = node.loop!;
    const visitCount = this.engine.getVisitCounts().get(node.id) ?? 0;

    // Check maxIterations
    if (visitCount >= loop.maxIterations) {
      logger.info(`[WorkflowEngineV2] Loop maxIterations reached: ${visitCount} >= ${loop.maxIterations}`);
      return true;
    }
    // breakCondition 评估（见下文完整 contextMsg 构建）
  }
```

**sandore**（`workflow/src/dag-navigator.ts`）— **递增后**调用 `checkLoopBreak`：

```typescript
    for (const branch of loopBranches) {
      const loop = branch.loop!;
      if (this.loopManager.activeLoopNodeId === node.id) {
        // 回边：累计访问计数，判定跳出或继续下一迭代。
        const visitCount = (context.visitCounts[node.id] ?? 0) + 1;
        context.visitCounts[node.id] = visitCount;
        const outcome = await this.loopManager.checkLoopBreak(
          { id: node.id, loop },
          visitCount,
          { input: '', output: '', passThroughVars: context.passThroughVars },
        );
        if (outcome.shouldBreak) {
          this.loopManager.popActiveLoop();
          const exitTo = loop.exitTo;
          loopResult = {
            nextNodeIds: exitTo !== undefined && this.sameStageStep(node, exitTo) !== undefined ? [exitTo] : [],
            ...(outcome.loopMeta === undefined ? {} : { loopMeta: outcome.loopMeta }),
          };
          break;
          }
        this.loopManager.incrementLoopIteration();
        const loopTo = loop.next;
        if (loopTo !== undefined && this.sameStageStep(node, loopTo) !== undefined) {
          loopResult = { nextNodeIds: [loopTo] };
          break;
        }
        loopResult = { nextNodeIds: [] };
        break;
      }
    }
```

sandore 的 `checkLoopBreak` 用传入的 visitCount 检查 maxIterations（visitCount 已被递增过）：

```typescript
  async checkLoopBreak(node: LoopNode, visitCount: number, context?: LoopBreakContext): Promise<LoopBreakOutcome> {
    const loop = node.loop;
    if (loop === undefined) {
      return { shouldBreak: false };
    }
    if (visitCount >= loop.maxIterations) {
      return { shouldBreak: true };
    }
    // breakCondition 评估（见下文完整 contextMsg 构建）
  }
```
---

### 🔴 逻辑错误 4：`checkLoopBreak` 传入空 I/O 上下文

**模块**：DAG 导航器 / 循环管理

**影响**：AI 类型的 breakCondition（agent/prompt/skill/mcp）无法参考 Step 实际输入输出，可能做出错误跳出判定。循环跳出条件通常需要根据 Step 的执行结果来判断（如「如果输出包含'完成'则跳出」），但 sandore 传入空字符串导致 AI 无法参考任何 Step 执行结果，只能基于 breakCondition 自身的 promptText 和循环上下文判断。

**基准**（`internal/engine/workflow-loop-manager.ts`）— 从引擎读取完整 Step I/O 并构建详细上下文：

```typescript
  async checkLoopBreak(node: DagNodeRef): Promise<boolean> {
    const loop = node.loop!;
    const visitCount = this.engine.getVisitCounts().get(node.id) ?? 0;

    if (visitCount >= loop.maxIterations) {
      logger.info(`[WorkflowEngineV2] Loop maxIterations reached: ${visitCount} >= ${loop.maxIterations}`);
      return true;
    }

    if (loop.breakCondition) {
      const evaluator = new BranchEvaluator(this.engine.getCwd(), this.engine.getDefaultTimeoutMs(), this.engine.getJobId(), this.engine.getTaskId(), node.id);
      // Build step input/output context — only current step's input, not all historical
      const currentStepDef = this.engine.getNodeIndex().get(node.id);
      const stepInput = currentStepDef ? this.engine.readStepInputForFinalize(currentStepDef) : this.engine.getRecentStepInput();
      const recentOutput = this.engine.readStepOutputText(node.id);

      // Build break condition prompt text
      const condition = loop.breakCondition;
      const conditionPrompt = condition.type === 'agent'
        ? condition.value.agentTemplate ?? ''
        : condition.type === 'prompt'
          ? condition.value.promptText ?? ''
          : condition.value.command ?? '';

      // Build XML input/output block
      const indentedInput = stepInput.split('\n').map((l) => `    ${l}`).join('\n');
      const indentedOutput = (recentOutput || '').slice(0, 4000).split('\n').map((l) => `    ${l}`).join('\n');

      // Read artifacts for current step
      const currentArtifacts = currentStepDef ? this.engine.collectStepArtifacts(currentStepDef) : [];
      const currentArtifactFiles = currentArtifacts.flatMap((a) => a.value);
      const artifactsXml = currentArtifactFiles.length > 0
        ? `\n  <artifacts>\n${currentArtifactFiles.map((f) => `    - ${f}`).join('\n')}\n  </artifacts>`
        : '';
        const contextMsg = `你是严谨准确的Step执行后循环跳出判断Agent，你的任务是准确完成\`## 你的任务\`中的要求，完成当前Step的执行后循环跳出判断。

## 你的任务
1. 遵守\`## 红线事项\`的原则，遵循\`## 用户配置的跳出循环条件提示词\`的步骤和要求，参考 \`## 当前Step的输入输出\` 的内容，快速但准确地判断出接下来是否应该跳出循环
2. 准确按照 \`## 返回JSON样式\` 的样式，如果应该跳出循环则shouldBreak为true，否则为false，然后返回这个JSON结果（禁止把结果写入文件，直接返回结果即可）

## 用户配置的跳出循环条件提示词
${conditionPrompt}

## 当前Step的输入输出
<${node.id}>
  <input>  // 当前Step的输入
${indentedInput}
  </input>
  <output>  // 当前Step的输出
${indentedOutput}
  </output>${artifactsXml.replace('<artifacts>\n', '<artifacts>  // 当前Step的产物\n')}
</${node.id}>

## 返回JSON样式
\`\`\`json
{
  "shouldBreak": true/false
}
\`\`\`
## 红线事项
1. 如果当前任务实际未完成，禁止擅自继续执行
2. 禁止除了读取操作之外的操作，比如git commit, edit, write, rm等等
3. 禁止太长思考，不要思考太多，从任务输入输出，和当前项目现状来考虑
4. 非必要不搜索当前项目
5. 禁止把结果写入文件，直接返回结果即可
6. 禁止过度严格的验收标准，重要的是step按照要求输出或者生成相关内容，如果你怀疑其虚构内容，你可以自行查询验证`;

      const partial = await evaluator.start(loop.breakCondition, contextMsg);
      // 评估并判定 shouldBreak（见 #4 完整 contextMsg）
    }
  }
```

**sandore**（`workflow/src/dag-navigator.ts`）— 传入空字符串：

```typescript
    for (const branch of loopBranches) {
      const loop = branch.loop!;
      if (this.loopManager.activeLoopNodeId === node.id) {
        const visitCount = (context.visitCounts[node.id] ?? 0) + 1;
        context.visitCounts[node.id] = visitCount;
        const outcome = await this.loopManager.checkLoopBreak(
          { id: node.id, loop },
          visitCount,
          { input: '', output: '', passThroughVars: context.passThroughVars },
        );
      }
    }
```
sandore 的 `LoopManager.checkLoopBreak`（`microflow/src/loop-manager.ts`）接收 context 后构建上下文消息，但 input/output 为空导致 `<input>`/`<output>` 块内容为空：

```typescript
  async checkLoopBreak(node: LoopNode, visitCount: number, context?: LoopBreakContext): Promise<LoopBreakOutcome> {
    const loop = node.loop;
    if (loop === undefined) {
      return { shouldBreak: false };
    }
    if (visitCount >= loop.maxIterations) {
      return { shouldBreak: true };
    }
    const breakCondition = loop.breakCondition;
    if (breakCondition === undefined) {
      return { shouldBreak: false };
    }
    const contextMessage = buildBreakContextMessage(context);
    const result = await this.evaluator.evaluate(breakCondition, contextMessage, {
      loopTurn: this.currentLoopTurn(),
      loopMaxIterations: this.currentLoopMaxIterations(),
      ...(context?.passThroughVars === undefined ? {} : { passThroughVars: context.passThroughVars }),
    });
    const loopMeta: BranchMeta = {
      status: 'completed',
      result: result.output,
      ...(result.sessionHandle === null ? {} : { sessionId: result.sessionHandle }),
      ...(loop.breakExpectation === undefined ? {} : { expectation: loop.breakExpectation }),
    };
    return {
      shouldBreak: this.decideBreak(breakCondition, result.output, loop.breakExpectation),
      loopMeta,
    };
  }
```

---

### 🔴 逻辑错误 5：`resolveStepGates` 浅合并 vs 字段级深度合并

**模块**：引擎辅助函数

**影响**：如果 Step 只定义了 `gates.primary`（未定义 `gates.secondary`），sandore 的浅合并会用 Step 的 gates 对象覆盖 stage/workflow 的 gates，导致 stage/workflow 的 `secondary` 配置丢失。举例：workflow.gates = `{ primary: { enabled: true }, secondary: { enabled: true, prompt: "审查代码质量" } }`，step.gates = `{ primary: { enabled: false } }`。基准结果：`primaryEnabled=false, secondaryEnabled=true, secondaryPrompt="审查代码质量"`（secondary 从 workflow 继承）；sandore 结果：`{ primary: { enabled: false } }`（secondary 丢失）。

**基准**（`internal/engine/workflow-engine-v2.ts`）— 字段级深度合并（`primary` 和 `secondary` 各自独立回退）：
```typescript
  /**
   * Resolve gates for a step using 3-level merge (就近原则, field-level deep merge):
   * - step.gates.primary ?? stage.gates.primary ?? workflow.gates.primary
   * - step.gates.secondary ?? stage.gates.secondary ?? workflow.gates.secondary
   * - maxRetries/maxTokens/need_confirm: ignored for now
   * Returns resolved gates with defaults: primary.enabled=true, secondary.enabled=false
   */
  resolveStepGates(stepDef: WorkflowStepDef, stage: WorkflowStageDef): { primaryEnabled: boolean; secondaryEnabled: boolean; secondaryPrompt?: string } {
    const wfGates = this.definition.gates ?? {};
    const stGates = stage.gates ?? {};
    const spGates = stepDef.gates ?? {};

    const primary = spGates.primary ?? stGates.primary ?? wfGates.primary;
    const secondary = spGates.secondary ?? stGates.secondary ?? wfGates.secondary;

    return {
      primaryEnabled: primary?.enabled ?? true,
      secondaryEnabled: secondary?.enabled ?? false,
      secondaryPrompt: secondary?.prompt,
    };
  }
```
基准的语义是：`primary` 和 `secondary` 各自独立做 3 级回退。如果 Step 只定义了 `primary`，`secondary` 会从 stage/workflow 继承。

**sandore**（`microflow/src/stage-executor.ts`）— 整个 gates 对象覆盖式合并：

```typescript
/** 三级门禁浅合并（workflow → stage → step，后者覆盖前者）。 */
function mergeGates(workflowDef: WorkflowDefinition, stageDef: WorkflowStage, step: WorkflowStep): Gates | undefined {
  const workflowGates = workflowDef.gates;
  const stageGates = stageDef.gates;
  const stepGates = step.gates;
  if (workflowGates === undefined && stageGates === undefined && stepGates === undefined) {
    return undefined;
  }
  return {
    ...(workflowGates ?? {}),
    ...(stageGates ?? {}),
    ...(stepGates ?? {}),
  };
}
```
sandore 的语义是：用 spread 操作符做对象级覆盖。如果 `stepGates = { primary: { enabled: true } }`，则合并结果中 `secondary` 字段会丢失（因为 stepGates 没有 secondary，spread 后整个 stepGates 覆盖了前面的 secondary）。

---

### 🔴 逻辑错误 6：产物校验 — 非 glob path 用 regex 替代 existsSync

**模块**：收尾管理器 / 文件工具

**影响**：sandore 对非 glob 的 `outputTo.path` 用 `findFilesByRegex` 匹配（内部 `new RegExp(path)`），路径中的 `.` 被解释为正则元字符（匹配任意字符）。例如 `./output/result.txt` 中的 `.` 会匹配任意字符，虽然通常能碰巧匹配到正确文件，但语义错误且可能误匹配其他文件（如 `./outputXresult_txt` 也会匹配）。

**基准**（`internal/engine/workflow-finalize-manager.ts`）— 非 glob path 用 `fs.existsSync` 精确文件存在检查：

```typescript
  collectStepArtifacts(stepDef: WorkflowStepDef): Array<{ id: string; value: string[] }> {
    const artifacts: Array<{ id: string; value: string[] }> = [];
    if (!stepDef.outputTo || stepDef.outputTo.length === 0) return artifacts;
    const cwd = this.engine.getCwd();
    for (const item of stepDef.outputTo) {
      const matched: string[] = [];
      if (item.path) {
        const isGlob = looksLikeGlob(item.path);
        if (isGlob) {
        try { matched.push(...this.findFilesByGlob(cwd, item.path)); } catch { /* ignore bad glob */ }
        } else {
          const absPath = path.resolve(cwd, item.path);
          if (fs.existsSync(absPath)) matched.push(absPath);
        }
      }
      if (item.regex) {
        const isGlob = looksLikeGlob(item.regex);
        try {
          if (isGlob) { matched.push(...this.findFilesByGlob(cwd, item.regex)); }
          else { matched.push(...this.findFilesByRegex(cwd, new RegExp(item.regex))); }
        } catch {
          if (isGlob) { try { matched.push(...this.findFilesByRegex(cwd, new RegExp(item.regex))); } catch { /* ignore */ } }
        }
      }
      artifacts.push({ id: item.id, value: matched });
    }
    return artifacts;
  }
```

基准在产物校验（finalizeStepVars 的 primary gate）中也用同样的逻辑：
    ```typescript
    // Primary gate: artifact check (skip if primary.enabled = false)
    if (taskStatus === 'done' && primaryEnabled && stepDef.outputTo && stepDef.outputTo.length > 0) {
      const failures: string[] = [];
      const cwd = this.engine.getCwd();
      for (const item of stepDef.outputTo) {
        if (item.path) {
          const isGlob = looksLikeGlob(item.path);
          if (isGlob) {
            try {
              const matches = this.findFilesByGlob(cwd, item.path);
              if (matches.length === 0) failures.push(`path "${item.path}" 未匹配到文件`);
            } catch { failures.push(`path "${item.path}" glob匹配失败`); }
          } else {
            const absPath = path.resolve(cwd, item.path);
            if (!fs.existsSync(absPath)) failures.push(`path "${item.path}" 文件不存在`);
          }
        }
        if (item.regex) {
          const isGlob = looksLikeGlob(item.regex);
          try {
            let matches: string[];
            if (isGlob) {
              matches = this.findFilesByGlob(cwd, item.regex);
            } else {
              matches = this.findFilesByRegex(cwd, new RegExp(item.regex));
            }
            if (matches.length === 0) failures.push(`regex "${item.regex}" 未匹配到文件`);
          } catch { failures.push(`regex "${item.regex}" 匹配失败`); }
        }
      }
      if (failures.length > 0) {
        taskStatus = 'error';
        errorDetail = `产物校验失败: ${failures.join('; ')}`;
      }
    }
```
**sandore**（`microflow/src/finalize-manager.ts`）— 非 glob path 也用 `findFilesByRegex`：

```typescript
  /** 校验 outputTo 产物文件存在；返回缺失的 pattern 列表。 */
  private async verifyArtifacts(step: WorkflowStep, workdir: string): Promise<string[]> {
    const missing: string[] = [];
    for (const outputTo of step.outputTo ?? []) {
      if (outputTo.regex !== undefined) {
        const found = await findFilesByRegex(this.ctx.fs, workdir, outputTo.regex);
        if (found.length === 0) {
          missing.push(outputTo.regex);
        }
      } else if (outputTo.path !== undefined) {
        const found = isGlobPattern(outputTo.path)
          ? await findFilesByGlob(this.ctx.fs, workdir, outputTo.path)
          : await findFilesByRegex(this.ctx.fs, workdir, outputTo.path);
        if (found.length === 0) {
          missing.push(outputTo.path);
        }
      }
    }
    return missing;
  }
```

`findFilesByRegex` 内部 `new RegExp(regex)`，路径 `./output/result.txt` 中的 `.` 被解释为「匹配任意字符」。

---

### 🔴 功能缺失 7：`resolveStepRules` 完全缺失
**模块**：引擎主循环

**影响**：`workflow.rules` 定义存在于 schema 中但不会被解析和应用到 Step 的提示词。工作流规则（如代码规范、安全约束等）完全无效，Step 执行时看不到任何规则约束。基准在 Step 执行前解析规则（3 级合并：step.rules ∪ stage.rules，两者都空则继承所有 workflow.rules），并通过 `runner.setResolvedRules(resolvedRules)` 注入到 StepRunner，StepRunner 在构建提示词时注入 `## 任务规则` 节。sandore 无此方法，stage-executor 的 `mergeGates` 只合并 gates 不处理 rules。

**基准**（`internal/engine/workflow-engine-v2.ts`）— 3 级合并（就近原则）：

```typescript
  /**
   * Resolve rules for a step using 3-level merge (就近原则):
   * 1. union(step.rules, stage.rules) — deduplicated
   * 2. Both empty → inherit all workflow.rules keys
   * 3. Look up each key in workflow.rules
   * Returns a map of rule key → rule content.
   */
  private resolveStepRules(stepDef: WorkflowStepDef, stage: WorkflowStageDef): Record<string, string> {
    const workflowRules = this.definition.rules ?? {};
    const stepRules = stepDef.rules ?? [];
    const stageRules = stage.rules ?? [];

    // Determine which rule keys to use
    let keys: string[];
    if (stepRules.length === 0 && stageRules.length === 0) {
      // Both empty → inherit all workflow.rules
      keys = Object.keys(workflowRules);
    } else {
      // Union with dedup
      keys = [...new Set([...stepRules, ...stageRules])];
    }
    // Look up each key in workflow.rules
    const result: Record<string, string> = {};
    for (const key of keys) {
      if (workflowRules[key]) {
        result[key] = workflowRules[key];
      }
    }
    return result;
  }
```

基准在 `executeStepNode` 中调用并注入到 StepRunner：

```typescript
  async executeStepNode(node: DagNodeRef, options: StepExecutionOptions = { mode: 'normal' }): Promise<void> {
    const stepDef = node.step!;
    const stageId = node.stage.id;
    const stepId = stepDef.id;
    const { mode } = options;

    if (mode === 'normal') {
      // Clear refresh=true passThroughVars before step execution
      for (const v of stepDef.passThroughVars ?? []) {
        if (v.refresh) {
          const entry = this.finalizeManager.getPassThroughVars().get(v.name);
          if (entry) {
            this.finalizeManager.getPassThroughVars().set(v.name, { value: '', description: entry.description, refresh: entry.refresh });
          }
        }
      }
      // Resolve rules for this step (3-level merge)
      const resolvedRules = this.resolveStepRules(stepDef, node.stage);

      runner = new WorkflowStepRun(stepDef, this.cwd, this.defaultTimeoutMs, getInstanceDir(this.jobId, this.taskId), idleWaiter, () => this._permissionMode, { skills: this.definition.skills, mcps: this.definition.mcps, agents: this.definition.agents });
      runner.setResolvedRules(resolvedRules);
      runner.actualStepId = this.getActualStepId(stepId);
      runner.stepId = stepId;
      runner.loopIteration = this.loopManager.buildLoopIterationPath()?.slice(-1)[0] ?? 0;
      runner.loopMaxIterations = activeLoopNode?.loop?.maxIterations ?? 0;
      runner.skipCollectOutput = true;
      this.stepRunners.set(runner.actualStepId, runner);
      this.relayStepEvents(runner);
    }
  }
```

**sandore**：无等价物。`workflow.rules` 定义存在于 schema 但 stage-executor 的 `mergeGates` 只合并 gates，不处理 rules。StepRunner 构建提示词时无 `## 任务规则` 节。

---

### 🔴 功能缺失 8：Step 级重试能力完全缺失

**模块**：步骤执行器
**影响**：无法在 Step 级别进行 revert/fork 重试。基准的 `WorkflowStepRunner.retry()` 支持 continue（同会话续接）、revert（回退到指定消息点 `revertSession`）、fork（分叉新会话 `forkSession`）三种模式。sandore 的 `RecoveryManager.retryStep` 虽然有 continue/revert/fork 三模式声明，但 revert/fork 依赖 `sessions.fork` + `agents.create`，缺少 SDK 级别的 `revertSession`/`unrevertSession`/`forkSession` 完整会话操作，无法真正实现消息点回退。

**基准**（`internal/engine/workflow-step.ts`）— 三种重试模式 + 会话操作：

```typescript
class WorkflowStepRunner extends EventEmitter {
  // continue 模式：同会话续接
  async retry(mode: 'continue', userMessage: string): Promise<void> {
    await this.sendChat(userMessage);
  }

  // revert 模式：回退到指定消息点
  async retry(mode: 'revert', userMessage: string, revertMessageId?: string): Promise<void> {
    if (revertMessageId) {
      await this.revertSession(this._sessionId!, revertMessageId, this._directory);
    }
    await this.sendChat(userMessage);
  }

  // fork 模式：分叉新会话
  async retry(mode: 'fork', userMessage: string): Promise<void> {
    await this.forkSession(this._sessionId!, this._directory);
    await this.sendChat(userMessage);
  }
  initForRetry(sessionId: string): void {
    this._sessionId = sessionId;
    this._status = 'running';
    this._resumePromise = null;
  }

  async revertSession(sessionId: string, messageId: string, directory: string): Promise<void> {
    // SDK client.revertSession — 回退到指定消息点
    const client = getClient();
    await client.session.revert({ sessionID: sessionId, messageID: messageId, directory });
  }

  async forkSession(sessionId: string, directory: string): Promise<void> {
    // SDK client.forkSession — 分叉新会话
    const client = getClient();
    const result = await client.session.fork({ sessionID: sessionId, directory });
    this._sessionId = result.sessionID;
  }
}
```

**sandore**：`RecoveryManager.retryStep` 有三模式声明但缺少完整会话操作，revert 模式只能用 `sessions.fork` 在安全边界处分叉，无法精确回退到指定消息点。
---

### 🔴 功能缺失 9：`recover()` 崩溃恢复流程严重简化

**模块**：恢复管理器

**影响**：崩溃后恢复不完整。基准有 8 步全面恢复流程（A-H），包括恢复内存状态、清除 stale pending 交互、启动 SSE/EventBus、遍历所有需恢复步骤逐一预加载、持久化 + chat 对账、检查未执行步骤入队、主执行循环 + 完整 try/catch/finally 错误兜底。sandore 仅做步骤分类（shell/prompt 合成 session 标 failed，子代理 Step 继续）+ followup 第一个 running/interacting 步骤，无 chat 对账、无未执行步骤检查、无 try/catch 错误兜底。

**基准**（`internal/engine/workflow-recovery-manager.ts`）— 8 步全面恢复流程（A-H）：

```typescript
  async recover(persistedState: WorkflowTaskState): Promise<void> {
    const engine = this.engine;
    logger.info(`[WorkflowEngineV2] Recovering instance ${engine.getTaskId()}, status=${persistedState.status}`);

    // A) Restore all in-memory state
    this.restoreFromState(persistedState);

    // B) Clear stale pendingInteractions (old requestIds are invalid)
    engine.getInteractionManager().clearAll();

    // C) Start SSE + EventBus
    engine.startSharedSSE();
    engine.subscribeToEventBus();

    // D) Find steps that need recovery (running/interacting/paused)
    const stepsToRecover: Array<{ step: ExecutedStepDefault; node: DagNodeRef }> = [];
    for (const item of persistedState.executedSteps) {
        if (!['running', 'interacting', 'paused'].includes(item.status)) continue;

      const baseId = engine.getLoopManager().stripIdSuffix(item.id);
      const node = engine.getNodeIndex().get(baseId) ?? engine.getNodeIndex().get(item.id);
      if (!node?.step) {
        logger.warn(`[Recovery] Step ${item.id} not found in nodeIndex, skipping`);
        continue;
      }
      stepsToRecover.push({ step: item, node });
    }

    // E) Preload runners for all recoverable steps
    let hasPausedSteps = false;

    for (const { step, node } of stepsToRecover) {
      const stepId = step.id;
      const isPausedStep = step.status === 'paused';

      // Shell steps cannot be recovered
      if (step.command?.type === 'shell') {
        logger.warn(`[Recovery] Shell step ${stepId} cannot be recovered, marking as failed`);
        engine.updateStepStatusInExecutedSteps(stepId, 'failed');
        engine.getStepStatuses().set(stepId, 'failed');
        continue;
      }

      // Must have a sessionId to recover
      const sessionId = step.sessionMeta?.sessionId;
      if (!sessionId) {
        logger.warn(`[Recovery] Step ${stepId} has no sessionId, marking as failed`);
        engine.updateStepStatusInExecutedSteps(stepId, 'failed');
        engine.getStepStatuses().set(stepId, 'failed');
        continue;
      }
      // Preload: create runner, wire events, init paused state if needed
      this.preloadForRecovery(step, node, sessionId);

      if (isPausedStep) {
        hasPausedSteps = true;

        // Background promise: wait for user resume → collectOutput → runPostStepPipeline → resolveNextNodes
        const p = (async () => {
          try {
            const runner = engine.getStepRunners().get(stepId)!;
            await runner.waitForResumeAndComplete();
            const stepResult = await runner.collectOutput();

            const stepDef = node.step!;
            engine.getStepStatuses().set(stepId, 'completed');
            engine.updateStepStatusInExecutedSteps(stepId, 'completed');
            engine.emitInstanceEvent('workflow.step_status_changed', { stepId, status: 'completed' });
            engine.persistState();

            await engine.runPostStepPipeline(stepResult, node, stepDef.id, node.stage.id, stepDef, []);

            const entry = engine.findStepInExecutedSteps(stepId);
            if (entry) engine.finalizeExecutedStep(entry, stepDef);
            engine.emitInstanceEvent('workflow.step_completed', { stepId });
            await engine.resolveNextNodes(node);
            this.updateOverallStatusAfterRecovery();
            engine.persistState();

            if (engine.getPendingQueue().length > 0 && !engine.isAborted()) {
              const fatalError = await engine.runExecutionLoop();
              if (fatalError) throw fatalError;
              if (!engine.isAborted()) {
                const hasFailedSteps = engine.getExecutedSteps().some((item) => item.status === 'failed');
                if (hasFailedSteps) {
                  engine.updateStatus('failed');
                  engine.emitInstanceEvent('workflow.failed', { taskId: engine.getTaskId(), jobId: engine.getJobId(), error: 'One or more steps failed' });
                } else {
                  engine.updateStatus('completed');
                  engine.emitInstanceEvent('workflow.completed', { taskId: engine.getTaskId(), jobId: engine.getJobId() });
                }
                engine.persistState();
              }
            }
          } catch (err) {
            logger.warn(`[Recovery] Paused step ${stepId} failed after resume: ${err instanceof Error ? err.message : String(err)}`);
            engine.getStepStatuses().set(stepId, 'failed');
            engine.updateStepStatusInExecutedSteps(stepId, 'failed');
            engine.emitInstanceEvent('workflow.step_status_changed', { stepId, status: 'failed' });
            engine.emitInstanceEvent('workflow.step_failed', { stepId, error: err });
          } finally {
            if (engine.getStatus() !== 'failed' && engine.getStatus() !== 'paused') {
              engine.unsubscribeFromEventBus();
              engine.stopSharedSSE();
            }
          }
        })();
        void p;
      } else {
        // Running/interacting step: enqueue with recover mode
        engine.updateStepStatusInExecutedSteps(stepId, 'running');
        engine.getStepStatuses().set(stepId, 'running');
        engine.emitInstanceEvent('workflow.step_status_changed', { stepId, status: 'running' });
        engine.emitInstanceEvent('workflow.chat_updated', { jobId: engine.getJobId(), instanceId: engine.getTaskId() });
        engine.enqueueNode(stepId, { mode: 'recover', recoverSessionId: sessionId });
      }
    }

    // F) Persist state + reconcile chat
    engine.updateStatus(hasPausedSteps ? 'paused' : 'running');
    engine.persistState();
    reconcileChatState(engine.buildState(), engine.getJobId());
    engine.emitInstanceEvent('workflow.chat_updated', { jobId: engine.getJobId(), instanceId: engine.getTaskId() });

    // G) Before entering main loop, check if there are unexecuted steps in the current stage
    if (engine.getPendingQueue().length === 0 && !hasPausedSteps) {
      const resumed = engine.enqueueNextUnexecutedStep();
      if (resumed) {
        logger.info(`[Recovery] Enqueued unexecuted step ${resumed} after crash recovery`);
      }
    }
    // H) Main execution loop — processes enqueued running steps via executeStepNode
    try {
      const fatalError = await engine.runExecutionLoop();
      if (fatalError) throw fatalError;

      if (!engine.isAborted()) {
        const hasFailedSteps = engine.getExecutedSteps().some((item) => item.status === 'failed');
        if (hasFailedSteps) {
          engine.updateStatus('failed');
          engine.emitInstanceEvent('workflow.failed', { taskId: engine.getTaskId(), jobId: engine.getJobId(), error: 'One or more steps failed' });
        } else if (!hasPausedSteps) {
          engine.updateStatus('completed');
          engine.emitInstanceEvent('workflow.completed', { taskId: engine.getTaskId(), jobId: engine.getJobId() });
        }
        engine.persistState();
      }
    } catch (err) {
      if (!engine.isAborted()) {
        engine.updateStatus('failed');
        engine.emitInstanceEvent('workflow.failed', { taskId: engine.getTaskId(), jobId: engine.getJobId(), error: err });
        engine.persistState();
      }
      throw err;
    } finally {
      if (engine.getStatus() !== 'failed' && engine.getStatus() !== 'paused') {
        engine.unsubscribeFromEventBus();
        engine.stopSharedSSE();
      }
    }
  }
```
**sandore**（`workflow/src/recovery-manager.ts`）— 仅步骤分类 + followup 第一个：

```typescript
  async recover(): Promise<RecoverResult> {
    const state = this.deps.readState();
    const coldResumePrompt = '请从崩溃前的断点继续完成当前任务。';
    const running = state.executedSteps.filter(step => step.status === 'running' || step.status === 'interacting');

    // shell/prompt 合成 session：子进程已丢失，标 failed（不可恢复）。
    let hasFailure = false;
    for (const step of running) {
      if (isSubagentStep(step)) {
        continue;
      }
      this.commitStep(this.deps.readState(), { ...step, status: 'failed', error: 'synthetic session is not recoverable' });
      hasFailure = true;
    }

    // 仅 followup 第一个可续跑（running/interacting 子代理）Step，与引擎 `resumeStageId`/
    // `resumeInfo` 的 `.find()` 收口一致；其余并发 running Step 不 followup，避免「已
    // followup 但引擎不收口」的半恢复态。合成 session 失败时整体失败，不发起 followup。
    let hasResume = false;
    if (!hasFailure) {
      const resumeStep = running.find(isSubagentStep);
      if (resumeStep !== undefined) {
        const childId = childIdOf(resumeStep);
        await this.deps.followup(childId, textBlock(coldResumePrompt), this.deps.signal);
        hasResume = true;
      }
    }
    return { hasResume, hasFailure };
  }
```
**缺失的步骤**：
- B) 清除 stale pendingInteractions — sandore 无
- C) 启动 SSE + EventBus — sandore 无（DSH 框架管理，合理）
- E) 遍历所有需恢复步骤逐一预加载 — sandore 只处理第一个
- F) 持久化 + chat 对账 — sandore 无 chat 对账
- G) 检查未执行步骤入队 — sandore 无
- H) 主执行循环 + 错误处理 — sandore 无 try/catch/finally

---

### 🔴 功能缺失 10：多并发 running 步骤只恢复第一个

**模块**：恢复管理器

**影响**：并发执行的多个 Step 崩溃后只有一个被恢复，其余将永远停留在 running 状态。这在多分支并行执行场景下是严重问题——如果工作流有 3 个并行 Step 同时 running 时崩溃，只有第一个 agent/skill/mcp 类型的 Step 会被 followup 恢复，其余两个会卡在 running 状态永远无法完成，导致整个工作流实例卡死。

**基准**（`internal/engine/workflow-recovery-manager.ts`）— 遍历所有需恢复步骤，逐一入队 recover 模式：
```typescript
    // D) Find steps that need recovery (running/interacting/paused)
    const stepsToRecover: Array<{ step: ExecutedStepDefault; node: DagNodeRef }> = [];
    for (const item of persistedState.executedSteps) {
      if (!['running', 'interacting', 'paused'].includes(item.status)) continue;
      const baseId = engine.getLoopManager().stripIdSuffix(item.id);
      const node = engine.getNodeIndex().get(baseId) ?? engine.getNodeIndex().get(item.id);
      if (!node?.step) {
        logger.warn(`[Recovery] Step ${item.id} not found in nodeIndex, skipping`);
        continue;
      }
      stepsToRecover.push({ step: item, node });
    }

    // E) Preload runners for all recoverable steps
    for (const { step, node } of stepsToRecover) {
      const stepId = step.id;
      const isPausedStep = step.status === 'paused';

      if (step.command?.type === 'shell') {
        engine.updateStepStatusInExecutedSteps(stepId, 'failed');
        engine.getStepStatuses().set(stepId, 'failed');
        continue;
      }
      const sessionId = step.sessionMeta?.sessionId;
      if (!sessionId) {
        engine.updateStepStatusInExecutedSteps(stepId, 'failed');
        engine.getStepStatuses().set(stepId, 'failed');
        continue;
      }

      this.preloadForRecovery(step, node, sessionId);

      if (!isPausedStep) {
        // Running/interacting step: enqueue with recover mode — runExecutionLoop will handle it
        engine.updateStepStatusInExecutedSteps(stepId, 'running');
        engine.getStepStatuses().set(stepId, 'running');
        engine.emitInstanceEvent('workflow.step_status_changed', { stepId, status: 'running' });
        engine.emitInstanceEvent('workflow.chat_updated', { jobId: engine.getJobId(), instanceId: engine.getTaskId() });
        engine.enqueueNode(stepId, { mode: 'recover', recoverSessionId: sessionId });
      }
    }
```

**sandore**（`workflow/src/recovery-manager.ts`）— 用 `.find()` 只取第一个：
```typescript
    // 仅 followup 第一个可续跑（running/interacting 子代理）Step
    let hasResume = false;
    if (!hasFailure) {
      const resumeStep = running.find(isSubagentStep);
      if (resumeStep !== undefined) {
        const childId = childIdOf(resumeStep);
        await this.deps.followup(childId, textBlock(coldResumePrompt), this.deps.signal);
        hasResume = true;
      }
    }
```

---

### 🔴 功能缺失 11：`recover()` 无错误处理

**模块**：恢复管理器

**影响**：恢复过程中出错会导致实例卡在不确定状态。如果 `followup` 抛错（如子代理不存在、网络异常等），异常直接传播到调用方，实例状态不会更新为 failed，导致实例永远卡在 running 状态。用户在前端看到实例一直 running 但实际已经失败，无法区分「正在恢复」和「恢复失败」。基准有完整的 try/catch/finally：catch 中将实例标为 failed 并发射 `workflow.failed` 事件，finally 中清理 SSE/EventBus 资源。

**基准**（`internal/engine/workflow-recovery-manager.ts`）— 完整 try/catch/finally：
```typescript
    // H) Main execution loop
    try {
      const fatalError = await engine.runExecutionLoop();
      if (fatalError) throw fatalError;

      if (!engine.isAborted()) {
        const hasFailedSteps = engine.getExecutedSteps().some((item) => item.status === 'failed');
        if (hasFailedSteps) {
          engine.updateStatus('failed');
          engine.emitInstanceEvent('workflow.failed', { taskId: engine.getTaskId(), jobId: engine.getJobId(), error: 'One or more steps failed' });
        } else if (!hasPausedSteps) {
          engine.updateStatus('completed');
          engine.emitInstanceEvent('workflow.completed', { taskId: engine.getTaskId(), jobId: engine.getJobId() });
        }
        engine.persistState();
      }
    } catch (err) {
      if (!engine.isAborted()) {
        engine.updateStatus('failed');
        engine.emitInstanceEvent('workflow.failed', { taskId: engine.getTaskId(), jobId: engine.getJobId(), error: err });
        engine.persistState();
      }
      throw err;
    } finally {
      if (engine.getStatus() !== 'failed' && engine.getStatus() !== 'paused') {
        engine.unsubscribeFromEventBus();
        engine.stopSharedSSE();
      }
    }
```
**sandore**（`workflow/src/recovery-manager.ts`）— 无任何错误兜底：

```typescript
  async recover(): Promise<RecoverResult> {
    const state = this.deps.readState();
    const coldResumePrompt = '请从崩溃前的断点继续完成当前任务。';
    const running = state.executedSteps.filter(step => step.status === 'running' || step.status === 'interacting');

    let hasFailure = false;
    for (const step of running) {
      if (isSubagentStep(step)) {
        continue;
      }
      this.commitStep(this.deps.readState(), { ...step, status: 'failed', error: 'synthetic session is not recoverable' });
      hasFailure = true;
    }

    let hasResume = false;
    if (!hasFailure) {
      const resumeStep = running.find(isSubagentStep);
      if (resumeStep !== undefined) {
        const childId = childIdOf(resumeStep);
        await this.deps.followup(childId, textBlock(coldResumePrompt), this.deps.signal);
        hasResume = true;
      }
    }
    return { hasResume, hasFailure };
  }
```

---
### 🔴 功能缺失 12：分支评估缺乏 Step I/O 上下文

**模块**：DAG 导航器

**影响**：需要根据 Step 执行结果决定分支的场景完全失效。sandore 传空字符串给 BranchEvaluator，AI 评估分支时看不到 Step 实际做了什么，只能基于 condition 自身的 promptText 和分支列表判断。例如 condition 是「如果输出包含'错误'则走分支 B」，但 AI 看不到 output 内容，无法判断输出是否包含'错误'，只能随机选一个分支。基准的 `evaluateBranches` 构建了详细的 contextMsg，含 Step 输入/输出/artifacts/分支列表，AI 可以参考 Step 实际执行结果做出准确分支判定。

**基准**（`internal/engine/workflow-dag-navigator.ts`）— 为分支评估构建详细 contextMsg，含 Step 输入/输出/artifacts/分支列表：

```typescript
  async evaluateBranches(node: DagNodeRef): Promise<string[]> {
    const branches = node.branches!;
    const parallelBranches = branches.filter(b => !b.expectation);
    const conditionalBranches = branches.filter(b => b.expectation);

    if (node.condition && conditionalBranches.length > 0) {
      const evaluator = new BranchEvaluator(this.engine.getCwd(), this.engine.getDefaultTimeoutMs(), this.engine.getJobId(), this.engine.getTaskId(), node.id);

      const branchLines = conditionalBranches.map((b) => {
        const targetNode = this.nodeIndex.get(b.next);
        const targetName = targetNode?.name ?? b.next;
        return `- ${targetName}的期望：${b.expectation}`;
      }).join('\n');

      const currentStepDef = this.nodeIndex.get(node.id);
      const stepInput = currentStepDef ? this.engine.readStepInputForFinalize(currentStepDef) : this.getRecentStepInput();
      const recentOutput = this.engine.readStepOutputText(node.id);
      const condition = node.condition;
      const conditionPrompt = condition.type === 'agent'
        ? condition.value.agentTemplate ?? ''
        : condition.type === 'prompt'
          ? condition.value.promptText ?? ''
          : condition.value.command ?? '';

      const indentedInput = stepInput.split('\n').map((l) => `    ${l}`).join('\n');
      const indentedOutput = (recentOutput || '').slice(0, 4000).split('\n').map((l) => `    ${l}`).join('\n');

      const currentArtifacts = currentStepDef ? this.engine.collectStepArtifacts(currentStepDef) : [];
      const currentArtifactFiles = currentArtifacts.flatMap((a) => a.value);
      const artifactsXml = currentArtifactFiles.length > 0
        ? `\n  <artifacts>\n${currentArtifactFiles.map((f) => `    - ${f}`).join('\n')}\n  </artifacts>`
        : '';

      const contextMsg = `你是严谨准确的Step执行后分支判断Agent，你的任务是准确完成\`## 你的任务\`中的要求，完成当前Step的执行后验收。

## 你的任务
1. 遵守\`## 红线事项\`的原则，遵循\`## 用户配置的分支提示词\`的步骤和要求，参考 \`## 当前Step的输入输出\` 的内容，从\`## 当前Step的分支列表\`的内容，快速但准确地判断出接下来应该走的分支
2. 准确按照 \`## 返回JSON样式\` 的样式，填写你选择的分支的期望值，然后返回这个JSON结果（禁止把结果写入文件，直接返回结果即可）

## 用户配置的分支提示词
${conditionPrompt}
## 当前Step的输入输出
<${node.id}>
  <input>  // 当前Step的输入
${indentedInput}
  </input>
  <output>  // 当前Step的输出
${indentedOutput}
  </output>${artifactsXml.replace('<artifacts>\n', '<artifacts>  // 当前Step的产物\n')}
</${node.id}>

## 当前Step的分支列表
${branchLines}

## 返回JSON样式
\`\`\`json
{
  "branchExpectation": "你选择的分支的期望值"
}
\`\`\`

## 红线事项
1. 如果当前任务实际未完成，禁止擅自继续执行
2. 禁止除了读取操作之外的操作，比如git commit, edit, write, rm等等
3. 禁止太长思考，不要思考太多，从任务输入输出，和当前项目现状来考虑
4. 禁止把结果写入文件，直接返回结果即可
5. 禁止过度严格的验收标准，重要的是step按照要求输出或者生成相关内容，如果你怀疑其虚构内容，你可以自行查询验证`;
const partial = await evaluator.start(node.condition, contextMsg);
      const result = await evaluator.collect(partial);

      const matchedTargets: string[] = [];
      for (const branch of conditionalBranches) {
        if (matchesExpectation(result.output, branch.expectation)) {
          matchedTargets.push(branch.next);
        }
      }

      for (const branch of parallelBranches) {
        matchedTargets.push(branch.next);
      }
      return matchedTargets;
    }
    return branches.map(b => b.next);
  }
```

**sandore**（`workflow/src/dag-navigator.ts`）— 传空字符串给 BranchEvaluator：

```typescript
    // 条件分支：逐条布尔评估（AI true/false，shell 匹配 breakExpectation）。
    for (const branch of conditional) {
      const result = await this.evaluator.evaluate(branch.condition!, '', this.branchEvalOptions(node, context));
      branchMeta = {
        status: 'completed',
        result: result.output,
        ...(result.sessionHandle === null ? {} : { sessionId: result.sessionHandle }),
      };
      const passed = this.decideCondition(branch.condition!, result.output, branch.label);
      if (passed && this.sameStageStep(node, branch.next) !== undefined) {
        nextNodeIds.push(branch.next);
      }
    }
```

---

### 🔴 功能缺失 13：`tryAdvanceStage` 不检查失败步骤

**模块**：DAG 导航器

**影响**：Stage 内有 Step 失败但契约状态为 completed 时，可能错误推进到下一 Stage。基准明确阻止有失败步骤的 Stage 推进（`hasFailedSteps` 检查），sandore 无此检查。如果 Stage 中有 Step 失败但 StageContract 状态被标记为 completed（可能在 batch 执行的容错逻辑中发生），sandore 会直接推进到下一 Stage，跳过失败 Step 的处理。基准的 `isStageAllDone` 把 completed 和 failed 都算「done」，但 `tryAdvanceStage` 额外检查 failed 来阻止推进，确保失败 Step 被处理后才能推进。
**基准**（`internal/engine/workflow-dag-navigator.ts`）— `hasFailedSteps` 检查：

```typescript
  async tryAdvanceStage(): Promise<boolean> {
    if (!this.currentStageId) return false;

    if (!this.isStageAllDone(this.currentStageId)) return false;

    // Don't advance to next stage if current stage has failed steps
    const hasFailedSteps = this.engine.getExecutedSteps().some(
      (item) => item.stageId === this.currentStageId && item.status === 'failed'
    );
    if (hasFailedSteps) {
      logger.info(`[WorkflowEngineV2] Stage ${this.currentStageId} has failed steps, not advancing`);
      return false;
    }

    const stageNode = this.nodeIndex.get(this.currentStageId);

    if (stageNode?.condition && stageNode.branches && stageNode.branches.length > 0) {
      const branchTargets = await this.evaluateBranches(stageNode);
      if (branchTargets.length > 0) {
        for (const t of branchTargets) {
          await this.enqueueTargetNode(t);
        }
        return true;
      }
    }

    if (stageNode?.next) {
      await this.enqueueTargetNode(stageNode.next);
      return true;
    }

    return false;
  }
```
基准的 `isStageAllDone` 也考虑了 failed 状态（completed 和 failed 都算 "done"），但 `tryAdvanceStage` 额外检查 failed 来阻止推进：

```typescript
  isStageAllDone(stageId: string): boolean {
    const stage = this.engine.getDefinition().stages.find((s) => s.id === stageId);
    if (!stage) return false;

    for (const stepDef of stage.steps) {
      if (this.pendingQueue.includes(stepDef.id)) return false;
    }

    // 'completed' and 'failed' are both considered "done" for stage completion check.
    // 'failed' steps block stage advancement (checked in tryAdvanceStage).
    for (const item of this.engine.getExecutedSteps()) {
      if (item.stageId === stageId) {
        if (item.status === 'completed' || item.status === 'failed') continue;
        return false;
      }
    }
    return true;
  }
```

**sandore**（`workflow/src/dag-navigator.ts`）— 无失败检查，仅检查 `isStageAllDone`：

```typescript
  tryAdvanceStage(): boolean {
    if (!this.isStageAllDone(this.currentStageId)) {
      return false;
    }
    const current = this.nodeIndex.get(this.currentStageId);
    if (current === undefined || current.kind !== 'stage') {
      return false;
    }
    let nextId: string | undefined;
    for (const branch of current.branches ?? []) {
      if (this.nodeIndex.get(branch.next)?.kind === 'stage') {
        nextId = branch.next;
        break;
      }
    }
    if (nextId === undefined) {
      const index = this.stageOrder.indexOf(current.id);
      nextId = index >= 0 ? this.stageOrder[index + 1] : undefined;
    }
    const next = nextId === undefined ? undefined : this.nodeIndex.get(nextId);
    if (next === undefined || next.kind !== 'stage') {
      return false;
    }
    this.currentStageId = next.id;
    return true;
  }

  /** 当前 Stage 是否已全部完成（以已存契约的 completed 状态判定）。 */
  isStageAllDone(stageId: string): boolean {
    return this.stageContracts.get(stageId)?.status === 'completed';
  }
```

---
### 🔴 功能缺失 14：`recoverInstance()` 未通过 RPC 暴露

**模块**：SDK/API 层

**影响**：前端无法通过 RPC 触发实例恢复。虽然 `seam.ts` 声明了 `recoverInstance` 抽象方法（引擎已实现），但 `remote.ts` 没有对应的 `@Remote` 端点，客户端无法调用。用户在 UI 上看到崩溃的实例无法手动触发恢复，只能通过重启进程或等待启动扫描（`recoverOrphanedInstances`）来恢复。

**基准**：`recoverOrphanedInstances()` 在 API 层暴露，前端可调用。

**sandore `seam.ts`** — 声明了 `recoverInstance` 抽象方法：

```typescript
export abstract class SandoreEngine extends Service implements SandoreEngineSurface {
  constructor(ctx: Context) {
    super(ctx, 'sandoreEngine');
  }

  /** 启动一个新的工作流实例。 */
  abstract startInstance(request: DagStartRequest): Promise<DagRun>;
  /** 恢复一个已存在的工作流实例。 */
  abstract recoverInstance(instanceId: string): Promise<DagRun>;
  /** 中止一个运行中的工作流实例。 */
  abstract abortInstance(instanceId: string): Promise<void>;
}
```
**sandore `remote.ts`** — RPC 端点列表（无 `recoverInstance`）：

```typescript
export class SandoreRemote extends TypertRemoteService {
  static inject = ['sandorePersistence', 'sandoreEngine', 'llm']

  constructor(ctx: Context) {
    super(ctx, 'sandore')
  }

  @Remote('ping')
  ping(): PingResponse { }

  @Remote('listDefinitions')
  listDefinitions(): WorkflowDefinitionEntry[] { }

  @Remote('createDefinition')
  async createDefinition(input: CreateDefinitionInput): Promise<WorkflowDefinitionEntry> { }

  @Remote('updateDefinition')
  async updateDefinition(id: string, input: UpdateDefinitionInput): Promise<WorkflowDefinitionEntry> { }

  @Remote('deleteDefinition')
  async deleteDefinition(id: string): Promise<boolean> { }

  @Remote('getYaml')
  getYaml(id: string): string { }
  @Remote('updateYaml')
  async updateYaml(id: string, yaml: string): Promise<WorkflowDefinitionEntry> { }

  @Remote('listInstances')
  listInstances(): InstanceSummary[] { }

  @Remote('startInstance')
  async startInstance(input: StartInstanceInput): Promise<DagRun> { }

  @Remote('deleteInstance')
  async deleteInstance(instanceId: string): Promise<boolean> { }

  @Remote('getInstanceState')
  getInstanceState(instanceId: string): DagInstanceState { }

  @Remote('abortInstance')
  async abortInstance(instanceId: string): Promise<void> { }

  @Remote('replyQuestion')
  async replyQuestion(input: ReplyQuestionInput): Promise<void> { }

  @Remote('replyPermission')
  async replyPermission(input: ReplyPermissionInput): Promise<void> { }

  @Remote('pauseStep')
  async pauseStep(input: PauseStepInput): Promise<void> { }
  @Remote('resumeStep')
  async resumeStep(input: ResumeStepInput): Promise<void> { }

  @Remote('pauseAll')
  async pauseAll(input: PauseAllInput): Promise<void> { }

  @Remote('resumeAll')
  async resumeAll(input: ResumeAllInput): Promise<void> { }

  @Remote('retryStep')
  async retryStep(input: RetryStepInput): Promise<void> { }

  @Remote('getArtifacts')
  getArtifacts(instanceId: string): ArtifactEntry[] { }

  @Remote('listProviders')
  listProviders(): LlmProviderInfo[] { }

  @Remote('listModels')
  async listModels(provider: string): Promise<LlmModelInfo[]> { }

  // ← 缺少 @Remote('recoverInstance')
}
```
---

### 🔴 功能缺失 15：`initPassThroughVars` 缺失

**模块**：收尾管理器

**影响**：重启后可能丢失已提取的透传变量值。基准在引擎初始化时从工作流定义收集所有 `passThroughVars` 默认值，并从持久化状态恢复已解析的值（用持久化的已提取值覆盖默认空值）。sandore 无此初始化逻辑，如果引擎重启（进程崩溃恢复），passThroughVars 可能只有默认空值而无之前已提取的值。这会导致后续 Step 引用这些变量时拿到空字符串，而非崩溃前已提取的正确值，破坏变量在 Step 间的传递链。

**基准**（`internal/engine/workflow-finalize-manager.ts`）：

```typescript
  initPassThroughVars(definition: WorkflowDefinition, jobId: string, taskId: string): void {
    // 1. 从工作流定义收集所有 passThroughVars 默认值
    for (const stage of definition.stages) {
      for (const step of stage.steps) {
        if (step.passThroughVars) {
          for (const v of step.passThroughVars) {
            if (!this.passThroughVars.has(v.name)) {
              this.passThroughVars.set(v.name, { value: v.value ?? '', description: v.description ?? '', refresh: v.refresh ?? false });
            }
          }
        }
      }
    }
    // 2. 从持久化状态恢复已解析的值（覆盖默认空值）
    const persisted = loadWorkflowState(jobId, taskId);
    if (persisted?.passThroughVars) {
      for (const [name, entry] of Object.entries(persisted.passThroughVars)) {
        if (entry.value) {
          const existing = this.passThroughVars.get(name);
          this.passThroughVars.set(name, { value: entry.value, description: entry.description, refresh: existing?.refresh ?? false });
        }
      }
    }
  }
```

**sandore**：无等价初始化逻辑。passThroughVars 由 stage-executor 的 `state.passThroughVars` 管理，但缺少从定义初始化默认值 + 从持久化状态恢复已提取值的能力。

---
### 🔴 功能缺失 16：`collectStepArtifacts` 缺失

**模块**：收尾管理器 / 引擎

**影响**：收尾评估 AI 缺少产物文件列表。基准的 `collectStepArtifacts` 基于 outputTo 定义收集实际产物文件路径，供收尾评估 AI 参考（写入 `<artifacts>` XML 块）。sandore 无此方法，`finalizeStageContract` 中 `files` 始终为空 `[]`，Stage 契约中产物文件列表为空，收尾评估 AI 也看不到 Step 实际生成了哪些文件，无法判断 Step 是否按要求产出了文件。

**基准**（`internal/engine/workflow-finalize-manager.ts`）：

```typescript
  collectStepArtifacts(stepDef: WorkflowStepDef): Array<{ id: string; value: string[] }> {
    const artifacts: Array<{ id: string; value: string[] }> = [];
    if (!stepDef.outputTo || stepDef.outputTo.length === 0) return artifacts;
    const cwd = this.engine.getCwd();
    for (const item of stepDef.outputTo) {
      const matched: string[] = [];
      if (item.path) {
        const isGlob = looksLikeGlob(item.path);
        if (isGlob) {
          try { matched.push(...this.findFilesByGlob(cwd, item.path)); } catch { /* ignore bad glob */ }
        } else {
          const absPath = path.resolve(cwd, item.path);
          if (fs.existsSync(absPath)) matched.push(absPath);
        }
      }
      if (item.regex) {
        const isGlob = looksLikeGlob(item.regex);
        try {
          if (isGlob) { matched.push(...this.findFilesByGlob(cwd, item.regex)); }
          else { matched.push(...this.findFilesByRegex(cwd, new RegExp(item.regex))); }
        } catch {
          if (isGlob) { try { matched.push(...this.findFilesByRegex(cwd, new RegExp(item.regex))); } catch { /* ignore */ } }
        }
      }
      artifacts.push({ id: item.id, value: matched });
    }
    return artifacts;
  }
```

基准在 `finalizeStepVars` 中调用并注入到收尾提示词的 `<artifacts>` 块：
```typescript
  async finalizeStepVars(stepDef: WorkflowStepDef, stageId: string, stepId: string, resolvedGates?: ...): Promise<'done' | 'error'> {
    const stepOutput = this.engine.getMessages().getStepOutput(stageId, stepId);
    const outputStr = typeof stepOutput === 'string' ? stepOutput : JSON.stringify(stepOutput, null, 2);
    const stepInput = this.readStepInputForFinalize(stepDef);

    const indentedInput = stepInput.split('\n').map((l) => `    ${l}`).join('\n');
    const indentedOutput = (outputStr || '').slice(0, 4000).split('\n').map((l) => `    ${l}`).join('\n');

    const stepArtifactEntries = this.collectStepArtifacts(stepDef);
    const stepArtifactFiles = stepArtifactEntries.flatMap((a) => a.value);
    const artifactsSection = stepArtifactFiles.length > 0
      ? stepArtifactFiles.map((f) => `    - ${f}`).join('\n')
      : '';

    // 构建提示词，含 <artifacts> 块（见上文 finalizeStepVars 完整实现）
    promptText = `你是严谨准确的Step执行后处理Agent...

## 当前Step的输入输出
<${stepDef.id}>
  <input>  // 当前Step的输入
${indentedInput}
</input>
  <output>  // 当前Step的输出
${indentedOutput}
  </output>${artifactsSection ? `\n  <artifacts>  // 当前Step的产物\n${artifactsSection}\n  </artifacts>` : ''}
</${stepDef.id}>
...`;
  }
```

**sandore**：无独立产物收集 API。`FinalizeStepContext.artifacts` 字段存在但 stage-executor 传入的是 `textSummary(executed.output)`（输出文本），不是产物文件列表。

---
## 三、中严重度问题

### 🟡 逻辑差异 17：`stripIdSuffix` 实现差异

**模块**：辅助函数

**影响**：sandore 的 `stripIdSuffix` 遍历 `stepIdSuffixMap` 查找匹配，如果 `stepIdSuffixMap` 被 `incrementLoopIteration` 清除（sandore 在递增迭代时清除了映射），之前的后缀无法剥离，恢复时找不到对应的原始 Step ID。基准用通用正则 `^(.+)-([0-9a-f]{4})$` 可以剥离任意 4 位 hex 后缀，不依赖映射表，即使映射表被清除也能正确剥离。

**基准**（`internal/engine/workflow-engine-helpers.ts`）— 通用正则，不依赖映射表：

```typescript
/** Generate a 4-char hex suffix for deduplicating step IDs inside loops */
export function loopIdSuffix(): string {
  return Math.random().toString(16).slice(2, 6);
}

/** Strip the 4-char UUID suffix from an executed ID to get the base definition ID.
 *  E.g. "step-af4c70df-66b7-4f5e-a4ac-c3ca2a245062-49aa" → "step-af4c70df-66b7-4f5e-a4ac-c3ca2a245062" */
export function stripIdSuffix(id: string): string {
  const match = id.match(/^(.+)-([0-9a-f]{4})$/);
  return match ? match[1] : id;
}
```
**sandore**（`microflow/src/loop-manager.ts`）— 遍历映射表，依赖映射表存在：

```typescript
  /** 生成 4 位 hex 后缀（小写 0-9a-f）。 */
  static loopIdSuffix(): string {
    return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 4);
  }

  /** 去除循环后缀还原原始 id（非本迭代生成的后缀原样返回）。 */
  stripIdSuffix(id: string): string {
    for (const [original, suffix] of this.stepIdSuffixMap) {
      if (id === `${original}-${suffix}`) {
        return original;
      }
    }
    return id;
  }
```

---

### 🟡 逻辑差异 18：`walkDir` 隐藏文件过滤差异

**模块**：文件工具
**影响**：sandore 会遍历 `.git`、`.vscode` 等隐藏目录，导致性能问题（`.git` 目录可能包含大量文件）和意外文件匹配（如 `.git/config` 可能被 glob 模式匹配到）。基准跳过所有 `.` 开头的条目，避免遍历版本控制目录。

**基准**（`internal/common/file-utils.ts`）— 跳过所有 `.` 开头的条目：

```typescript
/** Walk directory tree and collect files matching regex against relative paths */
export function walkDir(dir: string, regex: RegExp, results: string[], cwd: string): void {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath, regex, results, cwd);
      } else if (entry.isFile()) {
        const relPath = path.relative(cwd, fullPath).replace(/\\/g, '/');
        if (regex.test(relPath)) {
          results.push(fullPath);
        }
      }
    }
  } catch { /* ignore permission errors */ }
}
```
**sandore**（`microflow/src/file-utils.ts`）— 只跳过 `.` 和 `node_modules`：

```typescript
/** 递归收集目录下全部文件（跳过 `.` 与 `node_modules`）。 */
async function collectFiles(fs: FileSystem, dir: FsTarget, prefix: string, out: WalkedFile[]): Promise<void> {
  const entries = await fs.listDir(dir);
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === 'node_modules') continue;
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.type === 'directory') {
      await collectFiles(fs, entry.target, relativePath, out);
    } else if (entry.type === 'file') {
      out.push({ target: entry.target, relativePath });
    }
  }
}
```

---

### 🟡 逻辑差异 19：glob 检测逻辑差异
**模块**：文件工具

**影响**：`.*`、`.+`、`\d*`、`[^a]*` 等 regex 模式被 sandore 误判为 glob，导致这些 regex 被当作 glob 模式处理（`globToRegex` 转换），匹配结果错误。基准检测多种 regex 特征（`\d`/`\w`/`\s`/`\b`/`(?`/`.*`/`.+`/`[^`/`{数字`/`^.*$`），有特征则视为 regex；sandore 只检查 `\.` 和 `(?` 两种，漏判其余 regex 特征。

**基准**（`internal/common/file-utils.ts`）— 检测多种 regex 特征，有特征则视为 regex：

```typescript
/** Check if a pattern looks like a glob (contains unescaped * or ?) rather than a regex */
export function looksLikeGlob(pattern: string): boolean {
  if (/\\[dDwWsSb]|\(\?|\.\*|\.\+|\[\^|\{\d|\^.*\$/.test(pattern)) return false;
  return /(?<!\\)[*?]/.test(pattern);
}
```

**sandore**（`microflow/src/file-utils.ts`）— 只检查 `\.` 和 `(?` 两种：

```typescript
/** 含 `*`/`?` 且无 regex 特征（反斜杠转义或 `(?`）时判定为 glob，否则视为 regex/字面路径。 */
export function isGlobPattern(pattern: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) return false;
  return !/\\.|\(\?/.test(pattern);
}
```
**误判示例**：
- `.*` — sandore 判为 glob（应为 regex），基准判为 regex
- `.+` — sandore 判为 glob（应为 regex），基准判为 regex
- `\d*` — sandore 判为 glob（应为 regex），基准判为 regex
- `[^a]*` — sandore 判为 glob（应为 regex），基准判为 regex

---

### 🟡 逻辑差异 20：`globToRegex` 锚定差异

**模块**：文件工具

**影响**：`globToRegex('*.ts')` 在基准中匹配 `src/foo.ts`（部分匹配，无锚定），在 sandore 中不匹配（全路径匹配，需 `**/*.ts`）。这会导致相同的 glob 模式在两个引擎中匹配不同的文件集。基准的 `*.ts` 能匹配任意深度的 `.ts` 文件（因为 regex 无锚定，`[^/]*\.ts` 可以在路径任意位置匹配），sandore 的 `*.ts` 只匹配根目录下的 `.ts` 文件（因为 `^[^/]*\.ts$` 要求完整路径匹配）。

**基准**（`internal/common/file-utils.ts`）— 不锚定（无 `^`/`$`）：

```typescript
/** Escape a single character for use in a regex */
function escapeRegexChar(ch: string): string {
  if (/[.+^${}()|[\]\\]/.test(ch)) return '\\' + ch;
  return ch;
}
/** Convert a glob pattern to a RegExp */
function globToRegex(glob: string): RegExp {
  let regexStr = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '\\' && i + 1 < glob.length) { regexStr += escapeRegexChar(glob[++i]); }
    else if (ch === '*') {
      if (glob[i + 1] === '*') { regexStr += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else { regexStr += '[^/]*'; }
    } else if (ch === '?') { regexStr += '[^/]'; }
    else { regexStr += escapeRegexChar(ch); }
  }
  return new RegExp(regexStr);
}
```

**sandore**（`microflow/src/file-utils.ts`）— 锚定（`^`/`$`）：

```typescript
/** 转义单个正则元字符（非元字符原样返回）。 */
export function escapeRegexChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}
/** 将 glob 模式转换为锚定正则：`*`→`[^/]*`、`**`→`.*`（跳过后续 `/`）、`?`→`[^/]`。 */
export function globToRegex(glob: string): RegExp {
  let pattern = '^';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        pattern += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += escapeRegexChar(char);
    }
  }
  pattern += '$';
  return new RegExp(pattern);
}
```
---

### 🟡 逻辑差异 21：`incrementLoopIteration` 清除行为不同

**模块**：循环管理

**影响**：基准中后缀映射跨迭代保持（同一原始 step ID 在不同迭代复用同一后缀），sandore 中每次迭代清除映射（新迭代生成新后缀）。如果代码依赖「同一 step 在循环内始终用同一后缀」的假设，sandore 的清除会破坏这一假设。但 sandore 的清除行为实际上更正确（不同迭代的同一 step 应有不同后缀以区分），这是合理的设计差异。

**基准**（`internal/engine/workflow-loop-manager.ts`）— 不清除：

```typescript
  /** Increment the iteration number of the innermost active loop (loop continues). */
  incrementLoopIteration(): void {
    if (this.activeLoopIterationStack.length > 0) {
      const top = this.activeLoopIterationStack.length - 1;
      this.activeLoopIterationStack[top]++;
    }
    // ← 不清除 stepIdSuffixMap
  }
```
**sandore**（`microflow/src/loop-manager.ts`）— 清除：

```typescript
  /** 递增最内层迭代计数，并清除本迭代的后缀映射（新迭代生成新后缀）。 */
  incrementLoopIteration(): void {
    const last = this.state.activeLoopIterationStack.length - 1;
    if (last >= 0) {
      this.state.activeLoopIterationStack[last] = (this.state.activeLoopIterationStack[last] ?? 0) + 1;
    }
    this.stepIdSuffixMap.clear();
  }
```

---

### 🟡 功能缺失 22：`resetLoopVisitCounts` 缺失

**模块**：循环管理

**影响**：循环跳出后 visitCounts 不重置。如果循环跳出后再次进入同一循环（或嵌套循环外层循环），visitCounts 会从上次的值继续累加，导致 `maxIterations` 判定基于历史累计值而非当前循环的迭代次数，可能立即触发 maxIterations 跳出。基准在循环跳出时调用 `resetLoopVisitCounts` 重置当前循环作用域内所有 Step 的 visitCounts，确保下次进入循环时从 0 开始计数。
**基准**（`internal/engine/workflow-loop-manager.ts`）：

```typescript
  /**
   * Reset visitCounts for all steps in the current loop scope.
   * Uses the loop source step's loopIteration to find the scope.
   */
  resetLoopVisitCounts(nodeId?: string): void {
    let currentPath: number[] | undefined;
    if (nodeId) {
      const actualNodeId = this.stepIdSuffixMap.get(nodeId) ?? nodeId;
      const steps = this.engine.getExecutedSteps();
      for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i].id === actualNodeId) {
          currentPath = steps[i].loopIteration;
          break;
        }
      }
    } else {
      currentPath = this.buildLoopIterationPath();
    }
    if (!currentPath) return;

    // 收集当前循环作用域内所有步骤的原始 ID
    const baseIds = new Set<string>();
    for (const step of this.engine.getExecutedSteps()) {
      if (step.loopIteration &&
          step.loopIteration.length >= currentPath.length &&
          step.loopIteration.slice(0, currentPath.length).every((v, i) => v === currentPath[i])) {
        baseIds.add(this.stripIdSuffix(step.id));
      }
    }

    // 重置这些 ID 的 visitCounts
    const visitCounts = this.engine.getVisitCounts();
    for (const id of baseIds) {
      if (visitCounts.has(id)) {
        visitCounts.set(id, 0);
      }
    }
    logger.info(`[WorkflowEngineV2] Reset visitCounts for ${baseIds.size} nodes in loop scope`);
  }
```

基准在 `resolveNextNodes` 循环跳出时调用：
```typescript
      if (shouldBreak) {
        if (wasInLoop && isCurrentLoopContinuation) {
          this.engine.getLoopManager().resetLoopVisitCounts(node.id);
          this.engine.getLoopManager().popActiveLoop();
        }
        if (node.loop.exitTo) {
          const exitToNode = this.nodeIndex.get(node.loop.exitTo);
          if (exitToNode && exitToNode.stage.id === node.stage.id) {
            await this.enqueueTargetNode(node.loop.exitTo);
          }
        }
        return;
      }
```

**sandore**：无此方法。dag-navigator 中循环跳出时仅 `popActiveLoop()`：

```typescript
        if (outcome.shouldBreak) {
          this.loopManager.popActiveLoop();
          const exitTo = loop.exitTo;
          loopResult = {
            nextNodeIds: exitTo !== undefined && this.sameStageStep(node, exitTo) !== undefined ? [exitTo] : [],
            ...(outcome.loopMeta === undefined ? {} : { loopMeta: outcome.loopMeta }),
          };
          break;
        }
```
---

### 🟡 功能缺失 23：`applyPendingLoopMeta` 缺失

**模块**：DAG 导航

**影响**：循环继续时待处理循环元数据未及时应用。在基准的架构中，`checkLoopBreak` 在 `processNode` 执行前调用（DAG 导航阶段），此时步骤可能尚未 push 到 executedSteps；如果 `setLoopIterationMeta` 失败（步骤尚未入列），meta 暂存为 pending，后续在步骤入列后再应用。sandore 无此兜底机制，如果 `checkLoopBreak` 产生的 loopMeta 无法立即写入，会丢失评估现场。

**基准**（`internal/engine/workflow-loop-manager.ts`）：

```typescript
  /** Apply pending loopMeta if one exists. */
  applyPendingLoopMeta(): void {
    if (!this.pendingLoopMeta) return;
    const nodeId = this.pendingLoopNodeId;
    if (nodeId && this.setLoopIterationMeta(this.pendingLoopMeta, nodeId)) {
      this.pendingLoopMeta = null;
      this.pendingLoopNodeId = null;
      this.engine.persistState();
    }
  }
```
基准在 `resolveNextNodes` 循环继续前调用：

```typescript
      // Loop continues — apply pending meta BEFORE increment/push (uses current path)
      this.engine.getLoopManager().applyPendingLoopMeta();

      // Now increment/push for the next iteration
```

**sandore**：无此机制。`checkLoopBreak` 直接返回 `loopMeta`，由调用方立即写入，无 pending 兜底。

---

### 🟡 功能缺失 24：`readStepInputForFinalize` 缺失

**模块**：引擎

**影响**：收尾评估 AI 缺少详细 Step 输入上下文。基准从 parts 文件读取多 Part 拼接的完整输入（含各 Part 的文本），回退到原始需求 + 命令文本（Agent调用/Prompt模板/Shell命令/Skill调用/MCP工具调用）。sandore 只传入 `originalInput`（原始需求），缺少命令文本等上下文，收尾评估 AI 无法看到 Step 实际执行了什么命令，无法准确判断 Step 是否按命令要求产出了正确内容。
**基准**（`internal/engine/workflow-finalize-manager.ts`）：

```typescript
  readStepInputForFinalize(stepDef: WorkflowStepDef): string {
    // 1. 从 parts 文件读取多 Part 拼接
    const partsFileName = this.engine.getStepPartsFileNames().get(stepDef.id);
    if (partsFileName) {
      try {
        const instanceDir = getInstanceDir(this.engine.getJobId(), this.engine.getTaskId());
        const partsPath = path.join(instanceDir, partsFileName);
        if (fs.existsSync(partsPath)) {
          const parts: Array<{ type: string; text: string }> = JSON.parse(fs.readFileSync(partsPath, 'utf-8'));
          if (Array.isArray(parts) && parts.length > 0) {
            return parts
              .filter((p) => p.type === 'text' && p.text)
              .map((p, i) => `### Part ${i + 1}\n${p.text}`)
              .join('\n\n');
          }
        }
      } catch {
        // fallback below
      }
    }
    // 2. 回退到原始需求 + 命令文本
    const sections: string[] = [];
    const originalInput = this.engine.getMessages().getOriginalInput();
    if (originalInput) {
      sections.push(`### 作业需求\n${originalInput}`);
    }
    if (stepDef.command) {
      const commandType = stepDef.command.type;
      if (commandType === 'agent' && stepDef.command.value?.promptText) {
        sections.push(`### Agent调用\n${stepDef.command.value.promptText}`);
      } else if (commandType === 'prompt' && stepDef.command.value?.promptText) {
        sections.push(`### Prompt模板\n${stepDef.command.value.promptText}`);
      } else if (commandType === 'shell' && stepDef.command.value?.command) {
        sections.push(`### Shell命令\n${stepDef.command.value.command}`);
      } else if (commandType === 'skill' && stepDef.command.value?.promptText) {
        sections.push(`### Skill调用\n${stepDef.command.value.promptText}`);
      } else if (commandType === 'mcp' && stepDef.command.value?.promptText) {
        sections.push(`### MCP工具调用\n${stepDef.command.value.promptText}`);
      }
    }
    return sections.length > 0 ? sections.join('\n\n') : stepDef.name ?? '';
  }
```

**sandore**：无此方法。Step 输入由 stage-executor 通过 `FinalizeStepContext.input` 传入（仅 `originalInput`，缺少命令文本等上下文）。
---

### 🟡 功能缺失 25：`getRecentStepInput` 缺失

**模块**：DAG 导航

**影响**：分支评估缺少 Step parts.json 聚合输入上下文。基准的 `getRecentStepInput` 读取所有已执行 Step 的 parts 文件，聚合文本作为分支评估的上下文。sandore 无此方法，进一步加剧了功能缺失 12（分支评估缺乏 Step I/O 上下文）的问题——不仅当前 Step 的 I/O 为空，历史 Step 的输入也完全不可见。

**基准**（`internal/engine/workflow-dag-navigator.ts`）：

```typescript
  getRecentStepInput(): string {
    const instanceDir = getInstanceDir(this.engine.getJobId(), this.engine.getTaskId());
    const sections: string[] = [];
    for (const [stepId, partsFileName] of this.engine.getStepPartsFileNames()) {
      if (!this.engine.getStepSessionIds().has(stepId)) continue;
      try {
        const partsPath = path.join(instanceDir, partsFileName);
        if (fs.existsSync(partsPath)) {
          const parts: Array<{ type: string; text: string }> = JSON.parse(fs.readFileSync(partsPath, 'utf-8'));
          if (Array.isArray(parts) && parts.length > 0) {
            const text = parts
              .filter((p) => p.type === 'text' && p.text)
              .map((p, i) => `### Part ${i + 1}\n${p.text}`)
              .join('\n\n');
            if (text) sections.push(text);
            }
        }
      } catch { /* skip unreadable parts */ }
    }
    return sections.join('\n\n');
  }
```

**sandore**：无等价物。

---

### 🟡 功能缺失 26：`rejectQuestion` 方法缺失

**模块**：交互管理

**影响**：缺少外部主动拒绝问答的 API 入口。当用户在 UI 上点"取消"而非回答时，基准可直接调 `rejectQuestion` 将 pending 问答标记为 rejected 并通知 StepRunner（SDK `client.question.reject`），StepRunner 收到 reject 后将 Step 标记为 failed。sandore 只能通过 AbortSignal 间接实现取消（`ask()` 内部的 `failQuestion` Promise reject），缺少显式的 reject 路径。这意味着前端无法精确地拒绝单个问答请求，只能整体 abort，影响范围更大。

**基准**（`internal/engine/workflow-interaction-manager.ts`）：
```typescript
  async rejectQuestion(requestId: string): Promise<void> {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) throw new Error(`Question not found: ${requestId}`);
    const runner = this.engine.findStepRunner(pending.stepId);
    if (!runner) throw new Error(`Step runner not found for step: ${pending.stepId}`);
    await runner.rejectQuestion(requestId);
    pending.status = 'rejected';
    this.pendingQuestions.delete(requestId);
    this.engine.emitInstanceEvent('workflow.question_rejected', pending);
    this.engine.persistState();
  }
```

**sandore**：无公开 reject 路径。拒绝仅通过 `ask()` 内部 Promise 的 reject 回调（`failQuestion`）处理：

```typescript
  /** 卡片 ask 失败（取消/拒绝）时清理 pending 条目并拒绝其等待 Promise。 */
  private failQuestion(entry: PendingQuestionEntry, error: unknown): void {
    if (this.pendingQuestions.get(entry.requestId) === undefined) {
      return;
    }
    this.pendingQuestions.delete(entry.requestId);
    this.resolvedEntries.push({ ...entry, status: 'rejected' });
    this.syncState();
    const waiter = this.questionWaiters.get(entry.requestId);
    this.questionWaiters.delete(entry.requestId);
    waiter?.reject(error);
  }
```
---

### 🟡 功能缺失 27：`clearPendingInteractions(stepId)` 缺失

**模块**：交互管理

**影响**：Step 重试或暂停时残留 pending 交互不会被清理，可能导致恢复后误处理过期的 ask/permission 请求。具体场景：当一个 Step 有 pending 问答/权限请求时，用户选择重试该 Step（continue/revert/fork）或暂停该 Step。此时该 Step 的 pending 交互条目（旧的 requestId 已失效，因为对应的 SDK 会话已被重试/暂停中断）需要被清理。基准的 `clearPendingInteractions(stepId)` 按步骤 ID 批量清理所有 pending 交互，支持原始 ID 和后缀 ID 匹配（循环内的 Step 有后缀 ID），清理后发射 `question_replied`/`permission_replied` 事件通知前端。sandore 无此方法，重试/暂停时残留的 pending 交互会在恢复后被误处理——引擎可能尝试用已失效的 requestId 回复一个已不存在的 SDK 会话，导致回复失败或 Step 卡在 interacting 状态。

**基准**（`internal/engine/workflow-interaction-manager.ts`）— 按步骤 ID 批量清理，支持原始 ID 和后缀 ID 匹配：

```typescript
  clearPendingInteractions(stepId: string): void {
    // Match by original or suffixed stepId
    const suffixedStepId = this.engine.getActualStepId(stepId);
    const matchesId = (id: string) => id === stepId || id === suffixedStepId;
    let changed = false;
    for (const [id, q] of this.pendingQuestions) {
      if (matchesId(q.stepId)) {
        q.status = 'replied';
        this.pendingQuestions.delete(id);
        this.engine.emitInstanceEvent('workflow.question_replied', q);
        changed = true;
      }
    }
    for (const [id, p] of this.pendingPermissions) {
      if (matchesId(p.stepId)) {
        p.status = 'replied';
        this.pendingPermissions.delete(id);
        this.engine.emitInstanceEvent('workflow.permission_replied', p);
        changed = true;
      }
    }
    if (changed) this.engine.persistState();
  }
```

基准在 `pauseStep` 中调用，确保暂停时清理该步骤的 pending 交互：

```typescript
  // 基准 workflow-lifecycle-manager.ts pauseStep()
  async pauseStep(stepId: string): Promise<void> {
    const stepRunners = this.engine.getStepRunners();
    const runner = stepRunners.get(stepId);
    if (!runner || (runner.getStatus() !== 'running' && runner.getStatus() !== 'interacting')) return;
    const sessionId = runner.getSessionId();
    runner.pause();
    const now = new Date().toISOString();
    const pauseSuffix = generatePauseSuffix();
    // 捕获会话消息快照（供恢复后展示暂停时的上下文，见下文完整实现）
    let sessionMessages: Array<{ type: 'text' | 'tool' | 'reasoning'; text?: string; tool?: string; args?: string; output?: string }> | undefined;
    if (sessionId) {
      try {
        const msgsResult = await getSessionMessages(sessionId, this.engine.getCwd(), 10);
        const msgs = (msgsResult as any)?.data?.messages || (Array.isArray(msgsResult) ? msgsResult : []);
        const nonSystem = msgs.filter((m: any) => {
          const role = m.info?.role || m.role;
          return role !== 'system' && role !== 'user';
        });
        const last5 = nonSystem.slice(-5);
        const snapshotItems = last5.map((m: any) => {
          const parts = m.parts || m.info?.parts || [];
          const items: Array<{ type: 'text' | 'tool' | 'reasoning'; text?: string; tool?: string; args?: string; output?: string }> = [];
          if (Array.isArray(parts)) {
            for (const p of parts) {
              if (p.type === 'text' && (p.text || '').trim()) {
                items.push({ type: 'text', text: String(p.text).slice(0, 300) });
                } else if (p.type === 'tool') {
                const input = p.state?.input || p.input || {};
                const toolName = p.tool || '';
                const output = p.state?.output || '';
                const argsStr = typeof input === 'object' ? JSON.stringify(input).slice(0, 200) : String(input).slice(0, 200);
                items.push({ type: 'tool', tool: toolName, args: argsStr, output: String(output).slice(0, 100) });
              } else if (p.type === 'reasoning' && (p.text || '').trim()) {
                items.push({ type: 'reasoning', text: String(p.text).slice(0, 150) });
              }
            }
          }
          return items;
        }).flat();
        sessionMessages = snapshotItems.length > 0 ? snapshotItems : undefined;
      } catch (e) {
        logger.warn(`[Engine] failed to fetch session messages for pause snapshot: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const pauseEntryId = `${stepId}-${pauseSuffix}`;
    this.engine.updateStepStatusInExecutedSteps(stepId, 'paused');
    this.engine.updateStepPauseMeta(stepId, { pausedAt: now, sessionMessages, pauseEntryId });
    this.engine.clearPendingInteractions(stepId);
    if (!this.pausedStepIds.includes(stepId)) {
      this.pausedStepIds.push(stepId);
    }
  }
```
**sandore**：无对应方法。`InteractionManager` 无 `clearPendingInteractions`，也无 `clearAll`。Step 重试/暂停时的 pending 交互清理由 `RecoveryManager` 和主循环的 ask Promise 机制间接处理，但缺少显式的按 stepId 批量清理：

```typescript
  // sandore interaction-manager.ts — 无 clearPendingInteractions，无 clearAll
  // 唯一的清理路径是 ask 内部的 finishQuestion/failQuestion（单个 requestId）
  private finishQuestion(entry: PendingQuestionEntry, answer: AskUserQuestionAnswer): void {
    if (this.pendingQuestions.get(entry.requestId) === undefined) {
      return;
    }
    this.pendingQuestions.delete(entry.requestId);
    this.resolvedEntries.push({ ...entry, status: 'replied', answer: toAnswerArray(answer) });
    this.syncState();
    const waiter = this.questionWaiters.get(entry.requestId);
    this.questionWaiters.delete(entry.requestId);
    waiter?.resolve(answer);
  }
```

---
### 🟡 功能缺失 28：`autoReplyPermission` 缺失

**模块**：步骤执行

**影响**：Step 执行时基于权限模式的自动批准缺失。基准在 Step 执行时根据 permissionMode 自动回复权限请求：`bypassPermissions` 模式自动批准所有权限（调用 SDK `client.permission.reply`），`acceptEdits` 模式自动批准编辑类权限（Edit/Write 等工具）。sandore 无 per-permission 自动审批，通过 `applyPermission` 在实例创建时设置 session 级 sandbox 模式 + 审批策略。区别在于：基准是细粒度的 per-tool 权限自动回复（每个权限请求单独判断），sandore 是粗粒度的 session 级 sandbox（整个会话一个模式）。基准的 `acceptEdits` 模式允许只自动批准编辑类、其他权限仍需确认；sandore 的 workspace-write 模式是整体放行，无法区分编辑类和其他类权限。

**基准**（`internal/sdk/session.ts`）：

```typescript
function autoReplyPermission(
  requestId: string,
  permission: string,
  permissionMode: PermissionMode,
  directory: string,
): boolean {
  if (permissionMode === 'bypassPermissions') {
    // 自动批准所有权限
    client.permission.reply({ requestID: requestId, reply: 'allow', directory });
    return true;
  }
  if (permissionMode === 'acceptEdits' && EDIT_TOOLS.has(permission)) {
    // 自动批准编辑类权限
    client.permission.reply({ requestID: requestId, reply: 'allow', directory });
    return true;
  }
  return false;  // 不自动批准，进入 interacting 状态
}
```
**sandore**：无 per-permission 自动审批。通过 `applyPermission` 在实例创建时设置 session 级 sandbox 模式 + 审批策略（`approval.setPolicy`）：read-only/workspace-write → approval='ask'，danger-full-access → approval='never'。

---

### 🟡 功能缺失 29：`updateInstancePermissionMode` 缺失

**模块**：API 层

**影响**：运行中实例无法动态切换权限模式。用户无法在运行中将实例从 read-only 切到 workspace-write，必须中止后重新创建。基准的 `updateInstancePermissionMode` 允许在运行中动态切换，StepRunner 通过 `() => this._permissionMode` 闭包读取最新值，下次权限请求自动使用新模式。sandore 的权限在实例创建时通过 `applyPermission` 设置，运行中无法切换。

**基准**（`api/instances.ts`）：

```typescript
function updateInstancePermissionMode(jobId: string, instanceId: string, mode: PermissionMode): void {
  const engine = workflowManager.get(jobId, instanceId);
  if (!engine) throw new Error('Instance not found');
  engine.setPermissionMode(mode);
}
```
**sandore**：`remote.ts` 无对应 RPC 端点。

---

### 🟡 功能缺失 30：`importWorkflowFromYaml` 缺失

**模块**：API 层

**影响**：无法从文件路径导入工作流定义。基准支持从文件路径导入，自动检测 V1 格式并转换，比对版本后决定 created/updated/skipped。sandore 没有文件导入能力，定义只能通过 RPC `createDefinition` 传入 YAML 文本，批量导入或从 CI/CD 管道导入工作流定义的场景无法支持。

**基准**（`api/workflow-definitions.ts`）：

```typescript
function importWorkflowFromYaml(yamlPath: string, options?: { harnessId?: string }): {
  created?: string;
  updated?: string;
  skipped?: string;
} {
  const yamlContent = fs.readFileSync(yamlPath, 'utf-8');
  // 1. 检测 V1 格式并转换
  if (needsConversion(yamlContent)) {
    convertedYaml = convertV1ToV2Yaml(yamlContent);
  }
  // 2. 解析为定义
  const def = parseWorkflowYaml(convertedYaml ?? yamlContent);
  // 3. 版本比对
  const existing = getWorkflowByHarnessId(options?.harnessId ?? def.id);
  if (existing && existing.version === def.version) {
    return { skipped: def.id };
  }
  // 4. 创建或更新
  if (existing) {
    updateWorkflow(def.id, { name: def.name, version: def.version, definition: def });
    return { updated: def.id };
  } else {
    createWorkflowDef({ id: def.id, name: def.name, version: def.version, definition: def });
    return { created: def.id };
  }
}
```
**sandore**：无文件导入能力。定义只能通过 RPC `createDefinition(input: CreateDefinitionInput)` 传入 YAML 文本。

---

### 🟡 功能缺失 31：实例讨论 API 缺失

**模块**：API 层

**影响**：无法查看实例聊天历史、无法向 Step 发送 @mention 消息。基准的实例讨论功能允许用户在工作流执行过程中向特定 Step 发送消息（`@mention` 路由到对应 stageId），并查看聊天历史。sandore 完全没有此 API，用户无法在执行过程中向 Step 补充信息或追问。

**基准**（`api/instance-discussion.ts`）：

```typescript
function getInstanceDiscussion(jobId: string, instanceId: string): DiscussionResponse {
  // 从 chat.json 加载讨论数据，含孤儿实例恢复
  const chatState = loadChatState(jobId, instanceId);
  return { chat: chatState, recovered: false };
}

function addInstanceChatMessage(jobId: string, instanceId: string, message: string): void {
  // 解析 @mention stageId 路由，同步到 work.json userChatMessages
  const chatState = loadChatState(jobId, instanceId);
  chatState.messages.push({ role: 'user', content: message, timestamp: new Date().toISOString() });
  saveChatState(jobId, instanceId, chatState);
  // 同步到引擎的 userChatMessages
  const engine = workflowManager.get(jobId, instanceId);
  if (engine) {
    engine.addUserChatMessage(message);
  }
}
```
**sandore**：完全无此 API。

---

### 🟡 功能缺失 32：`workflow:` 包装层解包缺失

**模块**：YAML 解析

**影响**：`{ workflow: {...} }` 格式的 YAML 文件无法解析。某些工具导出的 YAML 使用 `workflow:` 顶层包装，sandore 的 Zod 校验会直接失败（因为顶层多了 `workflow` 字段不在 schema 中）。基准在解析前检测并解包 `workflow:` 包装层，兼容这种格式。

**基准**（`internal/engine/yaml-parser.ts`）— 检测并解包 `workflow:` 顶层包装：

```typescript
export function parseWorkflowYaml(yamlStr: string): WorkflowDefinition {
  if (yamlStr == null || typeof yamlStr !== 'string' || yamlStr.trim() === '') {
    throw new ParseWorkflowYamlError('Invalid YAML input: input must be a non-empty string');
  }

  let raw: unknown;
  try {
    raw = YAML.parse(yamlStr);
  } catch (e) {
    throw new ParseWorkflowYamlError(
      `YAML syntax error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (raw == null || typeof raw !== 'object') {
    throw new ParseWorkflowYamlError('YAML content must be a mapping object');
  }
  // Unwrap workflow: wrapper if present (2.0 format)
  let source = raw as Record<string, unknown>;
  if (source.workflow && typeof source.workflow === 'object') {
    source = source.workflow as Record<string, unknown>;
  }

  const missingFields: string[] = [];
  if (!source.id) missingFields.push('id');
  if (!source.name) missingFields.push('name');
  if (!source.stages) missingFields.push('stages');

  if (missingFields.length > 0) {
    throw new ParseWorkflowYamlError(
      `Missing required fields: ${missingFields.join(', ')}`,
    );
  }

  // Check if this is 2.0 format (has top-level steps[] or stages[].steps[])
  const isV2 = Array.isArray(source.steps) ||
    (Array.isArray(source.stages) && source.stages.some((s: any) => Array.isArray(s.steps)));

  if (isV2) {
    const result = convertV2ToNested(source);
    return WorkflowDefinitionSchema.parse(result);
  }

  // 1.0 format — normalize legacy type names, convert to V2, and parse
  normalizeLegacyTypes(source);
  const result = convertLegacyToV2(source);
  applyLoopNextFallback(result);
  return WorkflowDefinitionSchema.parse(result);
}
```
**sandore**（`workflow/src/yaml-parser.ts`）— 无解包逻辑：

```typescript
export function parseWorkflowYaml(text: string): WorkflowDefinition {
  const document = parseDocument(text, { prettyErrors: true });
  if (document.errors.length > 0) {
    const detail = document.errors.map(describeYamlError).join('; ');
    throw new WorkflowYamlError(`invalid YAML: ${detail}`, 'YAML_PARSE');
  }

  const data = convertLegacyToV2(document.toJS());
  // ← 无 workflow: 包装层解包
  let definition: WorkflowDefinition;
  try {
    definition = WorkflowDefinitionSchema.parse(data);
  } catch (error) {
    throw new WorkflowYamlError(`invalid workflow definition: ${describeError(error)}`, 'DEFINITION_INVALID', { cause: error });
  }
  validateReferences(definition);
  return definition;
}
```
---

### 🟡 功能缺失 33：`hasUnresolvedVars` 缺失

**模块**：文件工具

**影响**：inputFrom path/regex 的未解析变量检查不完整。基准有通用的 `hasUnresolvedVars` 函数检查字符串中是否有未解析的 `${xxx}`，被 `resolveOutputToVars` 和 finalize manager 用于检查 outputTo 路径是否有未解析变量（有则延迟到 finalize 时再解析）。sandore 无此通用函数，finalize-manager 中有内联正则 `/\$\{[^}]+\}/.test(variable.value)` 检查 passThroughVars 值，但不是通用函数，无法被其他模块复用（如 outputTo 路径检查）。

**基准**（`internal/common/file-utils.ts`）：

```typescript
/** Check if a string contains unresolved ${xxx} patterns */
export function hasUnresolvedVars(str: string): boolean {
  return /\$\{[^}]+\}/.test(str);
}
```

**sandore**：无此通用函数。finalize-manager 中有内联正则检查 passThroughVars 值，但不是通用函数：

```typescript
// sandore microflow/src/finalize-manager.ts — 内联正则，非通用函数
function fillUnresolvedSingleVar(
  step: WorkflowStep,
  extracted: Record<string, string>,
  output: string | undefined,
): void {
  if (Object.keys(extracted).length > 0) return;
  const unresolved = (step.passThroughVars ?? []).filter(variable => /\$\{[^}]+\}/.test(variable.value));
  if (unresolved.length === 1 && output !== undefined && output.trim() !== '') {
    extracted[unresolved[0]!.name] = output;
  }
}
```
---

### 🟡 功能缺失 34：`resolveOutputToVars` 缺失

**模块**：收尾管理器

**影响**：outputTo 路径中 passThroughVars 占位符的解析与延迟机制缺失。基准的 `resolveOutputToVars` 解析 outputTo 中的 `${xxx}` 占位符：已解析的立即替换，未解析的延迟（返回含未解析变量的延迟项，供后续 finalize 时再解析）。这确保 outputTo 路径在 Step 执行前尽可能解析（用已知变量值替换占位符），未解析的延迟到 finalize 阶段（此时 passThroughVars 已被收尾评估填充）。sandore 无此方法，outputTo 路径中的占位符不会被解析，可能导致产物文件收集时路径仍含 `${xxx}` 字面量，无法匹配到实际文件。

**基准**（`internal/engine/workflow-finalize-manager.ts`）：

```typescript
  resolveOutputToVars(stepDef: WorkflowStepDef): OutputToItem[] {
    const deferred: OutputToItem[] = [];
    if (!stepDef.outputTo) return deferred;

    for (const item of stepDef.outputTo) {
      let hadUnresolved = false;
      if (item.path) {
        if (this.hasUnresolvedVars(item.path)) hadUnresolved = true;
        item.path = this.replaceVars(item.path);
      }
      if (item.regex) {
        if (this.hasUnresolvedVars(item.regex)) hadUnresolved = true;
        item.regex = this.replaceVars(item.regex);
      }
      if (hadUnresolved) {
        deferred.push(item);
      }
    }
    return deferred;
  }
```

**sandore**：无此方法。
---

### 🟡 功能缺失 35：`ConflictError` 缺失

**模块**：错误定义

**影响**：冲突场景无法精确表达。基准有 `ConflictError`（code: `CONFLICT`）用于资源冲突（如重复创建同名实例、版本冲突等）。sandore 的 `SandoreErrorCode` 中无 `CONFLICT` 码，最接近的是 `INVALID_OPERATION`，但语义不够精确——`INVALID_OPERATION` 表示「操作不合法」（如对已终态 Step 操作），而 `CONFLICT` 表示「资源冲突」（如实例名重复）。前端按 code 路由错误时，无法区分这两种不同的错误类型，可能展示不合适的错误提示或重试策略。

**基准**（`errors.ts`）：

```typescript
export class ConflictError extends WorkflowError {
  constructor(message: string) {
    super(message, 'CONFLICT');
  }
}
```

**sandore**（`microflow/src/errors.ts`）— `SandoreErrorCode` 中无 `CONFLICT` 码：

```typescript
export type SandoreErrorCode =
  // 定义/解析错误（fatal）
  | 'YAML_PARSE'
  | 'DEFINITION_INVALID'
  | 'NODE_NOT_FOUND'
  | 'CYCLE_DETECTED'
  // 运行时错误（fatal）
  | 'STEP_TIMEOUT'
  | 'STEP_EXECUTION'
  | 'INVALID_OPERATION'
  | 'CANCELLED'
  // 收尾/门禁/会话错误（fatal）
  | 'FINALIZE_FAILED'
  | 'GATE_FAILED'
  | 'SESSION_LOST'
  // 恢复性错误（non-fatal）
  | 'PERSISTENCE_FAILED';
```
---

## 四、低严重度问题（合理适配差异，约 40 项）

以下差异均为架构迁移的合理结果，不影响功能正确性：

- **类型系统**：CommandConfig 从统一 enum 改为 discriminatedUnion；DagBranch 从 expectation 改为 condition+loop；StepSessionMeta 从 SDK 文件模型改为子代理模型；ChatState/ChatMessage 类型移除（用 DSH Session 替代）；Legacy 别名全部移除
- **执行模型**：队列驱动 DAG（Promise.race 真并发）→ Stage 级线性循环 + batch；concurrencyQueue → maxConcurrentSteps 配置
- **事件系统**：EventEmitter + WorkflowEventBus → Cordis ctx.emit + Session.append；UnifiedEvent UUID/timestamp → 依赖 DSH 事件系统
- **持久化**：文件系统 work.json/chat.json → KvTable storageDomain；legacy migration → 无（全新实现）
- **权限模型**：PermissionMode (default/acceptEdits/bypassPermissions) → DSH sandbox/approval 双层
- **YAML 解析**：ParseWorkflowYamlError → WorkflowYamlError（带稳定错误码）；新增 V1→V2 自动转换 + DAG 引用完整性校验 + serializeWorkflowYaml
- **SDK 层**：自建 SDK client/session/sse-manager → DSH 原生 Services；纯函数 API → TypertRemoteService RPC

---

## 五、sandore 相对基准的增强

sandore 并非只有缺失，以下是其新增能力：

1. **`recoverOrphanedInstances()` 启动扫描** — Service.init 时自动扫描并恢复孤儿实例
2. **`waitForResume`/`notifyResume` 机制** — 显式处理 resume 先行/后行竞态
3. **`applyPermission` 权限预设应用** — sandbox + approval 双层权限
4. **StageContract 产物契约** — Stage 完成时对外暴露结构化产物契约
5. **`FinalizeOutcome` ask 交互** — 收尾支持 done/ask/error 三态
6. **两阶段 finalize** — FinalizeAssessor + GateEvaluator 独立会话
7. **子代理 ask 转接协议** — `[[SANDORE_ASK]]` 标记块 + onDelegatedAsk 回调
8. **provider/model 三层回退** — Step 定义 → 引擎 Config → ctx.llm 目录兜底
9. **循环上下文变量注入** — `in-loop-turn`/`all-loop-turn` 环境变量
10. **DAG 引用完整性校验** — `validateReferences` 校验 next 引用
11. **YAML 序列化** — `serializeWorkflowYaml` 可往返序列化
12. **更完整的错误码** — `SandoreErrorCode` + `fatal` 传播标志
---

## 六、修复优先级建议

### P0 — 立即修复（影响核心功能正确性）

1. **`decideCondition` 格式不匹配**（#2）— 条件分支完全失效
2. **`matchesExpectation` 逻辑差异**（#1）— 分支路由和循环跳出结果不同
3. **`checkLoopBreak` off-by-one**（#3）— 循环可能提前跳出
4. **`checkLoopBreak` 空 I/O 上下文**（#4）— AI 无法参考 Step I/O
5. **分支评估缺乏 Step I/O 上下文**（#12）— AI 评估分支无依据

### P1 — 尽快修复（影响关键功能完整性）

6. **`resolveStepRules` 缺失**（#7）— 工作流规则无效
7. **`resolveStepGates` 浅合并**（#5）— gates 配置可能丢失
8. **`tryAdvanceStage` 不检查失败步骤**（#13）— 可能错误推进 Stage
9. **`recover()` 恢复流程简化**（#9, #10, #11）— 崩溃恢复不完整
10. **`collectStepArtifacts` 缺失**（#16）— 产物文件列表为空
11. **产物校验 regex 误判**（#6）— 正常路径被误判为 regex

### P2 — 计划修复（影响功能完善性）

12. **`recoverInstance` RPC 暴露**（#14）
13. **`initPassThroughVars` 缺失**（#15）
14. **Step 级重试能力**（#8）
15. **其余中严重度问题**（#17-#35）