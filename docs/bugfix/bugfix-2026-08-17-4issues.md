# Sandore 收尾四阶段 Bug 修复计划

> 日期：2026-08-17 | 状态：计划中

---

## 问题 1：收尾阶段 badge 未显示

### 现象

点击创建实例后，Step 执行完成：
- 运行中右边**没有**显示「Phase B finalizing【收尾中】」
- Phase B 完成后，**没有**出现「Phase C gating」
- Phase C 完成后，**没有**出现「Phase D routing」

### 根因分析

**根因文件**：`packages/sandore/microflow/src/stage-executor.ts` L1107-1150（`completeAfterFinalize` 方法）

**机制**：

收尾四阶段的 `commitFinalize` 调用链如下：

```
commitFinalize('finalizing')  → L1055 (runPhaseB 末尾)
commitFinalize('gating')      → L1089 (runPhaseC 门禁失败)
commitFinalize('routing')     → L1123 (completeAfterFinalize)
commitFinalize('completed')   → L1139 (completeAfterFinalize)
```

关键时序：**`routing` 和 `completed` 是在同一个同步函数 `completeAfterFinalize` 中连续 `await` 调用的**：

```typescript
// L1122-1139
if (hasFinalize) {
  await this.options.finalizeManager.commitFinalize(buildRequest(), phaseBResult, gateResult, 'routing');
}
const routed = await this.options.stepNavigator.resolveNextNodes(nodeId, this.buildContext(state));
// ...
if (hasFinalize) {
  await this.options.finalizeManager.commitFinalize(buildRequest(), phaseBResult, gateResult, 'completed');
}
```

`commitFinalize` 内部（`finalize-manager.ts` L1092-1108）依次：
1. 写 `executedStep.finalizeMeta`（覆盖 `currentPhase`）
2. 调 `onPhaseChange`（引擎侧双发 `sandore/step-phase`）
3. 调 `onPersist`（持久化快照）

**问题在于**：`routing` → `resolveNextNodes` → `completed` 这三步是**几乎同步执行**的（`resolveNextNodes` 通常是纯代码、极快），UI 侧 `refreshAndSchedule` 响应 `sandore/step-phase` 事件后发起 RPC `getInstanceState`，**此时 `completed` 已经写入**——UI 拿到的是 `currentPhase='completed'` 的快照，`routing` 阶段 badge 根本来不及展示。

同理，`finalizing` → `gating` 之间间隔较短（只有 `evaluateGates` 的 primary 纯代码校验），badge 可能一闪而过或直接被覆盖。

**核心问题**：`commitFinalize` **覆盖式写入 `finalizeMeta.currentPhase`**，每次调用都把前一阶段覆盖掉。UI 只能看到最终写入的 `currentPhase`，无法看到中间阶段。

### 修复计划

**方案**：在 `finalizeMeta` 中增加 `phaseHistory` 数组，记录每个阶段的到达时间和 phase 值，使 UI 可以展示完整阶段历史。或者更简洁地——**不改变后端**，仅在 UI 侧利用 `step-phase` 事件流维护一个内存中的阶段历史：

**推荐方案（UI 侧维护阶段历史，侵入最小）**：

1. **`run-view-model.ts`**：`TimelineStepItem` 新增 `finalizePhaseHistory?: Array<{ phase: string; timestamp?: string }>` 字段。
2. **`RunView.tsx`**：用 `useRef` 维护 `Map<string, StepPhaseData[]>`（按 stepId 记录每次收到的 `sandore/step-phase` 事件）。`subscribeStepPhase` 回调中追加记录。
3. **`buildTimeline`**：从 `step.finalizeMeta` 读取当前 phase，结合 `phaseHistory` 渲染所有已到达的阶段 badge。
4. **`UnifiedTimeline.tsx`**：`PhaseBadge` 改为渲染多个阶段标签（如 `finalizing → gating → completed`），或只渲染**最后两个阶段**的 badge（当前阶段 + 前一阶段）。

