/**
 * 真实 e2e：进程内真实 DSH harness（不 mock 任何服务）。
 *
 * 在 vitest 进程里用**方案 A（直接 `boot()` + 手动拼 patch 栈，见
 * `docs/e2e-real-harness.md` §3.1）** boot 完整 `web` profile + sandore 静态组合，
 * 用真实 LLM/子代理跑固定工作流 fixture `test-workflow.yaml`，从引擎 state 与
 * `sandore/*` 事件做 §3.6 的结构性不变量断言（A~H，26 条）。
 *
 * **gate**：`SANDBORE_E2E_REAL=1` 才跑（真实跑一次约 10–30 分钟，烧真实模型），
 * 默认整体 skip、不拖慢 `pnpm test` 收集期。DSH boot 相关 import 全部动态 import
 * （放在 beforeAll 内）；类型面仅用 `import('...')` 类型形式（编译期擦除，无运行时
 * 加载），文件顶部只保留 vitest + 轻量 node 工具 + sandore 类型。
 *
 * 注：
 * - sandore 工作区与 DSH harness 各自解析独立的 `@deepseek-ai/cordis`（sandore
 *   pnpm-store 副本 vs `deepseek-harness/vendor/cordis`），两个模块身份互不共享
 *   module augmentation——故 boot ctx 的 sandore 服务（sandoreEngine/sandorePersistence）
 *   用结构断言 `sandoreOf` 取用，事件注册经 `onSandore` 结构断言。
 * - **为什么不用方案 B（runProfile）**：Vite（vitest）不读 DSH tsconfig paths
 *   （`@deepseek-ai/cordis` → `vendor/cordis/src`），`@deepseek-ai/cordis` 解析到
 *   built `lib/index.js`，其不导出 const enum `FiberState`（无运行时对象），
 *   `runProfile` 的 `FiberState.ACTIVE` 在 vitest 进程里运行时崩溃；方案 A 只调用
 *   不触碰 `FiberState` 的函数（`boot()` 内部用数值镜像），可正常 boot。
 *
 * 运行（PowerShell）：
 * ```powershell
 * $env:SANDBORE_E2E_REAL='1'
 * pnpm exec vitest run packages/sandore/workflow/src/workflow-engine-real-e2e.spec.ts --no-file-parallelism
 * ```
 * @module dsh-sandore/workflow/src/workflow-engine-real-e2e
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat as statFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SandorePersistence } from './persistence.ts';
import type { SandoreEngine } from './seam.ts';
import type { DagResultInfo, DagRunInfo, PendingQuestionEntry, WorkflowTaskState } from './types.ts';
import { parseWorkflowYaml } from './yaml-parser.ts';

// ── gate ────────────────────────────────────────────────────────────────────

/** 真实 e2e 开关：`SANDBORE_E2E_REAL=1` 才执行（默认 skip，不进 pnpm test）。 */
const REAL_E2E = process.env.SANDBORE_E2E_REAL === '1';

/** 用例超时（默认 40min；可用 SANDBORE_E2E_TIMEOUT_MS 覆盖）。 */
const RUN_TIMEOUT_MS = Number.isFinite(Number(process.env.SANDBORE_E2E_TIMEOUT_MS))
  ? Number(process.env.SANDBORE_E2E_TIMEOUT_MS)
  : 40 * 60_000;

/** beforeAll boot 超时（方案 §3.7）。 */
const BOOT_TIMEOUT_MS = 180_000;

/** gate：非 REAL 时整体 skip。 */
const describeReal = REAL_E2E ? describe : describe.skip;

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 工作流定义 id（fixture 固化）。 */
const WORKFLOW_ID = 'wfl-2dcf2ae6-c87a-4bd4-95cd-f6001de0a13c';

/** 真实模型路由（2026-08-25：xiaomi 429 配额耗尽后改用 minimax-cn/minimax-m3）。 */
const MODEL_PROVIDER = 'minimax-cn';
const MODEL_ID = 'MiniMax-M3';

/** fixture 中关键 step id（断言引用）。 */
const SCE1_ID = 'step-1846d923-133b-4617-9aac-b0b7e9344795';
const PARALLEL1_ID = 'step-1eb7f032-7a25-4371-8a51-24aa2fb97b9f';
const SCE2_ID = 'step-0437f4aa-ce99-45f6-8088-698bd51aa363';
const FIX_ID = 'step-66af1c6f-3498-4aee-af39-95745c4b05ec';
const LOOP_ID = 'step-18641f1a-3fa8-4e45-bf48-ecc854e42bd5';

/** stage id。 */
const DEMO1_ID = 'stg-9b259283-4921-4fd7-9613-0b6ffee35898';
const DEMO2_ID = 'stg-d7554ec0-aca1-4667-a3a1-69928a4eb94c';

/** UUID 正则（step 段 id / childId / requestId 统一纯 UUID 格式）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** sandore/* 全量事件词表（与 sse.ts 的 SANDBORE_EVENTS 一致，手列 16 个保持自包含）。 */
const SANDBORE_EVENT_NAMES = [
  'sandore/start',
  'sandore/stage-start',
  'sandore/stage-completed',
  'sandore/step-start',
  'sandore/step-completed',
  'sandore/step-failed',
  'sandore/step-paused',
  'sandore/step-resumed',
  'sandore/step-retried',
  'sandore/step-phase',
  'sandore/step-message',
  'sandore/end',
  'sandore/aborted',
  'sandore/question',
  'sandore/permission',
  'sandore/question_rejected',
] as const;

/** 收尾阶段合法顺序（step-phase 事件须为其非递减子序列，允许重复，如 mock e2e 的
 * `[finalizing, gating, gating, routing, completed]`）。 */
const PHASE_ORDER = ['ask-detect', 'finalizing', 'gating', 'routing', 'completed'] as const;

// ── 类型桥（DSH boot ctx ↔ sandore 服务） ───────────────────────────────────

/**
 * `boot()` 返回的 boot ctx 类型（DSH 侧 cordis Context，含 DSH 全部
 * module augmentation；sandore 的 augmentation 因 cordis 双身份不在其上）。
 * 用 `typeof import('...')` 类型形式取，避免任何静态运行时 import。
 */
type BootCtx = Awaited<ReturnType<
  typeof import('../../../../../deepseek-harness/packages/boot/app-boot/src/index.ts')['boot']
