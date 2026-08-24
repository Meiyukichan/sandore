# Sandore 收尾三阶段 Bug 修复计划（第二轮）

> 日期：2026-08-17 | 状态：计划中 | 上一轮：bugfix-2026-08-17-4issues.md

---

## 问题 A：Phase B 收尾 JSON 解析失败反复重试，即便模型返回了合法 JSON

### 用户报告

收尾时模型第一次返回了看似合法的 JSON：
```json
{"passThroughVars": {"change-name": "book-management"}, "compressedOutput": "【任务要求】：...\n\n【执行过程】：...\n\n【最终成果】：..."}
```
但引擎仍报「未能从你的输出中解析出合法的收尾处理 JSON」并反复重试 3 次后超限报错。

### 根因分析

**根因文件**：`packages/sandore/microflow/src/finalize-manager.ts`

**机制（L200-225 + L423-424 + L436-447）**：

#### 1. `stripJsonFence` 只认严格格式的围栏（L222-225）

```typescript
function stripJsonFence(raw: string): string {
  const match = raw.match(/[ \t]*```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?[ \t]*```/i);
  return match?.[1] ?? raw;
}
```

正则要求：
- 围栏必须以 ` ```json ` 开头（行首可有空格/tab，但 **` ``` ` 前不允许有任何非空白字符**）
- ` ```json ` 后必须有换行符 `\r?\n`
- 围栏内内容用 `([\s\S]*?)` 懒惰匹配
- 闭合 ` ``` ` 前也必须是换行 + 可选空白