**但更务实的方案**（考虑到阶段 badge 的目的是让用户「看到正在进行什么」而非历史回放）：

**只需让 `routing` 阶段 badge 真正可见即可**——`completed` 已经有「已收尾」终态显示，`gating` 和 `finalizing` 的中间态是否一闪而过不是核心问题。真正缺失的可能是：

**重新审视**：用户说「Phase B 完成后没有出现 Phase C」——如果实例**没有门禁配置**（`hasEnabledGates` 返回 false），Phase C 直接跳过（L1077-1078 返回 `{ kind: 'ok', gateResult: undefined }`），`completeAfterFinalize` 中 `hasFinalize` 取决于 `phaseBResult !== undefined || gateResult !== undefined`（L1119）。若无门禁但有透传变量，Phase B 会执行（`phaseBResult !== undefined`），`hasFinalize = true`，`routing` badge 会被发射。但用户说连 finalizing 都没看到——

**真正的根因**：查看 `buildAssessPrompt`（L356-380），Phase A 和 Phase B 使用**同一个** `buildAssessPrompt` 函数。Phase A 的 `assessOnly` 调用 `assess()`（临时会话），而 Phase B 的 `assessForked` 调用 `assessForked()`（真 fork 子代理）。**两者都使用 `buildAssessPrompt`**，返回相同的 JSON 结构 `{"hasAsk", "passThroughVars", "compressedOutput"}`。

回到 badge 不显示的问题——**如果实例没有未解析透传变量 AND 没有门禁**（`!needsAssess && !hasGates`），`runPhaseA` 直接跳过（L984），`runPhaseB` 也直接跳过（L1048），`runPhaseC` 也跳过——整个 finalize 流程被跳过（零 AI 路径），不写 `finalizeMeta`，badge 无数据可显示。这是**设计意图**（零 AI 跳过不写 finalizeMeta）。

**但用户说「我修改了工作流，下一次应该要有」**——暗示用户认为即使无门禁也应该有 badge。这是设计讨论，不是 bug。

**如果实例确实有透传变量或门禁但 badge 仍不显示**，则需检查：
- `subscribeStepPhase` 是否正确接收到 `sandore/step-phase` 事件
- `refreshAndSchedule` 是否在事件到达时触发了 RPC 刷新

**结论**：bug 1 的根因分两种情况：
1. **零 AI 跳过路径**：无透传变量 + 无门禁 → 无 finalizeMeta → 无 badge（设计意图，非 bug，但可考虑始终显示 finalizing badge）
2. **有收尾但 badge 一闪而过**：`completeAfterFinalize` 中 `routing → completed` 几乎同步执行，UI 刷新只看到 `completed`（**真正 bug**）

### 具体修复点

**文件 1**：`packages/sandore/microflow/src/stage-executor.ts`

- **L1107-1150** `completeAfterFinalize`：在 `routing` 和 `completed` 之间增加一个微小的异步让步（`await new Promise(r => setTimeout(r, 0))`），或更优雅地——把 `routing` 阶段的 badge 发射放在 `resolveNextNodes` **之前**，确保 UI 有机会在 `completed` 写入前刷新。
- 当前实现 L1122-1124 已经在 `resolveNextNodes` 之前调用了 `commitFinalize('routing')`，所以 `routing` badge 确实会发射。问题在于 `resolveNextNodes` 可能很快完成（纯代码），导致 `completed` 紧随其后。

**推荐修复**：不改后端时序，改 UI 侧——在 `step-phase.ts` 的 `notifyStepPhase` 中用 `setTimeout(0)` 延迟通知，给浏览器一帧时间渲染中间阶段 badge：

```typescript
// step-phase.ts notifyStepPhase
function notifyStepPhase(): void {
  // 给浏览器一帧时间渲染中间阶段 badge
  setTimeout(() => {
    for (const listener of listeners) {
      try { listener() } catch (error) { console.error(...) }
    }
  }, 0)
}
```

