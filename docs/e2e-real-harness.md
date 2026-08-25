# 真实 e2e 测试实施方案（进程内真实 DSH harness）

> 目标：写一个**真实 e2e** vitest spec，用真实 LLM/子代理（非 mock）跑工作流
> `wfl-2dcf2ae6-c87a-4bd4-95cd-f6001de0a13c`（test-workflow），在临时目录
> `tmp/uuid` 执行；检测 state 每个状态变化（step 执行 / 收尾 / 分支判断 / 执行顺序），
> 从 state 与事件检查，无遗漏、准确无误才算通过。
> 实现方式：**进程内真实 harness** —— 在测试进程里 boot 真实 DSH 服务栈
> （profile `web` + sandore 静态组合），直接 `ctx` 访问 `sandoreEngine` 与 `sandore/*` 事件。
>
> 本文只做设计，不改任何源码。

---

## 0. 结论摘要（5 个技术细节，全部带代码证据）

### 0.1 boot 与端口
- `runProfile({environment, profile, patchFiles, args})`（`deepseek-harness/apps/cli/src/profile-boot.ts:207`）
  会完整 boot 一条 profile 树：bundle 层 + `~/.dsh/profiles/<profile>/cordis.patch.yml` +
  `~/.dsh/cordis.patch.yml`（home 层）+ `--patch` overlays + 遥测开关，并返回 `{ctx, shutdown}`。
- **webserver 端口来源**：`packages/bundle/web-app/cordis.patch.yml:121-126` 的
  `webserver` 行 `port: !!js ctx.webStartup.port ?? 3080`；`webStartup` 由 `web-startup`
  行解析 CLI 参数（`packages/bundle/web-app/src/startup.ts:53`：`--port <port>`，
  **传 `0` 即由 OS 分配随机端口**，`--no-open` 禁止自动开浏览器）。
  因此测试传 `args: ['--no-open', '--port', '0']` 即可**彻底避开 3080/3090 冲突**。
  生产 3080、dev 3090 都是独立进程，互不影响。
- **HMR watcher**：web bundle 把 `hmr` 行 `disabled: true`
  （`packages/bundle/web-app/cordis.patch.yml:22-23`），`runProfile` 在 boot 后检测
  `ctx.get('hmr') === undefined` 会补挂**只 watch 配置**的 `cordis-plugin-hmr`
  （`root: []`）+ timer，并 `watchUserPatches` 监听两个用户 patch 文件
  （`profile-boot.ts:268-298`）。测试进程内只是空转，`ctx.fiber.dispose()` 时随树销毁，无副作用。
- **信号处理器**：`runProfile` 注册 `SIGTERM`/`SIGINT` → `shutdown.interrupt`
  （`profile-boot.ts:221-222`），并 `installFailLoud` 挂 `unhandledRejection` →
  `process.exit(1)`（`packages/boot/app-boot/src/index.ts:609-649`）。测试进程里这两个
  处理器**不会自行触发**（只有真实信号 / 未处理 rejection 才触发），可容忍；若要求零副作用，
  见 §3.2 方案 A（直接 `boot()`，不挂信号 / fail-loud / HMR）。
- **干净 dispose**：直接 `await ctx.fiber.dispose()`（整个树级销毁，webserver 关端口、
  watcher/订阅全清理），**不要调 `shutdown.shutdown()`**（它会 arm 5s 强杀定时器 + 写
  `process.exitCode`）。
- **sandore cordis.yml 依赖的服务**（`D:\project-code\llm\sandore\cordis.yml`）：
  只插入 `sandore-workflow`（依赖链见 `plugin.ts`：`storageDomain → sandorePersistence →
  sandoreEngine → sandore RPC`）、`sandore-ui`、`storage-sqlite`，并 patch
  `storage-domain` 路由 `sandore → sqlite`。引擎 `static inject`
  （`workflow-engine.ts:314`）= `['sessions','sessionPersistence','subagents','agents','llm',
  'shell','subprocess','fs','storageDomain','sandorePersistence','userQuestions','sessionTitle']`。
  这些服务在 `dsh-base` + `dsh-web-app` 两个 bundle 里**全部存在**（`sessions`=dsh-session、
  `sessionPersistence`=session-persistence-jsonl、`subagents`=dsh-subagent、`agents`=dsh-agent、
  `llm`=dsh-llm、`shell`=pwsh-sandbox（win32）/bash-sandbox、`subprocess`=dsh-subprocess-local、
  `fs`=dsh-fs-sandbox、`storageDomain`=dsh-storage-domain、`userQuestions`=dsh-user-questions、
  `sessionTitle`=dsh-session-title）。**boot 时这些服务自动齐全，无需测试侧补任何 provider。**