**关键弱点**：如果模型输出在 ` ```json ` 之前有任何非空白文字（如 `好的，以下是收尾结果：\n\n```json\n{...}\n``` `），正则**不会匹配**——因为正则 `[ \t]*```  只允许围栏行首有空白，不允许围栏前有其他文字行。此时 `match?.[1]` 为 `undefined`，`stripJsonFence` 返回原始 `raw`。

#### 2. `parseJsonObject(raw)` 和 `parseJsonObject(stripJsonFence(raw))` 都失败（L437）

```typescript
function parseFinalizeResult(raw: string): FinalizeParsed | undefined {
  const parsed = parseJsonObject(raw) ?? parseJsonObject(stripJsonFence(raw));
```

- `parseJsonObject(raw)`：直接 `JSON.parse(raw)` —— 若 raw 包含 `好的，以下是...` 前缀文字 + 围栏 + JSON，`JSON.parse` 必然失败（不是合法 JSON 字符串）。
- `parseJsonObject(stripJsonFence(raw))`：围栏剥离失败（上述正则不匹配）时 `stripJsonFence` 返回原始 `raw`，再 `JSON.parse(raw)` 同样失败。

→ `parsed === undefined` → 重试。

#### 3. `FINALIZE_JSON_RETRY_HINT` 没有指导模型使用围栏（L423-424）

```typescript
const FINALIZE_JSON_RETRY_HINT =
  '未能从你的输出中解析出合法的收尾处理 JSON，请仅返回：{"passThroughVars": {...}, "compressedOutput": "..."}，不要包含其他内容。';
```

重试提示词只说"请仅返回 JSON"，**没有明确要求用 ` ```json ``` 包裹**。模型可能继续返回带前导说明文字的输出，围栏剥离又失败，循环 3 次后超限。

#### 4. `buildPhaseBFinalizePrompt` 的返回格式说明也没有要求围栏（L412-413）

```typescript
sections.push('## 返回格式（JSON）');
sections.push('{"passThroughVars": {}, "compressedOutput": "..."}');
```

只是展示了一个 JSON 示例，**没有明确指令"用 ```json 围栏包裹"**。

### 复现链路

1. `assessForked`（L713-773）调用 `driveAgentRound(handle, promptText)` 获取模型输出 `raw`
2. 模型返回 `好的，以下是结果：\n\n```json\n{"passThroughVars":...}\n``` `（带前导说明文字 + 围栏）
3. `parseFinalizeResult(raw)`（L436-447）：
   - `parseJsonObject(raw)` → `JSON.parse(raw)` 失败（前导文字非 JSON）
   - `parseJsonObject(stripJsonFence(raw))` → 围栏正则不匹配（前有文字）→ 返回 `raw` → `JSON.parse(raw)` 再次失败
   - 返回 `undefined`
4. 进入重试循环（L742-746）：`driveAgentRound(handle, FINALIZE_JSON_RETRY_HINT)` —— 重试提示词不要求围栏，模型可能继续带文字
5. 循环 3 次后 `parsed` 仍为 `undefined` → 抛 `FINALIZE_FAILED`（L749-752）

### 修复计划

#### 涉及文件

| 文件 | 改动类型 |
|------|---------|
| `packages/sandore/microflow/src/finalize-manager.ts` | 核心修复 |

#### 具体改动

**改动 1：增强 `stripJsonFence` —— 容忍围栏前任意文字，多围栏取第一个 `json` 块**（L222-225）

```typescript
// 改前
function stripJsonFence(raw: string): string {
  const match = raw.match(/[ \t]*```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?[ \t]*```/i);
  return match?.[1] ?? raw;
}

// 改后
function stripJsonFence(raw: string): string {
  // 容忍围栏前任意文字：优先匹配 ```json 围栏（多个取第一个），
  // 围栏内内容提取后 trim。无围栏时原样返回。
  const fenced = raw.match(/```[ \t]*json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/i);
  if (fenced?.[1] !== undefined) {
    return fenced[1].trim();
  }
  // 回退：语言标记可省略（``` 后直接换行）
  const generic = raw.match(/```\r?\n([\s\S]*?)\r?\n[ \t]*```/);
  if (generic?.[1] !== undefined) {
    return generic[1].trim();
  }
  return raw;
}
```

**关键改动**：
- 移除行首锚定 `[ \t]*```  → 改为 ` ```  `（不锚定行首），容忍围栏前任意文字
- 语言标记 `(?:json)?` 改为 `json`（优先匹配 json 围栏，避免 ` ```python ``` ` 被误提取）
- 添加无语言标记的 ` ``` `\n``` ` 回退
- 提取后 `.trim()` 去除首尾空白

**改动 2：提示词明确要求围栏包裹**（`buildPhaseBFinalizePrompt` L412-413 + `FINALIZE_JSON_RETRY_HINT` L423-424）

```typescript
// 改前（L412-413）
sections.push('## 返回格式（JSON）');
sections.push('{"passThroughVars": {}, "compressedOutput": "..."}');

// 改后
sections.push('## 返回格式（JSON）');
sections.push('你必须用 ```json ``` 代码围栏包裹完整的 JSON 输出，围栏内只放 JSON，不要包含任何说明文字。示例：');
sections.push('```json');
sections.push('{"passThroughVars": {}, "compressedOutput": "..."}');
sections.push('```');
```

```typescript
// 改前（L423-424）
const FINALIZE_JSON_RETRY_HINT =
  '未能从你的输出中解析出合法的收尾处理 JSON，请仅返回：{"passThroughVars": {...}, "compressedOutput": "..."}，不要包含其他内容。';

// 改后
const FINALIZE_JSON_RETRY_HINT =
  '未能从你的输出中解析出合法的收尾处理 JSON。请严格按以下格式返回（用 ```json ``` 代码围栏包裹，围栏内只放 JSON，不要包含任何其他文字）：\n```json\n{"passThroughVars": {}, "compressedOutput": "..."}\n```';
```

**改动 3（可选）：同步修改 `buildAssessPrompt` 的返回格式**（L376-377）

Phase A 的 `buildAssessPrompt` 也使用相同格式说明，虽然 Phase A 是临时会话（无重试），但保持一致性：

```typescript
// 改前（L376-377）
sections.push('## 返回格式（JSON）');
sections.push('{"hasAsk": false, "passThroughVars": {}, "askQuestion": {"questions": []}, "compressedOutput": "..."}');

// 改后
sections.push('## 返回格式（JSON）');
sections.push('你必须用 ```json ``` 代码围栏包裹完整的 JSON 输出，围栏内只放 JSON，不要包含任何说明文字。示例：');
sections.push('```json');
sections.push('{"hasAsk": false, "passThroughVars": {}, "askQuestion": {"questions": []}, "compressedOutput": "..."}');
sections.push('```');
```

#### 测试影响

- `finalize-manager.spec.ts`：需新增 `stripJsonFence` 对「围栏前有文字」场景的测试
- `finalize-manager.spec.ts`：需更新 `phaseBJson` mock 输出为带围栏的格式
- `finalize-manager.spec.ts`：需新增「模型返回带前导文字 + 围栏 JSON → 解析成功」的集成测试
- `stage-executor.spec.ts`：Phase B 真 fork 测试用例的 `createFollowupHandler` 返回值需适配

#### 风险

- **低风险**：`stripJsonFence` 增强只扩大了合法输入的识别范围，不影响已有合法输入的解析
- **中风险**：提示词增加围栏要求后，模型行为变化——大部分模型遵循指令能力强，但少数模型可能忽略。围栏增强兜底保证即使模型不遵循也能解析

---

## 问题 B：Phase D routing / Phase B finalizing 显示仍是「全部跑完后才出现」

### 用户报告

已收尾（completed）和路由中（routing）都是整个收尾全部跑完后才同时出现——中间阶段的即时显示仍然没有生效。

### 根因分析

**根因文件**：`packages/sandore/microflow/src/stage-executor.ts` L1107-1150 + `packages/sandore/ui/src/client/RunView.tsx` L121-130

**机制**：

#### 1. 事件发射链路完整——后端事件确实会发出

```
commitFinalize('routing')     → L1123 (completeAfterFinalize)
  → buildFinalizeMeta()        写 finalizeMeta.currentPhase = 'routing'
  → onPhaseChange()            → emitStepPhase() → 双发 sandore/step-phase
  → onPersist()                持久化快照

resolveNextNodes()             → L1125 路由判断（可能含 AI 调用，有秒级间隔）

commitFinalize('completed')   → L1139
  → buildFinalizeMeta()        写 finalizeMeta.currentPhase = 'completed'
  → onPhaseChange()            → emitStepPhase() → 双发 sandore/step-phase
  → onPersist()                持久化快照
```

`commitFinalize` 每次都触发 `onPhaseChange` → 引擎双发 `sandore/step-phase` 事件（L1975-1977）。事件链路完整。

#### 2. UI 刷新链路也完整——`subscribeStepPhase` 触发 `refreshAndSchedule`

```typescript
// RunView.tsx L149-154
useEffect(() => {
  return subscribeStepPhase(() => {
    if (disposedRef.current) return
    void refreshAndSchedule()  // → refresh() → RPC getInstanceState → 更新 UI
  })
}, [refreshAndSchedule])
```

#### 3. 核心问题：`refreshAndSchedule` 的 RPC 读取的是**最新持久化快照**

`refreshAndSchedule` → `refresh()` → `remote.getInstanceState(instanceId)` → RPC → 引擎 `getState` → 返回 `active.state`。

**`active.state` 是内存引用**——`onPersist` 把 `executedStep` 写入 `active.state.executedSteps`（L1247-1257），而 `finalizeMeta` 直接挂在 `executedStep.finalizeMeta` 上。

**关键时序问题**：

当 `resolveNextNodes` 极快完成（纯代码路由，无 AI 判断）时：
1. `commitFinalize('routing')` → `onPersist` → `active.state` 写入 `currentPhase='routing'`
2. 引擎 emit `sandore/step-phase(routing)` → UI 收到事件 → `refreshAndSchedule()` 排队
3. `resolveNextNodes()` **同步完成**（微任务内）
4. `commitFinalize('completed')` → `onPersist` → `active.state` 写入 `currentPhase='completed'`
5. 引擎 emit `sandore/step-phase(completed)` → UI 收到事件
6. UI 的 `refresh()` 终于执行 → 读到 `currentPhase='completed'`

**结果**：UI 两次 `refreshAndSchedule` 都读到 `currentPhase='completed'`（步骤 6 执行时步骤 4 已完成），中间 `routing` 阶段完全不可见。

#### 4. 上一轮修复已生效——`previousPhase` 灰显方案已到位

`buildFinalizeMeta`（L591-608）已实现 `previousPhase` 保存：
```typescript
const previousPhase = existing?.currentPhase;
return {
  currentPhase,
  ...(previousPhase !== undefined ? { previousPhase } : {}),
  ...
};
```

UI 侧 `PhaseBadge`（UnifiedTimeline.tsx L207-253）也已渲染 `previousPhase` 徽标（灰显）。

**但 `previousPhase` 只保存了上一阶段，不保存更早的阶段**。当 `routing → completed` 几乎同步完成时，`previousPhase` 会被覆盖为 `routing`（来自 `completed` 写入前的 `existing?.currentPhase`），UI 能看到 `previousPhase='routing' + currentPhase='completed'`。**但 `finalizing` 阶段已不可见**（被 `routing` 覆盖了 `previousPhase`）。

#### 5. 用户的真实痛点

用户说「全部跑完后才出现」——**意味着连 `previousPhase` 灰显也没有及时出现**。

检查 `RunView.tsx` 的 `refreshAndSchedule`（L121-130）：
```typescript
const refreshAndSchedule = useCallback(async (): Promise<void> => {
  const status = await refresh()
  if (disposedRef.current || status === undefined || !isRunningStatus(status)) return
  if (timerRef.current === undefined) {
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined
      void refreshAndSchedule()
    }, POLL_INTERVAL_MS)  // 5 秒轮询
  }
}, [refresh])
```

**`refreshAndSchedule` 有多层调用排队**：
- `subscribeStepPhase` 回调中调用 `refreshAndSchedule`
- `refreshAndSchedule` 内部 RPC 完成后如果状态仍 running，会安排 5 秒后再次调用
- **但 `refreshAndSchedule` 没有 debounce/防抖**——连续两次事件触发两次 `refreshAndSchedule`，但 `refresh()` 的 RPC 可能在同一微任务内被合并或排队

**真正的问题**：`refresh()` 是 async 函数，两次 `sandore/step-phase` 事件几乎同时到达（`routing` 和 `completed` 事件间隔极短），第一个 `refresh()` 的 RPC 请求**还在飞行中**时 `completed` 已经写入，第一个 RPC 返回时读到的就是 `completed`。第二个 `refresh()` 也读到 `completed`。

### 复现链路

1. Step 执行完成 → Phase B `assessForked`（有 AI 调用，耗时数秒）→ `commitFinalize('finalizing')` → UI 收到事件 → `refresh()` → 读到 `currentPhase='finalizing'` ✅ 此处 badge 可见
2. Phase C 门禁（primary 纯代码，无 AI）→ `commitFinalize('gating')`（仅门禁失败时）→ 此处间隔极短
3. `completeAfterFinalize` → `commitFinalize('routing')` → UI 收到事件 → `refresh()` 排队
4. `resolveNextNodes()` → 纯代码路由（无 AI 时极快完成）
5. `commitFinalize('completed')` → UI 收到事件 → `refresh()` 排队
6. UI 第一次 `refresh()` 执行 → 读到 `currentPhase='completed'`（步骤 5 已完成）
7. UI 第二次 `refresh()` 执行 → 读到 `currentPhase='completed'`

**结果**：UI 只看到 `completed`，中间 `routing` 阶段完全不可见。`previousPhase='routing'` 由步骤 5 的 `buildFinalizeMeta` 保存（`existing?.currentPhase` = 步骤 3 写入的 `routing`），但 UI 刷新时读到的 `previousPhase` 也是 `routing`（因为步骤 5 的 `buildFinalizeMeta` 已经把 `previousPhase` 从 `routing` 覆盖为 `routing`——自己覆盖自己）。

**等等，这里有个细节**：步骤 3 写入 `currentPhase='routing'`，步骤 5 写入时 `existing?.currentPhase='routing'`，所以 `previousPhase='routing'`。UI 最终看到 `currentPhase='completed' + previousPhase='routing'`。`finalizing` 已被 `routing` 覆盖。

### 修复计划

#### 涉及文件

| 文件 | 改动类型 |
|------|---------|
| `packages/sandore/ui/src/client/RunView.tsx` | UI 刷新时序优化 |
| `packages/sandore/ui/src/client/step-phase.ts` | 事件去重/节流 |
| `packages/sandore/microflow/src/finalize-manager.ts` | `buildFinalizeMeta` 历史记录增强（可选） |

#### 具体改动

**改动 1：`step-phase.ts` 增加去重/节流——同一 stepId 的连续事件合并为一次通知**（L37-46）

```typescript
// 改前
function notifyStepPhase(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      console.error('ui-sandore: step-phase listener failed', error)
    }
  }
}