但这仍然不够——UI 刷新需要 RPC 往返。更可靠的方案是：

**最终推荐方案**：在 `finalizeMeta` schema 中增加 `previousPhase?: FinalizePhase` 字段，每次 `commitFinalize` 覆盖 `currentPhase` 前把旧值存入 `previousPhase`。UI 渲染 badge 时同时展示 `previousPhase` 和 `currentPhase`。

**文件 2**：`packages/sandore/workflow/src/schema.ts`（或 `types.ts`）
- `FinalizeMeta` 类型增加 `previousPhase?: FinalizePhase`

**文件 3**：`packages/sandore/microflow/src/finalize-manager.ts`
- `buildFinalizeMeta` L544-564：写入 `currentPhase` 前，把旧值存入 `previousPhase`

**文件 4**：`packages/sandore/ui/src/client/run-view-model.ts`
- `buildTimeline` L492：映射 `previousPhase` 到 `TimelineStepItem`

**文件 5**：`packages/sandore/ui/src/client/UnifiedTimeline.tsx`
- `PhaseBadge` L166-195：渲染 `previousPhase` badge（灰显/淡色）+ `currentPhase` badge

---

## 问题 2：Step 结果展示不符合要求 + compressedOutput 提示词模板

### 现象

用户要求：
- 运行中 → 运行时最新 10 条消息
- 暂停 → 最新 10 条消息
- 失败 → errorDetail + 最新 10 条消息
- 已完成 → compressedOutput 的内容

另外：compressedOutput 的提示词模板要求「要求干啥、干了啥、最后完整的总结」，不能比 step output 还简短。

### 根因分析

**根因文件 1**：`packages/sandore/ui/src/client/UnifiedTimeline.tsx` L249-306（`AgentMsg` 内容渲染）

**已完成态渲染**（L251-257）：
```tsx
{item.status === 'completed' && (
  item.finalizeAssessResult?.assessmentRaw !== undefined
    ? <div className={css.md}><MarkdownText text={item.finalizeAssessResult.assessmentRaw} /></div>
    : item.outputText !== undefined && <div className={css.md}><MarkdownText text={item.outputText} /></div>
)}
```

当前已完成态展示的是 `assessmentRaw`（Phase B 收尾评估的**原始输出文本**），而非 `compressedOutput`（JSON 中的压缩摘要字段）。用户要求展示 `compressedOutput`。

另外，`finalizeAssessResult` 在 `run-view-model.ts` L496-498 只取了 `assessmentRaw`，没有取 `compressedOutput`：
```typescript
finalizeAssessResult: step.finalizeMeta?.assessResult !== undefined
  ? { assessmentRaw: step.finalizeMeta.assessResult.assessmentRaw }
  : undefined,
```

**失败态渲染**（L284-295）：当前只展示 `errorDetail` + `outputText`，**没有展示最新 10 条消息**（`sessionMessages`）。用户要求失败态也要展示消息流。

**运行中态渲染**（L259-278）：当前运行中只展示 `StepChatPanel`（真实子代理会话的 DSH 对话流）或消息框/占位。这基本符合要求，但需要确认 `StepChatPanel` 是否限制为最新 10 条。

**根因文件 2**：`packages/sandore/microflow/src/finalize-manager.ts` L356-380（`buildAssessPrompt`）

当前 compressedOutput 的提示词要求（L362）：
```
3. 输出压缩：把 <output> 压缩为简洁摘要写入 compressedOutput（保留关键信息与产物引用，供下一步骤作为上下文）；保留关键信息，省略冗余细节，只返回摘要文本。
```

用户要求改为「要求干啥、干了啥、最后完整的总结」结构，且不能比 step output 还简短。

### 具体修复点

**文件 1**：`packages/sandore/ui/src/client/run-view-model.ts`