### 0.2 模型密钥
- `C:\Users\snowYuki\.dsh\settings.yaml` 的 `llm-pi-ai.providers.xiaomi-token-plan-cn`
  只有 `apiKeyEnv: XIAOMI_TOKEN_PLAN_CN_API_KEY`；真实密钥在
  `C:\Users\snowYuki\.dsh\.credentials.yaml`（LocalCredentialProvider 读取，密钥名已核实存在）。
- 测试进程**不需要手动加载密钥**：boot 的 `settings` 行（dsh-settings-file）与 `credentials`
  行（dsh-credentials-local）自动读 `$DSH_HOME/settings.yaml` / `.credentials.yaml`
  （`packages/bundle/base/cordis.patch.yml:78-96`），pi-ai 路由按 `apiKeyEnv` 每次请求解析。
- `runProfile` 的 `environment` 参数类型 = `LaunchEnvironmentSnapshot`
  （`packages/util/launch-environment/src/index.ts:37-52`），bin.ts 用
  `loadLayeredEnv('dsh')` 构造（`apps/cli/src/bin.ts:33`，读取 继承环境 + cwd/.env +
  $DSH_HOME/.env，不覆盖已存在变量）。测试照抄即可。
- **预检**：boot 后 `await ctx.credentials.resolve(credentialRef('XIAOMI_TOKEN_PLAN_CN_API_KEY'))`
  为 `undefined` 时直接 fail 并给出明确报错（避免跑 20 分钟后才发现密钥缺失）。

### 0.3 工作流定义导入
- 推荐**方案 a**：测试里 `ctx.sandorePersistence.definitions.put(id, {yaml, name, version,
  createdAt, updatedAt})` 直接注入（`persistence.ts:41`、`WorkflowDefinitionRecord` 5 字段，
  结构同现有 mock e2e `workflow-engine-e2e.spec.ts:32-42` 的 `putDefinition`）。
  YAML 内容固化进测试 fixture（UTF-8，内容抄自 `tmp-workflow-inspect.txt` 的 YAML 段），
  自包含、不依赖 dev 数据。
- **污染问题**：真实 boot 的 storage-domain 路由 sandore→sqlite（`cordis.yml:34-38`），
  sqlite 文件 = `dshHomePath('storages/sandore.sqlite')`（真实库）。**必须用独立临时
  storageDomain**：给 `runProfile` 追加一个临时 overlay patch 文件，把
  `storage-sqlite.path` 重定向到 `tmp/uuid/sandore.sqlite`（并重申
  `storage-domain` 路由）。这样 definitions/state 全部写临时库，**真实 sqlite 零污染**
  （overlay 在 patch 栈最后，id-targeted 整行覆盖 config，见 §3.3）。

### 0.4 临时目录
- `fs` 服务 = `dsh-fs-sandbox`（base bundle，`cordis.patch.yml:443-444`），其自身 `cwd`
  默认 `process.cwd()`（vitest 进程 cwd = sandore 仓库根）。但**会话级沙箱模式**决定读写边界：
  `startInstance` 传 `permission: 'danger-full-access'`（`workflow-engine.ts:193-197` →
  sandbox `danger-full-access` + approval `never`）后，fs 服务对宿主/子代理**完全放行**
  （`packages/fs/fs-sandbox/src/index.ts:24,129`：danger-full-access 不设围栏），
  tmp 目录读写不受 `workspaceRoot` 限制。子代理的 cwd = 会话 header cwd（= 工作流 cwd），
  相对路径（`artifacts/...`、`counts.json`）都落在 tmp 下。
- 临时目录：测试用 Node `fs.mkdtemp` 在 `log/e2e/<uuid>`（`log/` 已在 .gitignore）
  或 `os.tmpdir()/sandore-e2e-<uuid>` 创建；结束**先 `ctx.fiber.dispose()` 再删目录**
  （sqlite 可能持有句柄，Windows 上顺序反了会删不掉）。