// 改后：增加 300ms 去重窗口——同一 stepId 的连续事件在窗口内只通知一次
let lastNotifyTime = 0
let notifyTimer: ReturnType<typeof setTimeout> | undefined

function notifyStepPhase(): void {
  const now = Date.now()
  if (now - lastNotifyTime < 300) {
    // 去重窗口内：取消前一个延迟通知，重新安排
    if (notifyTimer !== undefined) clearTimeout(notifyTimer)
    notifyTimer = setTimeout(() => {
      notifyTimer = undefined
      lastNotifyTime = Date.now()
      for (const listener of listeners) {
        try { listener() } catch (error) { console.error('ui-sandore: step-phase listener failed', error) }
      }
    }, 300)
    return
  }
  lastNotifyTime = now
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      console.error('ui-sandore: step-phase listener failed', error)
    }
  }
}
```

**效果**：`routing` 事件到达后 300ms 内如果有 `completed` 事件到达，合并为一次通知。UI 刷新时读到的是 `completed`（最终态），但因为有 300ms 窗口，UI 有机会在 `routing` 写入后、`completed` 写入前执行一次 `refresh()`——**但这取决于 `resolveNextNodes` 的耗时**。

**问题**：300ms 去重只是治标。如果 `resolveNextNodes` 在 100ms 内完成（纯代码路由），UI 仍来不及看到 `routing`。

**改动 2（推荐）：`RunView.tsx` 利用 `previousPhase` 灰显——确保 UI 能渲染「routing → completed」流转**（已有，需确认生效）

上一轮已实现 `previousPhase` + `PhaseBadge` 灰显。但用户说仍看不到——**需确认以下条件**：

1. `buildFinalizeMeta` 的 `previousPhase` 逻辑是否正确覆盖了所有阶段
2. `PhaseBadge` 的 `prevPhaseKey` 渲染是否正确
3. `run-view-model.ts` 是否正确映射了 `finalizePreviousPhase`

检查 `UnifiedTimeline.tsx` L228-234：
```tsx
const prevPhaseKey = finalizePhaseKey(item.finalizePreviousPhase)
return (
  <>
    {prevPhaseKey !== undefined && (
      <span className={css.phaseLabel}>{t(prevPhaseKey)}</span>
    )}
```

**确认**：UI 侧确实渲染了 `previousPhase` 灰显标签。但用户说「没看到」——可能是 CSS 样式问题（灰显标签颜色太浅、与背景融合），或用户没注意到。

**改动 3（核心）：`buildFinalizeMeta` 增加 `phaseHistory` 数组——记录所有阶段到达历史**

```typescript
// 改前（finalize-manager.ts L584-608）
function buildFinalizeMeta(
  existing: FinalizeMeta | undefined,
  assessResult: FinalizeAssessResult | undefined,
  gateResult: GateEvalResult | undefined,
  currentPhase: NonNullable<FinalizeMeta['currentPhase']>,
  options?: { readonly recordAssessSession?: boolean },
): FinalizeMeta {
  const previousPhase = existing?.currentPhase;
  return {
    currentPhase,
    ...(previousPhase !== undefined ? { previousPhase } : {}),
    ...
  };
}

// 改后：增加 phaseHistory 记录所有阶段
function buildFinalizeMeta(
  existing: FinalizeMeta | undefined,
  assessResult: FinalizeAssessResult | undefined,
  gateResult: GateEvalResult | undefined,
  currentPhase: NonNullable<FinalizeMeta['currentPhase']>,
  options?: { readonly recordAssessSession?: boolean },
): FinalizeMeta {
  const previousPhase = existing?.currentPhase;
  // 追加阶段历史（去重：同阶段连续写入不重复记录）
  const history = [...(existing?.phaseHistory ?? [])];
  if (history.length === 0 || history[history.length - 1] !== currentPhase) {
    history.push(currentPhase);
  }
  return {
    currentPhase,
    ...(previousPhase !== undefined ? { previousPhase } : {}),
    ...(history.length > 0 ? { phaseHistory: history } : {}),
    ...
  };
}
```

**配套 schema 改动**（`packages/sandore/workflow/src/schema.ts` L311-324）：
```typescript
export const FinalizeMetaSchema = z.object({
  ...
  phaseHistory: z.array(z.enum(['ask-detect', 'finalizing', 'gating', 'routing', 'completed'])).optional(),
  ...
});
```

**配套 UI 改动**（`run-view-model.ts` + `UnifiedTimeline.tsx`）：`TimelineStepItem` 增加 `phaseHistory` 映射，`PhaseBadge` 渲染完整阶段链（如 `finalizing → routing → completed`）。

**但这方案侵入较大**。更务实的方案：

**改动 4（推荐，侵入最小）：确认 `previousPhase` 灰显已生效 + CSS 样式调整**

如果 `previousPhase` 灰显确实生效但用户没注意到，只需调整 CSS 使其更醒目：

```css
/* timeline.module.css — 收尾阶段徽标灰显样式 */
.phaseLabel {
  /* 改前可能颜色太浅 */
  color: var(--text-tertiary);
  /* 改后：增加对比度 */
  color: var(--text-secondary);
  opacity: 0.8;
  font-size: 0.75em;
  margin-left: 0.25em;
}
```

#### 测试影响

- `step-phase.spec.ts`：需更新去重窗口相关测试
- `run-view-model.spec.ts`：需新增 `phaseHistory` 映射测试
- `finalize-manager.spec.ts`：需新增 `buildFinalizeMeta` 的 `phaseHistory` 测试
- `workflow-engine.spec.ts`：收尾四阶段集成测试需验证 `phaseHistory` 内容

#### 风险

- **低风险**：`previousPhase` 灰显已有实现，只需确认 CSS 可见性
- **中风险**：`phaseHistory` 方案侵入 schema + UI 映射 + 事件链路，需全面回归测试
- **高风险**：300ms 去重方案可能导致 5 秒轮询被延迟（`notifyStepPhase` 的去重窗口与 `refreshAndSchedule` 的 `POLL_INTERVAL_MS` 竞争）

---

## 问题 C：Phase B/C/D fork 子代理无法点击进入 / 历史读取失败

### 用户报告

点击宿主主代理的子代理页面，有的子代理报错「历史加载失败：subagent disappeared during history read（subagent-not-found）」，还有「会话记录损坏」。

### 根因分析

**根因文件 1**：`packages/sandore/microflow/src/fork-session.ts` L286-294（`forkStepSubagent` 的 `agents.create` 调用）

**根因文件 2**：`D:\project-code\llm\deepseek-harness\packages\api\remotes\src\agent-lookup.ts` L94-111（`inspectApiRemoteSession` 的 `cwd` 校验）

**根因文件 3**：`D:\project-code\llm\deepseek-harness\packages\host\apiproxy\src\api-proxy.ts` L2584-2633（subagent history RPC 的 `inspectServable` 调用）

#### 机制 1：`inspectApiRemoteSession` 要求 `cwd` 非 undefined（agent-lookup.ts L94-111）

```typescript
export async function inspectApiRemoteSession(
  ctx: Context,
  sessionId: SessionId,
): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) {
    throw new Error('session persistence is not configured')
  }
  const meta = (await persistence.list()).find(candidate => candidate.id === sessionId)
  if (meta === undefined || meta.cwd === undefined) {  // ← cwd 必须非 undefined
    throw new ApiRemoteSessionNotFound(`session "${sessionId}" not found`)
  }
  const inspected = await persistence.inspect(sessionId)
  if (inspected.meta.cwd === undefined) {  // ← 再次校验
    throw new ApiRemoteSessionNotFound(`session "${sessionId}" not found`)
  }
  return { meta: inspected.meta, events: [...inspected.events] }
}
```

**DSH 的 `inspectApiRemoteSession` 把 `cwd === undefined` 等同于"会话不存在"**——这是一个设计约束：没有 `cwd` 的会话不被服务（"Logs without a cwd are not served"，api-proxy.ts L1946 注释）。

#### 机制 2：`forkStepSubagent` 的 `meta.cwd` 条件写入

```typescript
// fork-session.ts L286-294
const handle = await opts.createAgent({
  sessionId: SessionId(synthesizeFinalizeChildId(opts.stepId)),
  seed,
  meta: {
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),  // ← cwd 条件写入
    parentSession: SessionId(opts.hostAgentId),
    seedLength: seed.length,
    origin: 'subagent',
  },
});
```

**`opts.cwd` 来自 `input.workdir`**（finalize-manager.ts L725）：
```typescript
const forked = await forkStepSubagent(this.ctx, input.stepSessionId, {
  hostAgentId,
  stepId: input.step.id,
  ...(input.workdir === undefined ? {} : { cwd: input.workdir }),  // ← 条件写入
  ...
});
```

**`input.workdir` 来自 `FinalizeStepRequest.workdir`**，由 `buildFinalizeRequest` 注入（stage-executor.ts L1185）：
```typescript
workdir: this.options.sharedState.cwd,
```

`sharedState.cwd` 来自 `StageSharedState`，由引擎注入（workflow-engine.ts L1228-1229）：
```typescript
sharedState: {
  cwd: active.state.cwd,
  taskId: active.state.taskId,
},
```

**`active.state.cwd` 来自 `makeInitialState`**（workflow-engine.ts L247）：
```typescript
cwd,
```

**`cwd` 来自 `startInstance` 的 `request.cwd` 或 `defaults.cwd`**——正常情况下**一定有值**。

**但 `ForkStepSubagentOptions.cwd` 类型是 `string | undefined`**（fork-session.ts L210）：
```typescript
readonly cwd?: string;
```

**如果调用链任何一环传递了 `undefined`（如 `input.workdir` 为 `undefined`），`meta.cwd` 不会被写入**——`agents.create` 发布的会话 header 没有 `cwd` 字段 → 持久化记录的 `meta.cwd === undefined` → `inspectApiRemoteSession` 抛 `ApiRemoteSessionNotFound` → UI 收到 `subagent-not-found`。

#### 机制 3：Secondary 门禁子代理缺少 `cwd`

检查 `evaluateSecondary`（finalize-manager.ts L929-936）：
```typescript
const handle = await createAgent({
  sessionId: synthesizeGateChildId(input.step.id),
  meta: {
    ...(input.workdir === undefined ? {} : { cwd: input.workdir }),  // ← 条件写入
    parentSession: hostAgentId,
    origin: 'subagent',
  },
});
```

同样条件写入。**如果 `input.workdir` 为 `undefined`，gate 会话也无 `cwd`**。

#### 机制 4：Phase D 路由子代理

检查 `dispatchAi`（branch-evaluator.ts L600-606）：
```typescript
const forked = await forkStepSubagent(this.ctx, options.stepSessionId, {
  hostAgentId,
  stepId: options.stepId ?? 'route',
  ...(options.workdir === undefined ? {} : { cwd: options.workdir }),  // ← 条件写入
  ...
});
```

同样条件写入。

#### 核心结论

**根因**：`forkStepSubagent` 和 `evaluateSecondary` 中 `meta.cwd` 是**条件写入**（`opts.cwd === undefined` 时不写入），但 DSH 的 `inspectApiRemoteSession` **强制要求 `cwd` 非 undefined**。当 `workdir` 为 `undefined` 时，创建的 fork 子代理会话持久化记录无 `cwd` → 历史读取时 `inspectApiRemoteSession` 抛 `ApiRemoteSessionNotFound` → UI 收到 `subagent-not-found`。

**为什么 `workdir` 可能为 `undefined`**：
1. **单元测试裸配置**：测试中 `sharedState.cwd` 可能未注入
2. **异常路径**：`startInstance` 的 `request.cwd` 未传入且 `defaults.cwd` 未配置
3. **恢复路径**：`recoverInstance` 从持久化快照恢复时 `active.state.cwd` 可能为 `undefined`（旧快照无 `cwd` 字段）

**实际运行中 `workdir` 几乎一定有值**（`makeInitialState` 从 `request.cwd` 或 `defaults.cwd` 取），但代码层面的条件写入是防御性缺陷。

#### 「会话记录损坏」的根因

「会话记录损坏」可能来自以下场景：

1. **seed 事件截断不完整**：`computeSafeRevertBoundary` 截到最后一个 `turn/end`，但如果事件流本身不完整（如持久化写入中断、崩溃恢复截断），seed 可能包含不平衡的 turn 边界 → `agents.create` 发布时校验失败或发布后会话状态异常
2. **fork 会话创建后立即 dispose**：`handle.dispose()` 移除 live session，但持久化记录保留。如果 dispose 时机不当（如在 `whenIdle()` 之前 dispose），持久化事件可能不完整
3. **DSH 侧 seed 校验**：`agents.create` 的 seed 契约要求 balanced completed-turn prefix、contiguous from seq 0。如果截断逻辑有边界 bug（如 `seq` 不从 0 开始、中间有跳跃），seed 校验失败

### 复现链路

1. Step 执行完成 → Phase B `assessForked` → `forkStepSubagent(ctx, stepSessionId, { hostAgentId, stepId, cwd: workdir, ... })`
2. `workdir` 为 `undefined`（异常路径）→ `meta` 中无 `cwd` 字段
3. `agents.create` 成功发布（`agents.create` 不校验 `cwd`）
4. 会话持久化 → `persistence.list()` 返回的 header 无 `cwd`
5. 用户点击 PhaseBadge → `openSession(assessSessionId)` → `sessions.open(id)` → UI 打开会话面板
6. UI 请求历史 → RPC `subagent.history` → `inspectServable(childSessionId)` → `inspectApiRemoteSession`
7. `meta.cwd === undefined` → 抛 `ApiRemoteSessionNotFound` → UI 收到 `subagent-not-found` → 显示「历史加载失败」

### 修复计划

#### 涉及文件

| 文件 | 改动类型 |
|------|---------|
| `packages/sandore/microflow/src/fork-session.ts` | 核心修复：强制写入 `cwd` |
| `packages/sandore/microflow/src/finalize-manager.ts` | 核心修复：secondary gate 强制写入 `cwd` |
| `packages/sandore/microflow/src/branch-evaluator.ts` | 核心修复：Phase D 路由强制写入 `cwd` |

#### 具体改动

**改动 1：`forkStepSubagent` 强制写入 `cwd`（fork-session.ts L286-294）**

```typescript
// 改前
meta: {
  ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
  parentSession: SessionId(opts.hostAgentId),
  seedLength: seed.length,
  origin: 'subagent',
},