- **L496-498**：`finalizeAssessResult` 映射增加 `compressedOutput` 字段：
  ```typescript
  finalizeAssessResult: step.finalizeMeta?.assessResult !== undefined
    ? {
        assessmentRaw: step.finalizeMeta.assessResult.assessmentRaw,
        ...(step.finalizeMeta.assessResult.compressedOutput !== undefined
          ? { compressedOutput: step.finalizeMeta.assessResult.compressedOutput }
          : {}),
      }
    : undefined,
  ```

- **`TimelineStepItem` 接口 L232-233**：增加 `compressedOutput` 字段：
  ```typescript
  readonly finalizeAssessResult?: {
    readonly assessmentRaw: string
    readonly compressedOutput?: string
  } | undefined
  ```

**文件 2**：`packages/sandore/ui/src/client/UnifiedTimeline.tsx`

- **已完成态渲染 L251-257**：改为优先展示 `compressedOutput`，无则回退 `outputText`：
  ```tsx
  {item.status === 'completed' && (
    item.finalizeAssessResult?.compressedOutput !== undefined
      ? <div className={css.md}><MarkdownText text={item.finalizeAssessResult.compressedOutput} /></div>
      : item.outputText !== undefined && <div className={css.md}><MarkdownText text={item.outputText} /></div>
  )}
  ```

- **失败态渲染 L284-295**：增加最新 10 条消息展示：
  ```tsx
  {item.status === 'failed' && (
    <>
      {(item.finalizeErrorDetail ?? item.error) && (
        <div className={css.errorBlock}>
          <span className={css.errorText}>{item.finalizeErrorDetail ?? item.error}</span>
        </div>
      )}
      {/* 新增：失败态也展示最新 10 条消息 */}
      {item.messages !== undefined && item.messages.length > 0 && (
        <div className={css.agentLastList}>
          <div className={css.agentLastScroll}>
            {item.messages.slice(-10).map((line, index) => (
              <ChatLineRow key={index} line={line} />
            ))}
          </div>
        </div>
      )}
    </>
  )}
  ```

- **暂停态渲染 L297-303**：当前已展示消息流（`StepChatPanel` 或 `LastMessages`），符合要求。

**文件 3**：`packages/sandore/microflow/src/finalize-manager.ts`

- **L362**：修改 compressedOutput 的提示词模板：
  ```
  原：
  3. 输出压缩：把 <output> 压缩为简洁摘要写入 compressedOutput（保留关键信息与产物引用，供下一步骤作为上下文）；保留关键信息，省略冗余细节，只返回摘要文本。

  改：
  3. 输出压缩：把 <output> 完整总结写入 compressedOutput，按以下结构组织：
     - 【任务要求】：本次 step 要求完成什么
     - 【执行过程】：实际做了什么（关键步骤、调用的工具/文件、产生的中间结果）
     - 【最终成果】：完整的最终产出总结（包含所有关键信息，不得比原始 <output> 更简短）
     注意：compressedOutput 是后续 step 的唯一上下文来源，必须完整保留关键信息，禁止过度压缩。
  ```

**文件 4**：`packages/sandore/ui/src/client/run-view-model.ts`

- **`chatLinesOf` 函数 L319-339**：确认 `sessionMessages` 是否限制为最新 10 条。当前实现取全部消息——需要在 `buildTimeline` 映射时截取最新 10 条：
  ```typescript
  messages: chatLinesOf(step)?.slice(-10),
  ```

---

## 问题 3：Phase B/C/D badge 要图标+文字、可点击进入子代理

### 现象

- Phase B/C/D 要和「运行中」一样是「图标 + 文字」
- 可点击进入该阶段对应的子代理会话
- 当前 routing 纯文本不可点、可能 finalizing/gating 的点击也有问题

### 根因分析

**根因文件**：`packages/sandore/ui/src/client/UnifiedTimeline.tsx` L166-195（`PhaseBadge`）