### 0.5 hostSessionId / hostAgent
- **`hostSessionId` 是可选的**。不传时引擎自行 `ctx.agents.create({sessionId: instanceId,
  meta: {cwd, agentPreset}, setup: createHostAgentSetup(...)})` 创建宿主主代理
  （`workflow-engine.ts:498-535`），并 attach 到 workspace（`workspaceRegistry` 缺失时静默跳过，
  headless 测试 OK）。测试**无需**预先创建任何 session/agent。
- 真实 `agents.create` 签名 = `CreateAgentOptions {sessionId, meta, setup}`，与引擎调用兼容
  （`packages/core/agent/src/index.ts:80-156`）。
- 子代理闭环：prompt step 经 `ctx.subagents`（dsh-subagent + spawn-in-process provider）创建
  真实子代理；子代理 settle → DSH `subagent/end` → 引擎自带适配层转译
  `sandore/subagent-settled`（`workflow-engine.ts:398-416`）→ `awaitSubagentSettlement`
  唤醒，**不需要任何外部桥接**。宿主主代理被引擎冻结（`agent/pre-step` reject，
  `workflow-engine.ts:448-459`），仅作 parent 身份锚点。
- 模型路由：`runnerConfig` 把 `state.modelSelection`（startInstance 传入的 `model`）作为
  L2 默认，子代理 `agentOptions: {provider, model}`（`microflow/src/step-runner.ts:482-487`），
  所以 startInstance 显式传 `model: {provider:'xiaomi-token-plan-cn', model:'mimo-v2.5-pro'}`
  即可全程走真实模型（与原 dev 实例一致）。

---

## 1. 总体设计

```
vitest 进程（sandore 仓库）
└─ workflow-engine-real-e2e.spec.ts
   ├─ gate: SANDBORE_E2E_REAL=1 才跑（默认 skip，不进 pnpm test）
   ├─ beforeAll(180s):
   │   ├─ 预检：credential 存在（resolve 非 undefined）
   │   ├─ 建 tmp/uuid（工作流 cwd + 临时 sqlite overlay + 可选 sessions 重定向）
   │   ├─ runProfile / boot：profile web + patch[sandore cordis.yml, 临时 overlay]
   │   │        args=['--no-open','--port','0']，environment=loadLayeredEnv('dsh')
   │   ├─ ctx.sandorePersistence.definitions.put(<wfl-id>, fixture YAML)
   │   └─ 注册事件收集器（sandore/* 全量，按 taskId 过滤）
   ├─ it('真实跑 test-workflow 并做结构性不变量断言', {timeout: 40min}):
   │   ├─ 挂 sandore/question 自动回答（选第一个 option）
   │   ├─ engine.startInstance({workflowId, originalInput, cwd: tmp/uuid,
   │   │        model: {xiaomi-token-plan-cn / mimo-v2.5-pro}, permission: 'danger-full-access'})
   │   ├─ await sandore/end（超时则 dump 精简 state 后失败）
   │   └─ 断言组 A~H（见 §3.6）
   └─ afterAll: ctx.fiber.dispose() → 删 tmp/uuid
```

关键事实依据（侦察确认）：
- `startInstance` 返回后引擎 fire-and-forget 执行（`workflow-engine.ts:565-567`），
  事件经 `emitContained` 在引擎 ctx 上 emit（`workflow-engine.ts:1930-2075`，
  全部 `sandore/*` 事件第一参是 `DagRunInfo {taskId, workflowId}`）。
- 终态信号：`sandore/end`，`result.status ∈ {completed, failed, aborted}`
  （`workflow-engine.ts:1482 / 1110 / 761 / 1543`）。
- 完成态仍可从内存读：`engine.getInstanceState(instanceId)`（实例留在 `instances` 表，
  `workflow-engine.ts:629-631, 1477-1479`）。

---

## 2. 测试文件位置与命名

- 文件：`packages/sandore/workflow/src/workflow-engine-real-e2e.spec.ts`
  （与现有 mock e2e `workflow-engine-e2e.spec.ts` 同目录、命名区分明显）。
- fixture：`packages/sandore/workflow/tests/fixtures/test-workflow.yaml`
  （UTF-8；内容 = `tmp-workflow-inspect.txt` 中 `===== WORKFLOW YAML =====` 段，
  从 `id:` 到 `promptText: 输出miku-love!` 结束）。
- 不新增 devDependency（见 §3.1 相对路径导入说明）。