// 改后：cwd 必须写入（DSH inspectApiRemoteSession 强制要求 cwd 非 undefined）
// opts.cwd 未传时回退 '/'（默认工作目录），确保持久化记录可被 DSH 服务
meta: {
  cwd: opts.cwd ?? '/',
  parentSession: SessionId(opts.hostAgentId),
  seedLength: seed.length,
  origin: 'subagent',
},
```

**改动 2：`evaluateSecondary` 强制写入 `cwd`（finalize-manager.ts L929-936）**

```typescript
// 改前
meta: {
  ...(input.workdir === undefined ? {} : { cwd: input.workdir }),
  parentSession: hostAgentId,
  origin: 'subagent',
},

// 改后
meta: {
  cwd: input.workdir ?? '/',
  parentSession: hostAgentId,
  origin: 'subagent',
},
```

**改动 3：`dispatchAi` / `runRoutingAi` 的 `forkStepSubagent` 调用（branch-evaluator.ts L485-492, L600-606）**

这两个调用传入 `options.workdir` 给 `forkStepSubagent`，而 `forkStepSubagent` 内部已经修复（改动 1），无需额外改动。但确认 `options.workdir` 的来源：

```typescript
// branch-evaluator.ts L488
...(options.workdir === undefined ? {} : { cwd: options.workdir }),
```

此传入给 `ForkStepSubagentOptions`，由 `forkStepSubagent` 内部的改动 1 兜底。**无需额外改动**。

**改动 4（可选，需 DSH 改动）：`inspectApiRemoteSession` 容忍 `cwd === undefined`**

DSH 侧 `inspectApiRemoteSession`（agent-lookup.ts L103）把 `cwd === undefined` 当作会话不存在：
```typescript
if (meta === undefined || meta.cwd === undefined) {
  throw new ApiRemoteSessionNotFound(`session "${sessionId}" not found`)
}
```

**这是一个 DSH 设计约束**（"Logs without a cwd are not served"），改 DSH 可能影响其他逻辑。**推荐 sandore 侧强制写入 `cwd`（改动 1-3），不改 DSH**。

#### 测试影响

- `fork-session.spec.ts`：需新增「`opts.cwd` 为 `undefined` 时 meta.cwd 回退 `/`」的测试
- `finalize-manager.spec.ts`：需新增「secondary gate `workdir` 为 `undefined` 时 meta.cwd 回退 `/`」的测试
- `stage-executor.spec.ts`：Phase B 真 fork 测试用例的 `createMetas` 断言需适配 `cwd: '/'` 回退
- `workflow-engine.spec.ts`：收尾真 fork 集成测试需验证 fork 子代理持久化记录含 `cwd`

#### 风险

- **低风险**：`cwd` 回退 `/` 只在异常路径生效（正常路径 `workdir` 一定有值），不影响正常功能
- **中风险**：回退 `/` 可能导致 fork 子代理的工作目录与预期不符（但 fork 子代理本身不执行文件操作，只做 AI 评估/判断，`cwd` 仅用于 DSH 会话归属校验）
- **需 DSH 改动（用户此前不允许改 DSH）**：若要从根本上修复，需 DSH 侧 `inspectApiRemoteSession` 容忍 `cwd === undefined`。sandore 侧的 `cwd` 回退是规避方案。

---

## 汇总

| 问题 | 根因 | 修复方案 | 风险 |
|------|------|---------|------|
| **A：JSON 解析失败** | `stripJsonFence` 正则太严格（不认围栏前文字）+ 提示词未要求围栏 | ① 增强 `stripJsonFence` 正则 ② 提示词要求 ` ```json ``` ` 包裹 ③ 重试 hint 同步说明 | 低 |
| **B：中间阶段不可见** | `routing → completed` 几乎同步完成，UI RPC 刷新读到最终态；`previousPhase` 灰显已有但可能 CSS 不醒目 | ① `step-phase.ts` 增加去重窗口 ② 确认 `previousPhase` CSS 可见性 ③ 可选：`phaseHistory` 数组 | 中 |
| **C：fork 子代理历史读取失败** | `forkStepSubagent`/`evaluateSecondary` 的 `meta.cwd` 条件写入，DSH `inspectApiRemoteSession` 强制要求 `cwd` | ① `forkStepSubagent` 强制写入 `cwd ?? '/'` ② `evaluateSecondary` 同理 | 低 |

### 计划文档路径

`D:\project-code\llm\sandore\docs\bugfix\bugfix-2026-08-17-3issues-round2.md`