当前 `PhaseBadge` 实现：
- Phase B（`finalizing`）：可点击按钮（`assessTarget` = `finalizeAssessSessionId`）
- Phase C（`gating`）：可点击按钮（`gateTarget` = `finalizeGateSessionId`）
- Phase A（`ask-detect`）、Phase D（`routing`）、终态（`completed`）：**纯文本** `<span className={css.phaseLabel}>`

问题 1：**Phase D（`routing`）没有对应的会话 id**（路由判断子代理评估完即删），所以渲染为纯文本。用户要求 routing 也可点击——但 routing 阶段确实没有持久化的会话 id。

问题 2：Phase B/C 的可点击按钮**没有图标**，只有文字。用户要求「图标 + 文字」。

问题 3：`PhaseBadge` 是嵌套在状态按钮 `<button className={css.stBtn}>` 内部的（L245），点击 PhaseBadge 的按钮会冒泡到外层状态按钮触发折叠/展开——**需要 `e.stopPropagation()`**。

### 具体修复点

**文件 1**：`packages/sandore/ui/src/client/UnifiedTimeline.tsx`

- **PhaseBadge 组件 L166-195**：

  1. 增加图标：为每个阶段配置图标（复用 `StatusIcon` 的风格或引入新图标）
     ```tsx
     function PhaseIcon({ phase }: { readonly phase: string }) {
       switch (phase) {
         case 'finalizing':
           return <svg ...>/* 收尾中图标（如旋转箭头） */</svg>
         case 'gating':
           return <svg ...>/* 门禁中图标（如盾牌） */</svg>
         case 'routing':
           return <svg ...>/* 路由中图标（如分支箭头） */</svg>
         default:
           return null
       }
     }
     ```

  2. Phase D（`routing`）改为可点击：增加 `finalizeRoutingSessionId` 或复用 `childId`（Step 本身的子代理会话 id）作为点击目标。或者——如果 routing 阶段没有专用会话，可以让 routing badge 点击后打开 Step 本身的子代理会话（`item.childId`）。

  3. 点击事件阻止冒泡：
     ```tsx
     onClick={(e) => { e.stopPropagation(); openSession(target) }}
     ```

  4. 所有阶段 badge 统一为「图标 + 文字」样式：
     ```tsx
     <button type="button" className={css.phaseBtn} onClick={(e) => { e.stopPropagation(); openSession(target) }}>
       <PhaseIcon phase={item.finalizePhase} />
       <span>{t(phaseKey)}</span>
     </button>
     ```

- **样式文件 `timeline.module.css`** L170-190：`.phaseBtn` 增加图标样式：
  ```css
  .phaseBtn svg {
    width: 12px;
    height: 12px;
    flex: none;
  }
  ```

**文件 2**：`packages/sandore/microflow/src/finalize-manager.ts`

- **routing 阶段的会话 id**：`commitFinalize('routing')` 时，如果 Phase B 的 `assessSessionId` 存在，可以复用它作为 routing 的点击目标（因为 routing 阶段复用了 Phase B 的 fork 子代理上下文）。或者在 `FinalizeMeta` 增加 `routingSessionId` 字段。

  **更简单的方案**：routing badge 点击打开 Step 本身的子代理会话（`item.childId`），不需要额外的 session id。

**文件 3**：`packages/sandore/ui/src/client/run-view-model.ts`

- `TimelineStepItem` L224-231：增加 `finalizeRoutingSessionId` 映射（如果后端增加了该字段），或者直接用 `childId` 作为 routing 的点击目标。

---

## 问题 4：Phase B fork 子代理的提示词仍包含 hasAsk 判断

### 现象

用户点击进入 Phase B 子代理会话，看到收尾提示词包含任务 1「判断是否需要向用户提问确认后继续（hasAsk）」。用户认为 hasAsk 应该是 Phase A 的职责，Phase B 不应再判 hasAsk。

### 根因分析

**根因文件**：`packages/sandore/microflow/src/finalize-manager.ts` L356-380（`buildAssessPrompt`）

Phase A（临时会话，`assess()`）和 Phase B（真 fork 子代理，`assessForked()`）**使用同一个** `buildAssessPrompt` 函数构建提示词。该函数包含：