---

## 3. 具体方案

### 3.1 boot harness

#### 方案 B（最简，推荐起步）：`runProfile`

```ts
// 相对路径导入 DSH 源码（从 packages/sandore/workflow/src 上溯 5 级到 llm/）
// DSH 源码内部依赖经 apps/cli/node_modules（71 个 @deepseek-ai 链接）解析，与 dev 实例同路径
import { runProfile, INSTALL_ANCHOR } from '../../../../../deepseek-harness/apps/cli/src/profile-boot.ts'
import { loadLayeredEnv } from '../../../../../deepseek-harness/packages/boot/app-boot/src/index.ts'
import { credentialRef } from '../../../../../deepseek-harness/packages/credentials/credentials/src/index.ts'
```

```ts
async function bootRealHarness(opts: { tmpDir: string; overlayYamlPath: string }) {
  // 环境开关（boot 前设置；danger-full-access 让 fs 服务全程无围栏）
  process.env.DSH_PERMISSION_MODE = 'danger-full-access'
  process.env.DSH_TELEMETRY_DISABLED = '1' // 遥测行直接禁用，避免后台导出

  const { ctx, shutdown } = await runProfile({
    environment: loadLayeredEnv('dsh'),           // 与 bin.ts 完全一致
    profile: 'web',                                // 真实 web profile（3080 生产同款）
    patchFiles: [
      'D:/project-code/llm/sandore/cordis.yml',    // sandore 静态组合（只读）
      opts.overlayYamlPath,                        // 临时隔离 overlay（§3.3）
    ],
    args: ['--no-open', '--port', '0'],            // 随机端口，避开 3080/3090
  })
  return { ctx, shutdown }
}
```

dispose（afterAll）：

```ts
await ctx.fiber.dispose()   // 不调 shutdown.shutdown()（会 arm 5s 强杀定时器）
```

副作用清单（可接受，见 §0.1）：SIGTERM/SIGINT 处理器、unhandledRejection fail-loud、
watch-only HMR、`prepareProfile` 幂等重写 `~/.dsh/profiles/web/cordis.yml`（内容不变）。

#### 方案 A（进阶，零副作用）：直接 `boot()` + 手动组装 patches

不用 `runProfile`，自己拼 patch 栈（等价 `composeProfile`，`profile-boot.ts:142-171`）：

```ts
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import {
  boot, loadLayeredEnv, loadOptionalPatches, loadOverlayPatches,
} from '../../../../../deepseek-harness/packages/boot/app-boot/src/index.ts'
import { provideCmdline } from '../../../../../deepseek-harness/packages/boot/cmdline/src/index.ts'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '../../../../../deepseek-harness/packages/util/launch-environment/src/index.ts'
import {
  prepareProfile, homePatchPath, resolveTelemetryPatch,
} from '../../../../../deepseek-harness/apps/cli/src/profile-boot.ts'

const SHIPPED_PRESET_ROOT = fileURLToPath(new URL(
  '../../../../../deepseek-harness/apps/cli/config/agent-presets/', import.meta.url))

async function bootDirectHarness(overlayYamlPath: string) {
  const profile = prepareProfile('web') // 幂等重写 root 配置（同内容）
  const homePatches = loadOptionalPatches('dsh', homePatchPath()) ?? []
  const overlays = [
    ...['D:/project-code/llm/sandore/cordis.yml', overlayYamlPath]
      .flatMap(f => loadOverlayPatches('dsh', resolve(f))),
    // 只当组合里有 agent-presets 行时才补 shipped 预设根（web profile 必有）
    { id: 'agent-presets', config: { roots: [{ path: SHIPPED_PRESET_ROOT, trust: 'system' }] } },
  ]
  const telemetry = resolveTelemetryPatch(process.env.DSH_TELEMETRY_DISABLED, /*hasRow*/ true)
  const patches = [
    ...profile.layers.flatMap(l => l.patches),   // bundle 层
    ...profile.patches,
    ...homePatches,
    ...overlays,
    ...(telemetry === undefined ? [] : [telemetry]),
  ]
  const ctx = await boot('dsh', join(profile.dir, 'cordis.yml'), structuredClone(patches), (hostCtx) => {
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, loadLayeredEnv('dsh'))
    provideCmdline(hostCtx, { args: ['--no-open', '--port', '0'], exit: () => {} })
  })
  return { ctx }
}
```