>>;

/** boot ctx 上 sandore 注入服务的结构视图（类型面桥接，运行时原样）。 */
interface SandoreView {
  sandoreEngine: SandoreEngine;
  sandorePersistence: SandorePersistence;
}

/** 从 DSH boot ctx 取 sandore 服务（结构断言：双 cordis 身份下 augmentation 不互通）。 */
function sandoreOf(ctx: BootCtx): SandoreView {
  return ctx as unknown as SandoreView;
}

/**
 * 在 boot ctx 上注册 sandore/* 事件监听（DSH 侧 cordis 的 `Events` 无 sandore
 * 事件键，`ctx.on` 只有泛型重载——结构断言到 string 重载；参数布局见 seam.ts）。
 */
function onSandore(ctx: BootCtx, event: string, listener: (...args: unknown[]) => void): () => void {
  return (ctx.on as unknown as (name: string, cb: (...args: unknown[]) => void) => () => void)(event, listener);
}

// ── 事件收集（精简载荷，避免存大对象） ──────────────────────────────────────

/** 精简事件载荷：只存 taskId + 断言需要的叶子字段。 */
interface SlimEvent {
  eventName: string;
  taskId: string;
  stepId?: string;
  stageId?: string;
  phase?: string;
  name?: string;
  childId?: string;
  loopIteration?: number[];
  requestId?: string;
  kind?: string;
  status?: string;
  questionCount?: number;
  resultStatus?: string;
  resultError?: string;
}

/**
 * 把一次 `sandore/*` 事件调用投影为精简载荷（位置参数布局对齐
 * workflow-engine.ts 的 emit* 方法与 seam.ts 的事件双声明）。
 */
function toSlimEvent(eventName: string, args: unknown[]): SlimEvent | undefined {
  const info = args[0] as Partial<DagRunInfo> | undefined;
  if (info === undefined || typeof info.taskId !== 'string') {
    return undefined;
  }
  const ev: SlimEvent = { eventName, taskId: info.taskId };
  // loopIteration 位于参数尾部（有活跃循环时才附加）。
  const last = args[args.length - 1];
  if (Array.isArray(last)) {
    ev.loopIteration = last as number[];
  }
  switch (eventName) {
    case 'sandore/stage-start':
    case 'sandore/stage-completed':
      if (typeof args[1] === 'string') ev.stageId = args[1];
      break;
    case 'sandore/step-start':
    case 'sandore/step-completed':
    case 'sandore/step-failed':
    case 'sandore/step-paused':
    case 'sandore/step-resumed':
    case 'sandore/step-retried':
    case 'sandore/step-message':
    case 'sandore/step-phase':
      if (typeof args[1] === 'string') ev.stepId = args[1];
      if (typeof args[2] === 'string') ev.childId = args[2];
      if (typeof args[4] === 'string') {
        ev.name = args[4];
      } else if (typeof args[3] === 'string'
        && eventName !== 'sandore/step-phase'
        && eventName !== 'sandore/step-resumed'
        && eventName !== 'sandore/step-retried') {
        ev.name = args[3];
      }
      if (eventName === 'sandore/step-phase' && typeof args[3] === 'string') ev.phase = args[3];
      if (eventName === 'sandore/step-completed') ev.status = 'completed';
      break;
    case 'sandore/end': {
      const result = args[1] as Partial<DagResultInfo> | undefined;
      if (result !== undefined) {
        if (result.status !== undefined) ev.resultStatus = result.status;
        if (typeof result.error === 'string') ev.resultError = result.error;
      }
      break;
    }
    case 'sandore/question':
    case 'sandore/permission':
    case 'sandore/question_rejected': {
      const entry = args[1] as Partial<PendingQuestionEntry> | undefined;
      if (entry !== undefined) {
        if (typeof entry.requestId === 'string') ev.requestId = entry.requestId;
        if (typeof entry.kind === 'string') ev.kind = entry.kind;
        if (typeof entry.status === 'string') ev.status = entry.status;
        if (eventName === 'sandore/question') {
          ev.questionCount = entry.payload?.questions.length ?? 0;
        }
      }
      break;
    }
    default:
      break;
  }
  return ev;
}

// ── 诊断：精简 state dump（投影掉 sessionMessages/output/compressedOutput/assessmentRaw） ──