```typescript
// L360-362
sections.push('1. 判断是否需要向用户提问确认后继续（hasAsk: true = 需要提问；false = 不需要，直接进入后续收尾）');
sections.push('2. 提取透传变量值：...');
sections.push('3. 输出压缩：...');
```

返回格式（L373）也包含 `hasAsk`：
```
{"hasAsk": false, "passThroughVars": {}, "askQuestion": {"questions": []}, "compressedOutput": "..."}
```

**这是 bug**：Phase B 不应再判 hasAsk。Phase A 已经完成了 ask 判定（如果有 ask，Step 会进入 interacting 等待用户回复；回复后才进入 Phase B）。Phase B 的职责是：
1. 提取透传变量（`passThroughVars`）
2. 压缩输出（`compressedOutput`）

Phase B 的 `assessForked` L710-716 返回时硬编码 `hasAsk: false`：
```typescript
return {
  hasAsk: false,  // 硬编码 false，不消费 LLM 的 hasAsk 判断
  passThroughVars: parsed.passThroughVars,
  compressedOutput: parsed.compressedOutput,
  forkSessionId: handle.agent.id,
  assessmentRaw: raw,
};
```

所以虽然提示词让 LLM 判断 hasAsk，但代码直接忽略结果——**提示词浪费了 LLM 的注意力，且让用户进入子代理会话时看到不相关的任务描述**。

另外，`parseFinalizeResult`（L396-407）只解析 `passThroughVars` 和 `compressedOutput`，不解析 `hasAsk`——进一步确认 Phase B 不需要 hasAsk。

### 具体修复点

**文件**：`packages/sandore/microflow/src/finalize-manager.ts`

1. **新增 `buildPhaseBFinalizePrompt` 函数**（Phase B 专用提示词），不含 hasAsk 任务：

   ```typescript
   function buildPhaseBFinalizePrompt(context: FinalizeStepContext, passThroughVars: readonly PassThroughVar[]): string {
     const sections: string[] = [ASSESS_PROMPT_HEADER, '', buildStepContextBlock(context)];
     sections.push('');
     sections.push('## 你的任务');
     sections.push('1. 提取透传变量值：对每个列出的透传变量，从 <output> 中提取其值并写入 passThroughVars；若变量值就是 <output> 的完整文本，直接使用它。');
     sections.push('2. 输出压缩：把 <output> 完整总结写入 compressedOutput，按以下结构组织：');
     sections.push('   - 【任务要求】：本次 step 要求完成什么');
     sections.push('   - 【执行过程】：实际做了什么（关键步骤、调用的工具/文件、产生的中间结果）');
     sections.push('   - 【最终成果】：完整的最终产出总结（包含所有关键信息，不得比原始 <output> 更简短）');
     sections.push('   注意：compressedOutput 是后续 step 的唯一上下文来源，必须完整保留关键信息，禁止过度压缩。');
     sections.push('');
     sections.push('## 透传变量');
     if (passThroughVars.length === 0) {
       sections.push('（无透传变量，passThroughVars 返回空对象）');
     }
     for (const variable of passThroughVars) {
       sections.push(`- ${variable.name}: ${variable.description}`);
     }
     sections.push('');
     sections.push('## 返回格式（JSON）');
     sections.push('{"passThroughVars": {}, "compressedOutput": "..."}');
     sections.push('');
     sections.push('## 红线规则');
     for (const rule of ASSESS_RED_LINES) {
       sections.push(`- ${rule}`);
     }
     return sections.join('\n');
   }
   ```

2. **修改 `FinalizeAssessor.assessForked`**（L669）：使用 `buildPhaseBFinalizePrompt` 替代 `buildAssessPrompt`：
   ```typescript
   // L694
   const promptText = buildPhaseBFinalizePrompt(input.context, input.step.passThroughVars ?? []);
   ```