优点：不装信号处理器、不装 fail-loud、不挂 HMR watcher；缺点：复制了 composeProfile 的
拼层逻辑（约 30 行），与上游有漂移风险。**建议先按方案 B 落地，若 CI 遇到
fail-loud 干扰再切方案 A。**

> 注意：boot 的插件解析走「配置目录 → 上溯 node_modules」——`~/.dsh/profiles/web` 无
> node_modules，但 `~/.dsh/profiles/node_modules`（共享、已核实含 206 个 @deepseek-ai 链接，
> 其中 `dsh-sandore-workflow` → `D:\project-code\llm\sandore\packages\sandore\workflow`）
> 提供全部包。**引擎加载的是 sandore 的 BUILT lib**（`exports["."] → lib/index.js`），
> 所以跑 e2e 前需先 `pnpm build`（至少 `pnpm --filter @deepseek-ai/dsh-sandore-workflow build`）。

### 3.2 端口 / 环境 / 密钥处理
- 端口：`args: ['--no-open', '--port', '0']` → webserver OS 随机端口（已验证 `--port 0`
  语义 + webserver `port:0 → OS 分配`）。
- 环境：`DSH_PERMISSION_MODE=danger-full-access`（boot 前设，sandbox 无围栏 +
  approval never）；`DSH_TELEMETRY_DISABLED=1`。`environment = loadLayeredEnv('dsh')`。
- 密钥：无需手动处理，boot 的 credentials 行自动读 `$DSH_HOME/.credentials.yaml`；
  预检 `ctx.credentials.resolve(credentialRef('XIAOMI_TOKEN_PLAN_CN_API_KEY'))`。

### 3.3 工作流定义注入 + 存储隔离

临时 overlay（测试运行时写入 `tmp/uuid/overlay.yml`）：

```yaml
# sandore real-e2e 隔离 overlay：sandore 存储域重定向到临时 sqlite
- id: storage-sqlite
  config:
    path: D:/project-code/llm/sandore/log/e2e/<uuid>/sandore.sqlite
- id: storage-domain
  config:
    backend: json
    routes:
      sandore: sqlite
# 可选：session 日志也隔离（默认写真实 ~/.dsh/sessions，仅积累 UUID 键日志，可接受）
# - id: session-persistence-jsonl
#   config:
#     root: D:/project-code/llm/sandore/log/e2e/<uuid>/sessions
```

注入定义（beforeAll）：

```ts
const yaml = await readFile(new URL('../tests/fixtures/test-workflow.yaml', import.meta.url), 'utf8')
const def = parseWorkflowYaml(yaml)   // 从 src/yaml-parser.ts 导入（类型/校验）
const now = new Date().toISOString()
await ctx.sandorePersistence.definitions.put(WORKFLOW_ID, {
  yaml, name: def.name, version: def.version, createdAt: now, updatedAt: now,
})
```

> overlay 是 id-targeted patch，位于 patch 栈最末（`--patch` overlays 在 profile/home 层之后），
> 整行覆盖 `storage-sqlite`/`storage-domain` 的 config，真实 `storages/sandore.sqlite` 零污染。

### 3.4 临时目录创建 / 清理

```ts
const tmpRoot = join(process.cwd(), 'log', 'e2e', randomUUID())   // log/ 已 gitignore
await mkdir(tmpRoot, { recursive: true })
// 工作流 cwd = tmpRoot；sqlite = tmpRoot/sandore.sqlite；overlay = tmpRoot/overlay.yml
// afterAll：先 dispose 再 rm -rf tmpRoot（Windows sqlite 句柄顺序）
```

### 3.5 ask 自动回答

```ts
ctx.on('sandore/question', (info, entry) => {
  if (info.taskId !== instanceId) return
  const answers = entry.payload.questions.map(q => ({
    id: q.id,
    selected: q.options?.length ? [q.options[0].label] : [],   // 选第一个选项
  }))
  void ctx.sandoreEngine.replyQuestion(instanceId, entry.requestId, { answers })
    .catch(e => ctx.logger.warn(`real-e2e: replyQuestion failed: ${String(e)}`))
})
```