/** 终态/断言失败诊断用的精简 state 投影。 */
function dumpSlimState(state: WorkflowTaskState | undefined): string {
  if (state === undefined) {
    return '(state unavailable: engine.getInstanceState 返回 undefined)';
  }
  return JSON.stringify({
    taskId: state.taskId,
    workflowId: state.workflowId,
    status: state.status,
    currentStageId: state.currentStageId,
    stageInfos: state.stageInfos,
    pendingQueue: state.pendingQueue,
    pendingInteractions: state.pendingInteractions.map(p => ({
      requestId: p.requestId,
      kind: p.kind,
      status: p.status,
    })),
    visitCounts: state.visitCounts,
    passThroughVars: state.passThroughVars,
    activeLoopIterationStack: state.activeLoopIterationStack,
    activeLoopNodeId: state.activeLoopNodeId,
    activeLoopStack: state.activeLoopStack,
    executedSteps: state.executedSteps.map(s => ({
      id: s.id,
      stepId: s.stepId,
      name: s.name,
      status: s.status,
      visitCount: s.visitCount,
      loopIteration: s.loopIteration,
      currentPhase: s.finalizeMeta?.currentPhase,
      previousPhase: s.finalizeMeta?.previousPhase,
      branchMetaStatus: s.finalizeMeta?.routingResult?.branchMeta?.status,
      loopMetaStatus: s.finalizeMeta?.routingResult?.loopMeta?.status,
      gateStatus: s.finalizeMeta?.gateResult?.status,
      gatesPassed: s.finalizeMeta?.gateResult?.gatesPassed,
      createdAt: s.createdAt,
      error: s.error,
    })),
    stageContracts: Object.fromEntries(Object.entries(state.stageContracts).map(([k, v]) => [
      k,
      { status: v.status, artifacts: v.artifacts },
    ])),
  }, null, 2);
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

/** (stepId, loopIteration) 分组键（事件与段配对，§3.6 F-21）。 */
function groupKey(stepId: string | undefined, loopIteration: number[] | undefined): string {
  return `${stepId ?? ''}|${JSON.stringify(loopIteration ?? null)}`;
}

/** JSON 解析（失败 / 非对象返回 undefined）。 */
function tryParseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 深度 ≤ maxDepth 在 root/dir 下找 filename（宽松扫描 artifacts/**）。 */
async function findFile(root: string, dir: string, filename: string, maxDepth: number): Promise<string | undefined> {
  const walk = async (current: string, depth: number): Promise<string | undefined> => {
    if (depth > maxDepth) return undefined;
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let info: Awaited<ReturnType<typeof statFile>>;
      try {
        info = await statFile(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        const found = await walk(full, depth + 1);
        if (found !== undefined) return found;
      } else if (entry === filename) {
        return full;
      }
    }
    return undefined;
  };
  return walk(join(root, dir), 1);
}

describeReal('sandore workflow real e2e（进程内真实 DSH harness + 真实 LLM/子代理）', () => {
  // 模块级状态（beforeAll 填充，it 消费，afterAll 清理）。
  let bootCtx: BootCtx | undefined;
  let tmpRoot = '';
  let instanceId = '';
  const collectedEvents: SlimEvent[] = [];

  beforeAll(async () => {
    // ── 环境开关（boot 前设置）──
    process.env.DSH_PERMISSION_MODE = 'danger-full-access';
    process.env.DSH_TELEMETRY_DISABLED = '1';

    // ── 动态 import DSH boot 相关模块（避免拖慢 pnpm test 收集期）──
    // 方案 A（docs/e2e-real-harness.md §3.1）：直接 `boot()` + 手动拼 patch 栈。
    // 不用 runProfile——Vite 不读 DSH tsconfig paths（`@deepseek-ai/cordis` →
    // vendor/cordis/src），`@deepseek-ai/cordis` 解析到 built lib 且不导出 const enum
    // `FiberState`，runProfile 的 `FiberState.ACTIVE` 在 vitest 进程里会运行时崩溃。
    const { boot, composeEntries, loadLayeredEnv, loadOptionalPatches, loadOverlayPatches } = await import(
      '../../../../../deepseek-harness/packages/boot/app-boot/src/index.ts',
    );
    const { provideCmdline } = await import(
      '../../../../../deepseek-harness/packages/boot/cmdline/src/index.ts',
    );
    const { DSH_LAUNCH_ENVIRONMENT_KEY } = await import(
      '../../../../../deepseek-harness/packages/util/launch-environment/src/index.ts',
    );
    const { prepareProfile, homePatchPath, resolveTelemetryPatch } = await import(
      '../../../../../deepseek-harness/apps/cli/src/profile-boot.ts',
    );
    const { credentialRef } = await import(
      '../../../../../deepseek-harness/packages/credentials/credentials/src/index.ts',
    );
    const shippedPresetRoot = fileURLToPath(new URL(
      '../../../../../deepseek-harness/apps/cli/config/agent-presets/',
      import.meta.url,
    ));

    // ── 临时目录 + 存储隔离 overlay（§3.3/§3.4）──
    tmpRoot = join(process.cwd(), 'log', 'e2e', randomUUID());
    await mkdir(tmpRoot, { recursive: true });
    const overlayPath = join(tmpRoot, 'overlay.yml');
    const overlayYaml = [
      '# sandore real-e2e 隔离 overlay：sandore 存储域重定向到临时 sqlite（真实库零污染）',
      '- id: storage-sqlite',
      '  config:',
      `    path: ${tmpRoot.replaceAll('\\', '/')}/sandore.sqlite`,
      '- id: storage-domain',
      '  config:',
      '    backend: json',
      '    routes:',
      '      sandore: sqlite',
      '',
    ].join('\n');
    await writeFile(overlayPath, overlayYaml, 'utf8');

    // ── boot 完整 web profile + sandore 静态组合（随机端口避开 3080/3090）──
    // 方案 A：手动拼 patch 栈（等价 composeProfile，profile-boot.ts:142-171），
    // 不装信号处理器 / fail-loud / HMR watcher（比 runProfile 副作用更少）。
    const profile = prepareProfile('web');
    const homePatches = loadOptionalPatches('dsh', homePatchPath()) ?? [];
    const overlays = [
      ...['D:/project-code/llm/sandore/cordis.yml', overlayPath]
        .flatMap(f => loadOverlayPatches('dsh', resolve(f))),
    ];
    const bundlePatches = profile.layers.flatMap(layer => layer.patches);
    const rows = new Map<string, { id?: string; config?: unknown }>();
    for (const row of composeEntries([bundlePatches, profile.patches, homePatches, overlays])) {
      if (typeof row.id === 'string') rows.set(row.id, row);
    }
    // shipped 预设根只补不覆盖（保留 agent-presets 行既有 config，如 default）。
    if (rows.has('agent-presets')) {
      overlays.push({
        id: 'agent-presets',
        config: {
          ...(rows.get('agent-presets')?.config ?? {}) as Record<string, unknown>,
          roots: [{ path: shippedPresetRoot, trust: 'system' }],
        },
      });
    }
    const telemetryPatch = resolveTelemetryPatch(
      process.env.DSH_TELEMETRY_DISABLED,
      rows.has('session-telemetry-otel'),
    );
    const patches = [
      ...bundlePatches,
      ...profile.patches,
      ...homePatches,
      ...overlays,
      ...(telemetryPatch === undefined ? [] : [telemetryPatch]),
    ];
    const bootedCtx = await boot(
      'dsh',
      join(profile.dir, 'cordis.yml'),
      structuredClone(patches),
      (hostCtx) => {
        hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, loadLayeredEnv('dsh'));
        provideCmdline(hostCtx, { args: ['--no-open', '--port', '0'], exit: () => {} });
      },
    );
    bootCtx = bootedCtx;

    // ── 预检：模型密钥可解析 + 模型在 provider 目录中（缺失即明确报错，避免跑
    //   20 分钟后才发现；xiaomi 429 配额耗尽后改用 minimax-cn/minimax-m3，2026-08-25）──
    const resolved = await bootedCtx.credentials.resolve(credentialRef('MINIMAX_CN_API_KEY'));
    if (resolved === undefined) {
      throw new Error(
        'real-e2e 预检失败：credential `MINIMAX_CN_API_KEY` 未解析到值'
        + `（检查 $DSH_HOME/.credentials.yaml：${process.env.DSH_HOME ?? '~/.dsh'}）；`
        + '缺少密钥无法跑真实模型，请配置后重试',
      );
    }
    const llm = (bootedCtx as unknown as { llm?: { listModels(provider: string): Promise<Array<{ id: string }>> } }).llm;
    if (llm !== undefined) {
      try {
        const models = await llm.listModels(MODEL_PROVIDER);
        if (!models.some(m => m.id === MODEL_ID)) {
          throw new Error(
            `real-e2e 预检失败：provider ${MODEL_PROVIDER} 无模型 ${MODEL_ID}`
            + `（可用：${models.map(m => m.id).join(', ') || '(空)'}）`,
          );
        }
      } catch (error) {
        throw new Error(`real-e2e 预检失败：listModels(${MODEL_PROVIDER}) 异常：${String(error)}`);
      }
    }

    // ── 注入工作流定义（fixture YAML → parseWorkflowYaml → definitions.put）──
    const fixtureYaml = await readFile(new URL('../tests/fixtures/test-workflow.yaml', import.meta.url), 'utf8');
    const def = parseWorkflowYaml(fixtureYaml);
    const now = new Date().toISOString();
    await sandoreOf(bootedCtx).sandorePersistence.definitions.put(WORKFLOW_ID, {
      yaml: fixtureYaml,
      name: def.name,
      version: def.version,
      createdAt: now,
      updatedAt: now,
    });

    // ── 预置工作流输入文件（真实 AI 稳定性）──
    // counts.json（times: 0）：sce2「读取出 counts.json 的内容」与「修复问题」step
    // （在 counts.json 维护 times 字段 +1）依赖它；fresh 目录下 AI 需自行创建且
    // primary 门禁校验 outputTo 产物存在——预置后 AI 只需读+改+写，降低失败率。
    await writeFile(join(tmpRoot, 'counts.json'), JSON.stringify({ times: 0 }), 'utf8');

    // ── 事件收集器：注册 sandore/* 全量事件（按 taskId 过滤，存精简载荷 + 实时打印）──
    // 实时日志（用户要求 2026-08-25）：每步事件带时间戳打印，方便调试。
    for (const eventName of SANDBORE_EVENT_NAMES) {
      onSandore(bootedCtx, eventName, (...args: unknown[]) => {
        const slim = toSlimEvent(eventName, args);
        if (slim === undefined) return;
        collectedEvents.push(slim);
        // 实时打印：只打印关键事件（step/phase/end/question/failed），跳过 stage 与低频事件
        const ts = new Date().toISOString().slice(11, 19);
        const loop = slim.loopIteration !== undefined ? ` loop=${JSON.stringify(slim.loopIteration)}` : '';
        const extra = slim.resultStatus !== undefined
          ? ` result=${slim.resultStatus}${slim.resultError !== undefined ? ` error=${slim.resultError.slice(0, 200)}` : ''}`
          : slim.status !== undefined
            ? ` status=${slim.status}`
            : slim.phase !== undefined
              ? ` phase=${slim.phase}`
              : slim.kind !== undefined
                ? ` kind=${slim.kind}${slim.requestId !== undefined ? ` requestId=${slim.requestId}` : ''}`
                : '';
        const stepName = slim.stepId !== undefined ? ` step=${slim.stepId.slice(0, 8)}` : '';
        if (eventName === 'sandore/step-phase' || eventName === 'sandore/question'
          || eventName === 'sandore/end' || eventName === 'sandore/step-start'
          || eventName === 'sandore/step-completed' || eventName === 'sandore/step-failed'
          || eventName === 'sandore/step-retried' || eventName === 'sandore/step-paused'
          || eventName === 'sandore/step-resumed') {
          console.log(`[e2e] ${ts} ${eventName.replace('sandore/', '')}${stepName}${loop}${extra}`);
        }
      });
    }

    bootedCtx.logger.info(
      `real-e2e: boot 完成（tmpRoot=${tmpRoot}），workflow 定义已注入（${WORKFLOW_ID}）`,
    );
  }, BOOT_TIMEOUT_MS);

  it('真实跑 test-workflow 并做结构性不变量断言（§3.6 A~H，26 条）', {
    // 第一轮 RUN_TIMEOUT_MS + 最多 MAX_RETRIES 轮重试（每轮 RETRY_WAIT_MS）+ 余量。
    timeout: RUN_TIMEOUT_MS + 60_000,
  }, async () => {
    const ctx = bootCtx;
    if (ctx === undefined) {
      throw new Error('real-e2e: bootCtx 未初始化（beforeAll 未成功 boot）');
    }
    const engine = sandoreOf(ctx).sandoreEngine;
    const persistence = sandoreOf(ctx).sandorePersistence;

    // ── 挂 sandore/question 自动回答（§3.5：选第一个 option）──
    const answerDisposer = onSandore(ctx, 'sandore/question', (...args: unknown[]) => {
      const info = args[0] as Partial<DagRunInfo> | undefined;
      const entry = args[1] as Partial<PendingQuestionEntry> | undefined;
      if (info === undefined || entry === undefined || entry.requestId === undefined
        || entry.payload === undefined || info.taskId !== instanceId) return;
      const answers = entry.payload.questions.map(q => {
        const first = q.options?.[0];
        return { id: q.id, selected: first === undefined ? [] : [first.label] };
      });
      console.log(`[e2e] ${new Date().toISOString().slice(11, 19)} 收到 question: requestId=${entry.requestId} step=${entry.stepId?.slice(0, 8)} 问题=${entry.payload.questions.map(q => (q.question ?? '').slice(0, 60)).join(' / ')}`);
      console.log(`[e2e] 自动回答: ${JSON.stringify(answers)}`);
      // 竞态修复（real-e2e 诊断 2026-08-24）：emitQuestion 同步触发监听器，若在
      // questionWaiters.set 之前同步调用 replyQuestion → finishQuestion 的 waiter 为
      // undefined（waiter?.resolve 静默跳过）→ ask() 永远挂起 → 子代理卡死（40min
      // 超时）。延迟到微任务（emit 同步栈先完成 → waiter 已注册）再回答。
      void Promise.resolve().then(() =>
        engine.replyQuestion(instanceId, entry.requestId, { answers }),
      ).catch((error: unknown) => {
        ctx.logger.warn(`real-e2e: replyQuestion failed: ${String(error)}`);
      });
    });

    // ── startInstance（fire-and-forget 执行）──
    console.log(`[e2e] startInstance: workflow=${WORKFLOW_ID} model=${MODEL_PROVIDER}/${MODEL_ID} cwd=${tmpRoot}`);
    const runStart = Date.now();
    const run = await engine.startInstance({
      workflowId: WORKFLOW_ID,
      originalInput: '我想开发一个图书管理页面',
      cwd: tmpRoot,
      model: { provider: MODEL_PROVIDER, model: MODEL_ID },
      permission: 'danger-full-access',
    });
    instanceId = run.instanceId;
    console.log(`[e2e] startInstance 返回: instanceId=${instanceId} status=${run.status}（${Date.now() - runStart}ms）`);

    // ── 等待 sandore/end ──
    // 2026-08-25：**去掉自动重试**——retryStep 的 fork/continue 模式与真实 DSH
    // continuation 生命周期不兼容（fork：agents.create 无 continuation 状态；continue：
    // 已 settle 子代理已 dispose），重试链路修复另立任务（见
    // docs/bugfix/bugfix-2026-08-25-retrystep-dsh-continuation.md）。e2e 专注验证引擎
    // 执行正确性；step 失败（门禁 AI 误判 / 模型 429/529）按真实结果判定。
    const endResult = await new Promise<DagResultInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        const dump = dumpSlimState(engine.getInstanceState(instanceId));
        reject(new Error(
          `real-e2e 超时（${RUN_TIMEOUT_MS}ms）：未收到 sandore/end。精简 state dump：\n${dump}`,
        ));
      }, RUN_TIMEOUT_MS);
      const dispose = onSandore(ctx, 'sandore/end', (...args: unknown[]) => {
        const info = args[0] as Partial<DagRunInfo> | undefined;
        const result = args[1] as Partial<DagResultInfo> | undefined;
        if (info === undefined || result === undefined || info.taskId !== instanceId) return;
        clearTimeout(timer);
        dispose();
        resolve(result as DagResultInfo);
      });
    });
    console.log(`[e2e] end: status=${endResult.status}${endResult.error !== undefined ? ` error=${String(endResult.error).slice(0, 300)}` : ''}`);

    // ── 数据源：engine.getInstanceState（实例留 instances 表，终态仍可读）──
    const state = engine.getInstanceState(instanceId);
    if (state === undefined) {
      throw new Error('real-e2e: engine.getInstanceState(instanceId) 返回 undefined（实例不在内存表）');
    }
    const myEvents = collectedEvents.filter(e => e.taskId === instanceId);

    // 断言失败时输出精简 state dump 辅助定位（投影掉大字段）。
    try {
      // ══ A. 终态与生命周期 ══
      // 1. 收到 sandore/end 且 status === 'completed'
      expect(endResult.status, 'sandore/end result.status').toBe('completed');
      // 2. state 终态与身份
      expect(state.status, 'state.status').toBe('completed');
      expect(state.workflowId, 'state.workflowId').toBe(WORKFLOW_ID);
      expect(state.taskId, 'state.taskId').toBe(instanceId);
      // 3. 无残留队列/交互
      expect(state.pendingQueue, 'pendingQueue 应为空').toEqual([]);
      expect(
        state.pendingInteractions.filter(p => p.status === 'pending'),
        'pendingInteractions 无 pending 条目',
      ).toEqual([]);
      // 4. 无孤儿/无悬挂段：段 id 唯一；visitCounts 的 stepId 都在 executedSteps 出现过；终态无 running/interacting 段
      const segIds = state.executedSteps.map(s => s.id);
      expect(new Set(segIds).size, 'executedSteps 段 id 唯一').toBe(segIds.length);
      const executedStepIds = new Set(state.executedSteps.map(s => s.stepId ?? s.id));
      for (const stepId of Object.keys(state.visitCounts)) {
        expect(executedStepIds.has(stepId), `visitCounts 的 stepId ${stepId} 在 executedSteps 出现过`).toBe(true);
      }
      expect(
        state.executedSteps.filter(s => s.status === 'running' || s.status === 'interacting'),
        '终态无 running/interacting 段',
      ).toEqual([]);
      // 5. 循环栈退净
      expect(state.activeLoopIterationStack, 'activeLoopIterationStack 为空').toEqual([]);
      expect(state.activeLoopStack, 'activeLoopStack 为空').toEqual([]);
      expect(state.activeLoopNodeId, 'activeLoopNodeId 为 null').toBeNull();
      // 6. 事件序（按 taskId 过滤）：首 start、末 end、无 aborted、end 恰一次
      expect(myEvents[0]?.eventName, '第一个事件为 sandore/start').toBe('sandore/start');
      expect(myEvents[myEvents.length - 1]?.eventName, '最后一个事件为 sandore/end').toBe('sandore/end');
      expect(myEvents.filter(e => e.eventName === 'sandore/aborted'), '期间无 sandore/aborted').toHaveLength(0);
      expect(myEvents.filter(e => e.eventName === 'sandore/end'), 'sandore/end 恰好一次').toHaveLength(1);

      // ══ B. 每段结构不变量 ══
      // 7. 字段合法：stepId/stageId/name 非空；command.type ∈ {prompt,shell}；childId 为 UUID；synthetic 为 boolean
      for (const seg of state.executedSteps) {
        expect(seg.stepId, `段 ${seg.id} stepId`).toBeTruthy();
        expect(seg.stageId, `段 ${seg.id} stageId`).toBeTruthy();
        expect(seg.name, `段 ${seg.id} name`).toBeTruthy();
        expect(['prompt', 'shell'], `段 ${seg.id} command.type`).toContain(seg.command?.type);
        expect(seg.sessionMeta, `段 ${seg.id} sessionMeta`).toBeDefined();
        expect(seg.sessionMeta?.childId, `段 ${seg.id} childId 为 UUID`).toMatch(UUID_RE);
        expect(typeof seg.sessionMeta?.synthetic, `段 ${seg.id} synthetic 为 boolean`).toBe('boolean');
      }
      // 8. completed 段必有 finalizeMeta：currentPhase='completed'，previousPhase 为合法前一阶段
      for (const seg of state.executedSteps.filter(s => s.status === 'completed')) {
        expect(seg.finalizeMeta, `段 ${seg.id} finalizeMeta`).toBeDefined();
        expect(seg.finalizeMeta?.currentPhase, `段 ${seg.id} currentPhase`).toBe('completed');
        expect(['ask-detect', 'finalizing', 'gating', 'routing'], `段 ${seg.id} previousPhase`).toContain(
          seg.finalizeMeta?.previousPhase,
        );
      }
      // 9. Result 状态：assessResult/gateResult/routingResult 均 done（shell 段无 assessResult）
      for (const seg of state.executedSteps) {
        const fm = seg.finalizeMeta;
        if (seg.sessionMeta?.synthetic === false) {
          expect(fm?.assessResult?.status, `段 ${seg.id} assessResult.status`).toBe('done');
        }
        expect(fm?.gateResult?.status, `段 ${seg.id} gateResult.status`).toBe('done');
        expect(fm?.gateResult?.gatesPassed, `段 ${seg.id} gatesPassed`).toBe(true);
        expect(fm?.gateResult?.primaryPassed, `段 ${seg.id} primaryPassed`).toBe(true);
        if (fm?.routingResult !== undefined) {
          expect(fm.routingResult.status, `段 ${seg.id} routingResult.status`).toBe('done');
        }
      }
      // 10. 门禁配置不变量：sce1 段 secondary.enabled=true；其余段 secondary.enabled=false；全部 primary.enabled=true
      for (const seg of state.executedSteps) {
        const details = seg.finalizeMeta?.gateResult?.gateDetails;
        expect(details, `段 ${seg.id} gateDetails`).toBeDefined();
        expect(details?.primary.enabled, `段 ${seg.id} primary.enabled`).toBe(true);
        if (seg.stepId === SCE1_ID) {
          expect(details?.secondary.enabled, `段 ${seg.id}（sce1）secondary.enabled`).toBe(true);
        } else {
          expect(details?.secondary.enabled, `段 ${seg.id} secondary.enabled`).toBe(false);
        }
      }
      // 11. 步骤类型不变量：parallel1 为 shell 合成会话；prompt 段为真实子代理
      for (const seg of state.executedSteps) {
        if (seg.stepId === PARALLEL1_ID) {
          expect(seg.command?.type, 'parallel1 command.type').toBe('shell');
          expect(seg.sessionMeta?.synthetic, 'parallel1 synthetic').toBe(true);
        } else {
          expect(seg.command?.type, `${seg.stepId} command.type`).toBe('prompt');
          expect(seg.sessionMeta?.synthetic, `${seg.stepId} synthetic`).toBe(false);
        }
      }
      // 12. step-phase 事件合法：phase ∈ 五态且索引非递减；每 stepId 最后 phase 事件为 completed
      const phaseSeqByStep = new Map<string, string[]>();
      for (const ev of myEvents) {
        if (ev.eventName === 'sandore/step-phase' && ev.stepId !== undefined && ev.phase !== undefined) {
          const list = phaseSeqByStep.get(ev.stepId) ?? [];
          list.push(ev.phase);
          phaseSeqByStep.set(ev.stepId, list);
        }
      }
      for (const [stepId, phases] of phaseSeqByStep) {
        const indexes = phases.map(p => PHASE_ORDER.indexOf(p as (typeof PHASE_ORDER)[number]));
        expect(indexes.every(i => i >= 0), `step ${stepId} phase 均为合法值（${phases.join(',')}）`).toBe(true);
        for (let i = 1; i < indexes.length; i += 1) {
          expect(indexes[i]! >= indexes[i - 1]!, `step ${stepId} phase 顺序非递减（${phases.join(',')}）`).toBe(true);
        }
        expect(phases[phases.length - 1], `step ${stepId} 最后 phase 事件`).toBe('completed');
      }

      // ══ C. 循环 / DAG 顺序不变量（核心） ══
      // 13. visitCount 上界（YAML maxIterations 静态推导；终态 visitCounts 可能因循环跳出归零，只取上界）
      const visitMax: Record<string, number> = {
        [SCE1_ID]: 4, // 1 + loop step maxIterations=3 回跳 sce1
        [SCE2_ID]: 4, // 1 + 修复问题 maxIterations=3 回跳 sce2
        [FIX_ID]: 4, // 1 + 同上循环体
        [PARALLEL1_ID]: 1,
        [LOOP_ID]: 1,
      };
      for (const [stepId, max] of Object.entries(visitMax)) {
        const count = state.visitCounts[stepId] ?? 0;
        expect(count, `visitCounts[${stepId}] <= ${max}`).toBeLessThanOrEqual(max);
      }
      // 14. DAG 依赖顺序（inputFrom 边）：sce1 首段 createdAt < parallel1/sce2 首段（parallel1 无条件必跑；
      //     sce2 为条件分支——出现即满足，路径无关）
      const firstCreated = (stepId: string): number => {
        const seg = state.executedSteps.find(s => s.stepId === stepId);
        expect(seg, `step ${stepId} 应有执行段`).toBeDefined();
        return Date.parse(seg!.createdAt ?? '');
      };
      const sce1First = firstCreated(SCE1_ID);
      expect(firstCreated(PARALLEL1_ID), 'parallel1 首段 createdAt 晚于 sce1').toBeGreaterThan(sce1First);
      if (state.executedSteps.some(s => s.stepId === SCE2_ID)) {
        expect(firstCreated(SCE2_ID), 'sce2 首段 createdAt 晚于 sce1').toBeGreaterThan(sce1First);
      }
      // 15. 循环结构（宽松）：第 2 次及以后的段带非空 loopIteration；sce2/修复问题 按 createdAt 交替
      const segmentCountByStep = new Map<string, number>();
      for (const seg of state.executedSteps) {
        segmentCountByStep.set(seg.stepId ?? '', (segmentCountByStep.get(seg.stepId ?? '') ?? 0) + 1);
      }
      for (const [stepId, count] of segmentCountByStep) {
        if (count >= 2) {
          for (const seg of state.executedSteps.filter(s => s.stepId === stepId).slice(1)) {
            expect(seg.loopIteration, `step ${stepId} 第 2+ 段应带 loopIteration`).toBeDefined();
            expect(seg.loopIteration!.length, `step ${stepId} 第 2+ 段 loopIteration 非空`).toBeGreaterThan(0);
          }
        }
      }
      const fixAndSce2 = state.executedSteps
        .filter(s => s.stepId === FIX_ID || s.stepId === SCE2_ID)
        .sort((a, b) => Date.parse(a.createdAt ?? '') - Date.parse(b.createdAt ?? ''));
      for (let i = 1; i < fixAndSce2.length; i += 1) {
        expect(fixAndSce2[i]!.stepId, 'sce2/修复问题 段按 createdAt 交替').not.toBe(fixAndSce2[i - 1]!.stepId);
      }
      // 16. 分支判断产物合法：branchMeta.result / loopMeta.result 可 JSON.parse（含 shouldExecute / shouldBreak）
      for (const seg of state.executedSteps) {
        const rr = seg.finalizeMeta?.routingResult;
        if (rr?.branchMeta !== undefined) {
          expect(rr.branchMeta.status, `段 ${seg.id} branchMeta.status`).toBe('completed');
          const parsed = tryParseJson(rr.branchMeta.result);
          expect(parsed, `段 ${seg.id} branchMeta.result 可解析`).toBeDefined();
          expect('shouldExecute' in (parsed as Record<string, unknown>), `段 ${seg.id} branchMeta 含 shouldExecute`).toBe(true);
        }
        if (rr?.loopMeta !== undefined) {
          expect(rr.loopMeta.status, `段 ${seg.id} loopMeta.status`).toBe('completed');
          const parsed = tryParseJson(rr.loopMeta.result);
          expect(parsed, `段 ${seg.id} loopMeta.result 可解析`).toBeDefined();
          expect('shouldBreak' in (parsed as Record<string, unknown>), `段 ${seg.id} loopMeta 含 shouldBreak`).toBe(true);
        }
      }
      // 17. 不做硬断言：精确路径（先 sce2 还是先 sce3）/ 精确循环次数由 LLM 决定，属允许差异。

      // ══ D. passThroughVars ══
      // 18. change-name 存在且 value 为 string（默认播种 ''）
      const changeNameVar = state.passThroughVars['change-name'];
      expect(changeNameVar, "passThroughVars['change-name'] 存在").toBeDefined();
      expect(typeof changeNameVar?.value, "passThroughVars['change-name'].value 为 string").toBe('string');

      // ══ E. 文件副作用（cwd = tmpRoot） ══
      const countsPath = join(tmpRoot, 'counts.json');
      // 19. counts.json 若存在则必须合法且 times ≥ 1
      if (await statFile(countsPath).then(() => true, () => false)) {
        const parsed = tryParseJson(await readFile(countsPath, 'utf8'));
        expect(parsed, 'counts.json 可 JSON.parse').toBeDefined();
        expect(typeof parsed?.times, 'counts.json times 为 number').toBe('number');
        expect(Number(parsed?.times), 'counts.json times ≥ 1').toBeGreaterThanOrEqual(1);
      }
      // 20. 条件不变量：修复问题 段存在 → counts.json 存在且 times ≥ 1；
      //     change-name 非空 → artifacts/<change-name>/proposal.md 存在；
      //     宽松扫描 artifacts/**/proposal.md（深度 ≤ 2）证明 sce1 outputTo 落盘（仅记录，不硬断言）
      if (state.executedSteps.some(s => s.stepId === FIX_ID)) {
        expect(await statFile(countsPath).then(() => true, () => false), '修复问题 段存在 → counts.json 应存在').toBe(true);
        const parsed = tryParseJson(await readFile(countsPath, 'utf8'));
        expect(Number(parsed?.times), '修复问题 段存在 → counts.json times ≥ 1').toBeGreaterThanOrEqual(1);
      }
      const changeName = changeNameVar?.value;
      if (typeof changeName === 'string' && changeName !== '') {
        const proposalPath = join(tmpRoot, 'artifacts', changeName, 'proposal.md');
        expect(
          await statFile(proposalPath).then(() => true, () => false),
          `artifacts/${changeName}/proposal.md 应存在`,
        ).toBe(true);
      }
      const foundProposal = await findFile(tmpRoot, 'artifacts', 'proposal.md', 2);
      ctx.logger.info(`real-e2e: artifacts/**/proposal.md 扫描结果 = ${foundProposal ?? '(未找到)'}`);

      // ══ F. 事件-状态对账（「无遗漏、准确」核心） ══
      // 21. 按 (stepId, loopIteration) 分组：段数 === (step-start + step-retried) 事件数
      //     （重试段不发 step-start、发 step-retried，见 recovery-manager.retryStep）
      //     === step-completed 事件数（重试成功后该组最终 completed 段）
      const segmentGroups = new Map<string, number>();
      for (const seg of state.executedSteps) {
        const key = groupKey(seg.stepId, seg.loopIteration);
        segmentGroups.set(key, (segmentGroups.get(key) ?? 0) + 1);
      }
      const startGroups = new Map<string, number>();
      const retriedGroups = new Map<string, number>();
      const completedGroups = new Map<string, number>();
      for (const ev of myEvents) {
        const key = ev.stepId === undefined ? undefined : groupKey(ev.stepId, ev.loopIteration);
        if (key === undefined) continue;
        if (ev.eventName === 'sandore/step-start') {
          startGroups.set(key, (startGroups.get(key) ?? 0) + 1);
        } else if (ev.eventName === 'sandore/step-retried') {
          retriedGroups.set(key, (retriedGroups.get(key) ?? 0) + 1);
        } else if (ev.eventName === 'sandore/step-completed') {
          completedGroups.set(key, (completedGroups.get(key) ?? 0) + 1);
        }
      }
      expect(segmentGroups.size, '至少一个 (stepId, loopIteration) 分组').toBeGreaterThan(0);
      for (const [key, count] of segmentGroups) {
        const startCount = startGroups.get(key) ?? 0;
        const retriedCount = retriedGroups.get(key) ?? 0;
        expect(startCount + retriedCount, `step-start+step-retried 事件数（group ${key}）`).toBe(count);
        // completed 事件数：段含 failed 历史段（重试前）时该组 completed 事件 = completed 段数
        const completedSegments = state.executedSteps.filter(
          s => groupKey(s.stepId, s.loopIteration) === key && s.status === 'completed',
        ).length;
        expect(completedGroups.get(key) ?? 0, `step-completed 事件数（group ${key}）`).toBe(completedSegments);
      }
      // 22. failed 段对账：每个 failed 段须有同 stepId 的 step-failed 事件；存在 failed
      //     段（无自动重试——2026-08-25 起去掉，见 22b 注释）→ end.status 应为 failed。
      const failedSegments = state.executedSteps.filter(s => s.status === 'failed');
      if (failedSegments.length > 0) {
        const failedStepIds = new Set(failedSegments.map(s => s.stepId ?? s.id));
        const stepFailedCount = myEvents.filter(e => e.eventName === 'sandore/step-failed' && failedStepIds.has(e.stepId ?? ''))
          .length;
        expect(stepFailedCount, 'failed 段须有对应 sandore/step-failed 事件').toBeGreaterThanOrEqual(failedSegments.length);
        expect(endResult.status, '存在 failed 段 → end.status 应为 failed').toBe('failed');
      }
      // 22b. 自动重试已移除（2026-08-25）：retryStep fork/continue 模式与真实 DSH
      //      continuation 生命周期不兼容，修复另立任务（docs/bugfix/bugfix-2026-08-25-retrystep-dsh-continuation.md）。
      //      断言保留「无重试事件」：任何 step-retried 出现即视为意外（重试链路未启用）。
      expect(
        myEvents.filter(e => e.eventName === 'sandore/step-retried'),
        '无自动重试 → 不应出现 step-retried 事件',
      ).toHaveLength(0);
      // 23. stage 对账：stage-start/stage-completed 各恰 2 次，顺序 start(demo1) → completed(demo1) → start(demo2) → completed(demo2)
      expect(myEvents.filter(e => e.eventName === 'sandore/stage-start'), 'stage-start 恰 2 次').toHaveLength(2);
      expect(myEvents.filter(e => e.eventName === 'sandore/stage-completed'), 'stage-completed 恰 2 次').toHaveLength(2);
      expect(
        myEvents
          .filter(e => e.eventName === 'sandore/stage-start' || e.eventName === 'sandore/stage-completed')
          .map(e => `${e.eventName}:${e.stageId ?? ''}`),
        'stage 事件顺序',
      ).toEqual([
        `sandore/stage-start:${DEMO1_ID}`,
        `sandore/stage-completed:${DEMO1_ID}`,
        `sandore/stage-start:${DEMO2_ID}`,
        `sandore/stage-completed:${DEMO2_ID}`,
      ]);

      // ══ G. ask 闭环 ══
      // 24. 至少一次 sandore/question；entry kind='question'、requestId 为 UUID、payload.questions 非空；
      //     终态 pendingInteractions 无该 requestId 的 pending 条目
      const questionEvents = myEvents.filter(e => e.eventName === 'sandore/question');
      expect(questionEvents.length, '至少收到一次 sandore/question').toBeGreaterThanOrEqual(1);
      for (const ev of questionEvents) {
        expect(ev.kind, 'question entry kind').toBe('question');
        expect(ev.requestId, 'question requestId 为 UUID').toMatch(UUID_RE);
        expect(ev.questionCount ?? 0, 'question payload.questions 非空').toBeGreaterThanOrEqual(1);
      }
      const pendingStatusByRequestId = new Map(
        state.pendingInteractions.map(p => [p.requestId, p.status] as const),
      );
      for (const ev of questionEvents) {
        const status = ev.requestId !== undefined ? pendingStatusByRequestId.get(ev.requestId) : undefined;
        expect(status, `requestId ${ev.requestId ?? ''} 不应仍 pending`).not.toBe('pending');
      }
      // 25. 回答后工作流能继续推进（能走到 sandore/end 即证明闭环有效）
      expect(questionEvents.length, '发生过问答（闭环入口）').toBeGreaterThanOrEqual(1);
      expect(endResult.status, '问答后实例最终 completed（闭环出口）').toBe('completed');

      // ══ H. 模型真实调用证据（软断言，记日志不 fail） ══
      // 26. prompt 段 childId 对应真实注册过的子代理（终态可能已 dispose，仅记录）；output 非空
      const agentsRegistry = (ctx as unknown as { agents: { get(id: string): unknown } }).agents;
      for (const seg of state.executedSteps) {
        if (seg.sessionMeta?.synthetic !== false) continue;
        const childId = seg.sessionMeta.childId;
        if (agentsRegistry.get(childId) === undefined) {
          ctx.logger.warn(`real-e2e: prompt 段 ${seg.stepId} childId ${childId} 不在 agents 注册表（终态可能已 dispose，软断言仅记录）`);
        } else {
          ctx.logger.info(`real-e2e: prompt 段 ${seg.stepId} childId ${childId} 曾注册真实子代理`);
        }
        if ((seg.output ?? []).length === 0) {
          ctx.logger.warn(`real-e2e: prompt 段 ${seg.stepId} output 为空（软断言仅记录）`);
        }
      }

      // 收尾：确认 state 表已持久化终态（与内存 state 一致）
      const persisted = persistence.state.get(instanceId);
      expect(persisted?.status, '持久化 state.status 亦为 completed').toBe('completed');
    } catch (error) {
      console.error(`[real-e2e] 断言失败（instanceId=${instanceId}）：`);
      if (error instanceof Error) {
        console.error(`[real-e2e] 错误信息: ${error.message}`);
        console.error(`[real-e2e] 完整堆栈: ${error.stack ?? '(无堆栈)'}`);
      } else {
        console.error(`[real-e2e] 未知错误: ${String(error)}`);
      }
      console.error(`[real-e2e] 精简 state dump：\n${dumpSlimState(engine.getInstanceState(instanceId))}`);
      throw error;
    } finally {
      answerDisposer();
    }
  });

  afterAll(async () => {
    // 先 dispose 整棵树（webserver 关端口、watcher/订阅清理），再删临时目录（Windows sqlite 句柄顺序）。
    if (bootCtx !== undefined) {
      try {
        await bootCtx.fiber.dispose();
      } catch (error) {
        console.error('[real-e2e] ctx.fiber.dispose() failed:', error);
      }
      bootCtx = undefined;
    }
    if (tmpRoot !== '') {
      try {
        await rm(tmpRoot, { recursive: true, force: true });
      } catch (error) {
        console.error('[real-e2e] 清理临时目录失败:', error);
      }
    }
  }, 120_000);
});