3. **修改 `degradeFinalize`**（L732）：同样使用 `buildPhaseBFinalizePrompt`：
   ```typescript
   // L736
   const promptText = buildPhaseBFinalizePrompt(input.context, input.step.passThroughVars ?? []);
   ```

4. **保留 `buildAssessPrompt`** 供 Phase A（`assess()`）使用，不修改。

5. **修改 `FINALIZE_JSON_RETRY_HINT`**（L383-384）：移除 hasAsk 字段：
   ```typescript
   const FINALIZE_JSON_RETRY_HINT =
     '未能从你的输出中解析出合法的收尾处理 JSON，请仅返回：{"passThroughVars": {...}, "compressedOutput": "..."}，不要包含其他内容。';
   ```
   当前已是如此，无需修改。

6. **修改 `parseFinalizeResult`**（L396-407）：当前已只解析 `passThroughVars` 和 `compressedOutput`，无需修改。

---

## 修复优先级

| 问题 | 严重度 | 影响范围 | 建议优先级 |
|------|--------|----------|------------|
| 问题 4（Phase B hasAsk） | 高 | 用户体验 + 提示词效率 | **P0** |
| 问题 2（结果展示 + 提示词模板） | 高 | 用户体验核心 | **P0** |
| 问题 3（badge 图标+可点击） | 中 | 用户体验 | **P1** |
| 问题 1（badge 不显示） | 中 | 取决于是否有收尾配置 | **P1** |

## 测试计划

### 问题 4 测试
1. 创建一个有透传变量的 Step，执行完成后进入 Phase B 子代理会话
2. 确认提示词**不包含** hasAsk 判断任务
3. 确认提示词只包含「提取透传变量」和「输出压缩」两个任务
4. 确认 `parseFinalizeResult` 正确解析返回的 JSON

### 问题 2 测试
1. 已完成态：确认展示 `compressedOutput` 内容（非 `assessmentRaw`）
2. 失败态：确认展示 errorDetail + 最新 10 条消息
3. 运行中：确认展示最新 10 条消息（StepChatPanel）
4. 暂停态：确认展示最新 10 条消息
5. compressedOutput 提示词：确认新模板包含「任务要求/执行过程/最终成果」结构

### 问题 3 测试
1. Phase B badge：确认有图标 + 文字 + 可点击
2. Phase C badge：确认有图标 + 文字 + 可点击
3. Phase D badge：确认有图标 + 文字 + 可点击（点击打开 Step 子代理会话）
4. 点击 badge 不触发外层状态按钮的折叠/展开

### 问题 1 测试
1. 有门禁配置的 Step：确认 finalizing → gating → routing → completed 各阶段 badge 可见
2. 无门禁但有透传变量的 Step：确认 finalizing → completed badge 可见
3. 零 AI 跳过路径：确认无 badge（设计意图）

---

## 涉及文件清单

| 文件 | 问题 | 改动类型 |
|------|------|----------|
| `packages/sandore/microflow/src/finalize-manager.ts` | 2, 4 | 新增 `buildPhaseBFinalizePrompt`；修改 `assessForked`/`degradeFinalize` 使用新 prompt；修改 compressedOutput 提示词模板 |
| `packages/sandore/ui/src/client/UnifiedTimeline.tsx` | 1, 2, 3 | 修改已完成/失败态渲染；PhaseBadge 增加图标+可点击+stopPropagation |
| `packages/sandore/ui/src/client/run-view-model.ts` | 1, 2 | `TimelineStepItem` 增加 `compressedOutput`/`previousPhase` 映射；`chatLinesOf` 截取最新 10 条 |
| `packages/sandore/ui/src/client/timeline.module.css` | 3 | `.phaseBtn` 增加图标样式 |
| `packages/sandore/ui/src/client/step-phase.ts` | 1 | 可选：`notifyStepPhase` 增加延迟通知 |
| `packages/sandore/workflow/src/schema.ts` | 1 | `FinalizeMeta` 增加 `previousPhase` 字段（可选） |