原理（已核实）：子代理 child-scope `ask_user_question` → `engine.askFromSubagent`
（`workflow-engine.ts:867-909`）→ `interactions.ask` 登记 `PendingQuestionEntry`
（`interaction-manager.ts:177-195`）→ 双发 `sandore/question`(info, entry) → await；
`engine.replyQuestion(instanceId, requestId, {answers:[{id, selected}]})`
（`interaction-manager.ts:204-210` 的 `finishQuestion` 直接 resolve 引擎 waiter）。
headless 下 api-proxy 的浏览器卡片通道永不 resolve，但 `finishQuestion` 幂等，
`replyQuestion` 是权威路径；dispose 时卡片 promise 被 reject 也被 failQuestion 的
幂等守卫吞掉。**答案形状**：`AskUserQuestionAnswer = { answers: [{id, selected: string[], custom?}] }`
（`types.ts:98-112`）。

### 3.6 断言策略（结构性不变量清单）

> 真实 LLM 非确定：**不断言精确执行序列 / 精确分支选择**，只断言与路径无关的结构不变量；
> 路径相关的副作用改为条件不变量。数据源优先级：state（`engine.getInstanceState`）为准，
> 事件用于「无遗漏、准确」对账。

#### A. 终态与生命周期
1. 收到 `sandore/end`，`result.status === 'completed'`（超时失败时 dump 精简 state 辅助定位）。
2. `state.status === 'completed'`；`state.workflowId === <id>`；`state.taskId === instanceId`。
3. `state.pendingQueue` 为 `[]`；`pendingInteractions` 中无 `status === 'pending'` 条目
   （全部 replied / 空）。
4. 无孤儿 / 无悬挂段：executedSteps 每段 `id` 唯一；`visitCounts` 的每个 stepId 都在
   executedSteps 中出现过；终态下不存在 `status ∈ {'running','interacting'}` 的段。
5. 循环栈退净：`activeLoopIterationStack` / `activeLoopStack` 为空，
   `activeLoopNodeId === null`（退出全部循环）。
6. 事件序（按 taskId 过滤后）：第一个事件是 `sandore/start`，最后一个事件是 `sandore/end`，
   期间无 `sandore/aborted`；`sandore/end` 恰好一次。

#### B. 每段结构不变量
7. 字段合法：`stepId`/`stageId`/`name` 非空；`command.type ∈ {'prompt','shell'}`；
   `sessionMeta.childId` 为 UUID 且 `synthetic` 为 boolean。
8. `status === 'completed'` 的段必有 `finalizeMeta`：`currentPhase === 'completed'`，
   `previousPhase ∈ {'ask-detect','finalizing','gating','routing'}`（合法前一阶段）。
9. Result 状态：`assessResult.status === 'done'`；`gateResult.status === 'done'` 且
   `gatesPassed === true`、`primaryPassed === true`；`routingResult.status === 'done'`。
10. 门禁配置不变量：`sce1` 段的 `gateResult.gateDetails.secondary.enabled === true`
    （workflow 给 sce1 配了 secondary 门禁，prompt 非空）；其余 step 段的
    `secondary.enabled === false`；所有段 `primary.enabled === true`。
11. 步骤类型不变量：`parallel1` 段 `command.type === 'shell'` 且
    `sessionMeta.synthetic === true`（shell 合成会话）；prompt 段 `synthetic === false`
    （真实子代理）。
12. `step-phase` 事件合法（每 stepId 收集，按出现序）：phase 只能是
    `['ask-detect','finalizing','gating','routing','completed']` 的子序列且保持该顺序；
    终段 currentPhase 对应的最后一个 phase 事件必须是 `completed`。
    参照 mock e2e 的完整路径 `[finalizing, gating, gating, routing, completed]`
    （`workflow-engine-e2e.spec.ts:172-178`）。

#### C. 循环 / DAG 顺序不变量（核心）
13. **visitCount 上界**（由 YAML loop `maxIterations` 静态推导，与 LLM 路径无关）：
    - `step-1846d923`(sce1) ≤ 1 + 3（loop step 的 maxIterations=3 回跳 sce1）
    - `step-0437f4aa`(sce2) ≤ 1 + 3（修复问题 的 maxIterations=3 回跳 sce2）
    - `step-66af1c6f`(修复问题) ≤ 1 + 3（同上循环体）
    - `step-1eb7f032`(parallel1) ≤ 1
    - `step-18641f1a`(loop) ≤ 1
    断言 `visitCounts[stepId] <= expectedMax`。
14. **DAG 依赖顺序**（inputFrom 边）：`parallel1` 与 `sce2` 的 inputFrom 都指向 sce1，
    因此 sce1 的首段 `createdAt` 必须 < parallel1 首段与 sce2 首段的 `createdAt`。
15. **循环结构（宽松）**：若某 stepId 的 visitCount ≥ 2，则其后段（第 2 次及以后）带
    `loopIteration` 数组（非空）；`修复问题` 段与 `sce2` 段按 createdAt 交替出现
    （sce2 → 修复问题 → sce2 → …，出现即满足，不断言具体次数）。
16. **分支判断产物合法**：有 `routingResult.branchMeta` 的段，`branchMeta.status === 'completed'`
    且 `branchMeta.result` 可 `JSON.parse`（含 `shouldExecute` boolean 或分支判定字段）；
    loop step 的 `routingResult.loopMeta.result` 可 parse（含 `shouldBreak` boolean）。
17. 不做硬断言：精确路径（先 sce2 还是先 sce3）、精确循环次数（LLM 判断 counts.json
    时机不定）——真实分支由模型决定，属允许差异。

#### D. passThroughVars
18. `state.passThroughVars['change-name']` 存在（默认播种 `value: ''`）；`value` 为 string。

#### E. 文件副作用（cwd = tmp/uuid）
19. **无条件**：`tmpRoot/counts.json` 若存在则必须可 `JSON.parse` 且 `times` 为 number ≥ 1
    （若 sce2/修复问题 路径未走到，该文件可不存在 → 降级为条件断言，见 20）。
20. **条件不变量**：若 executedSteps 出现过 `修复问题` 段 → `counts.json` 存在且 `times ≥ 1`；
    若 `passThroughVars['change-name'].value` 非空 → `tmpRoot/artifacts/<change-name>/proposal.md`
    存在；`tmpRoot/artifacts/` 下若存在任意 `proposal.md`（含空名子目录）即证明 sce1 的
    outputTo 落盘（宽松扫描：`artifacts/**/proposal.md` 深度 ≤ 2）。
    > 注：`change-name` 由 LLM 评估提取，fresh 目录下可能为空串（见历史快照
    > `tmp-workflow-inspect.txt:1312-1317`），故 proposal.md 只做条件断言。

#### F. 事件-状态对账（「无遗漏、准确」核心）
21. 按 (stepId, loopIteration) 分组对账：executedSteps 中该组的段数 === 收集到的
    `sandore/step-start` 事件数 === `sandore/step-completed`（completed 段）事件数
    （段 id 不要求与事件 childId 相等：step-start 时可能是合成占位 childId，
    step-completed 是真实 childId，用 stepId+loopIteration 配对）。
22. 若有段 `status === 'failed'` → 必须收到过 `sandore/step-failed`（同 stepId），
    且最终 `sandore/end.status === 'failed'`（该情形视为测试失败）。
23. stage 对账：`sandore/stage-start` 与 `sandore/stage-completed` 各恰 2 次
    （demo1、demo2），顺序为 start(stg1) → … → completed(stg1) → start(stg2) → completed(stg2)。

#### G. ask 闭环
24. 至少收到一次 `sandore/question`（sce1 每次访问都会 ask）；每条 entry
    `kind === 'question'`、`requestId` 为 UUID、`payload.questions` 非空；
    最终在 `pendingInteractions` 里无该 requestId 的 pending 条目（已 replied）。
25. 回答后工作流能继续推进（能走到 `sandore/end` 即证明闭环有效）。

#### H. 模型真实调用证据（软断言，记日志不 fail）
26. 每个 prompt 段 `sessionMeta.childId` 对应一个真实注册过的子代理
    （`ctx.agents.get(childId)` 非 undefined，在终态清理前检查）；`output` 非空。

### 3.7 脚本 gate 与运行命令

```ts
const REAL_E2E = process.env.SANDBORE_E2E_REAL === '1'
const describeReal = REAL_E2E ? describe : describe.skip
describeReal('sandore workflow real e2e (真实 LLM/子代理)', () => { ... })
```

- 默认 `pnpm test`（`vitest run`）收集到该文件但整体 skip，**不影响常规测试**；
  为避免收集期加载 DSH 源码拖慢，boot 相关 import 用**动态 import**（放在
  `beforeAll` 内 `await import(...)`），文件顶部只保留 vitest 与轻量工具 import。
- 独立运行（PowerShell）：

```powershell
$env:SANDBORE_E2E_REAL='1'
pnpm exec vitest run packages/sandore/workflow/src/workflow-engine-real-e2e.spec.ts --no-file-parallelism
```

- 超时：`beforeAll(..., { timeout: 180_000 })`；用例
  `it('...', { timeout: 40 * 60_000 }, fn)`（真实跑一次约 10–30 分钟：
  历史快照显示单步 15–75s，循环最多 ~12 个 prompt/shell 段）。
  引擎侧单步超时由 sandore 配置 `defaultTimeoutMs: 7200000`（2h）兜底。
- 环境变量（可用 `SANDBORE_E2E_TIMEOUT_MS` 覆盖用例超时）。

---

## 4. 风险与未决问题

| # | 风险 / 未决 | 缓解 / 决策 |
|---|---|---|
| 1 | 依赖真实网络 + 密钥（xiaomi-token-plan-cn） | gate + boot 后 credential 预检，缺失即明确报错；不进 `pnpm test` |
| 2 | 单次运行 10–30 分钟 | 用例超时 40min 可配；CI 用独立 job |
| 3 | LLM 非确定路由（fresh 目录可能先走 sce3 而非 sce2） | 断言全部结构化为路径无关不变量（§3.6 C 组）+ 条件不变量（E 组） |
| 4 | `runProfile` 副作用：SIGINT/SIGTERM、unhandledRejection fail-loud、watch-only HMR、幂等重写 `~/.dsh/profiles/web/cordis.yml` | 可接受（与 dev 实例同路径）；要求零副作用则切方案 A（直接 `boot()`） |
| 5 | sandore 插件以 **BUILT lib** 加载（`exports["."] → lib/`） | e2e 前必须 `pnpm build`；测试本质验证的是部署产物（与 dev 实例一致） |
| 6 | Windows sqlite 句柄 | 清理顺序：先 `ctx.fiber.dispose()` 再删 tmp 目录 |
| 7 | 真实库污染 | overlay 重定向 `storage-sqlite` 到 tmp sqlite；可选再重定向 `session-persistence-jsonl` root（默认仅向 ~/.dsh/sessions 追加 UUID 键日志，可接受） |
| 8 | 事件与段的 childId 对应（step-start 可能为合成占位） | 对账用 (stepId, loopIteration) 配对，不比较 childId 相等 |
| 9 | 若 3090 dev 实例正在运行：两者共享 `profiles/node_modules` 与 `settings.yaml` 读取，互不写冲突；用户手改 `cordis.patch.yml` 会同时触发两边 watch（方案 B） | 低概率；方案 A 无此 watcher |
| 10 | `mimo-v2.5-pro` 模型在当前 pi-ai 目录的可用性 | startInstance 显式传 `model`（与原实例一致）；若模型路由失败，step 会 failed → 断言组 A/B 显式失败，便于定位；后续可改为读取 settings 或探测 `ctx.llm` 目录 |
| 11 | 未决：fixture YAML 固化 vs 运行时读 sqlite | 采用固化 fixture（自包含、可版本化）；`tmp-workflow-inspect.txt` 仅作一次性来源 |
| 12 | 未决：是否把 proposal.md / counts.json 断言升级为「outputTo 产物注册表对账」（stageContracts） | v1 保持 §3.6 E 组的条件断言；v2 可加 `state.stageContracts` 对账 |

---

## 5. 落地步骤（只读方案，未改动任何源码）

1. 新建 `packages/sandore/workflow/tests/fixtures/test-workflow.yaml`（UTF-8，抄自 tmp-workflow-inspect.txt YAML 段）。
2. 新建 `packages/sandore/workflow/src/workflow-engine-real-e2e.spec.ts`，按 §3 实现：
   gate（SANDBORE_E2E_REAL）→ 动态 import boot → 预检 credential → tmp/uuid +
   overlay → runProfile(args `--no-open --port 0`) → definitions.put → 事件收集 +
   ask 自动回答 → startInstance → await sandore/end → 断言 A~H → dispose + 清理。
3. `pnpm build`（保证 sandore lib 最新）后运行 §3.7 命令验证。
4. 首次跑通后，把失败诊断（精简 state dump 投影：剔除 sessionMessages/output/
   compressedOutput/assessmentRaw）写进断言失败消息，便于排障。
