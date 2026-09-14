/**
 * 真实 e2e probe（诊断）：StepChatPanel 内嵌子代理面板的数据通路事实核查。
 *
 * 背景：用户报「创建工作流实例后，step 下一直显示『正在加载子代理会话…』」。
 * 静态分析结论（待本 probe 用真实环境证实/证伪）：
 * 1. rc.1 宿主 session-controller（api/session-controller/src/history.ts `validateAddress`）
 *    对 **plain session 地址**（kind:'session'）打开任何 header.origin==='subagent'
 *    的会话**无条件**抛 `session/agent-busy`（'subagent Sessions require their durable
 *    parent address'）——不是瞬态门控；正确打开须用 **subagent-kind 地址**
 *    （{kind:'subagent', parentSessionId, childSessionId, mode}）。
 * 2. sandore StepChatPanel 经 `sessions.binding(childId).session.open()` 打开子代理会话
 *    时，绑定得到的 Session 实例通常不带 subagent address（address 只在被 select/
 *    selectSubagent 过、或 restore 过时才有）→ 走 plain history → 恒被拒 → 面板
 *    永远停在 error（我们现渲染成 loading「正在加载子代理会话…」）。
 *
 * 本 probe 在进程内真实 DSH harness（真 web profile + sandore 静态组合 + 真实 LLM）
 * 里跑一个最小单 prompt-step 工作流，对产生的**真实子代理会话**：
 * - 运行中 / settle 后各做一次：plain 地址 follow 与 subagent 地址 follow
 *   （mode 依次尝试 continuable / one-shot），记录结果码；
 * - 若 subagent 地址在某形态下返回 ok，断言其 opening 帧 records 里含真实
 *   user/assistant 消息（「真实的最新消息」证据）。
 *
 * gate：`SANDBORE_E2E_REAL=1` 才跑（与 workflow-engine-real-e2e.spec.ts 同门控），
 * 默认 skip 不进 `pnpm test`。DSH 根默认 `D:/project-code/llm/deepseek-harness`，
 * 可用环境变量 `SANDBORE_E2E_DSH_ROOT` 覆盖（仓库内动态 import 用绝对 file URL，
 * 避免原 spec 的 '../..' 相对深度在不同 clone 位置失效）。
 *
 * 运行（PowerShell）：
 * ```powershell
 * $env:SANDBORE_E2E_REAL='1'
 * pnpm exec vitest run packages/workflow/stepchat-open-real-probe.spec.ts --no-file-parallelism
 * ```
 * @module @meiyukichan/dsh-sandore/workflow/src/stepchat-open-real-probe
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SandoreEngine } from './seam.ts';
import type { DagRunInfo, DagResultInfo, PendingQuestionEntry, WorkflowTaskState } from './types.ts';
import { parseWorkflowYaml } from './yaml-parser.ts';

// ── gate ────────────────────────────────────────────────────────────────────

/** 真实 e2e 开关（与 real-e2e 同款）。 */
const REAL_E2E = process.env.SANDBORE_E2E_REAL === '1';
const describeReal = REAL_E2E ? describe : describe.skip;

/** 超时：整体 12min（单 prompt step 真实 LLM 一轮 + 收尾门禁，留足余量）。 */
const RUN_TIMEOUT_MS = 12 * 60_000;
const BOOT_TIMEOUT_MS = 180_000;

/** DSH 源码根（sandore 为同级目录时的默认值；可用 env 覆盖）。 */
const DSH_ROOT = process.env.SANDBORE_E2E_DSH_ROOT ?? 'D:/project-code/llm/deepseek-harness';
const dsh = (rel: string): string => `file:///${resolve(DSH_ROOT, rel).replaceAll('\\', '/')}`;

/** 真实模型路由（沿用 real-e2e：minimax-cn/MiniMax-M3）。 */
const MODEL_PROVIDER = 'minimax-cn';
const MODEL_ID = 'MiniMax-M3';

/** probe 用最小工作流（固定 id/step id：shell 探针 + 单真实 prompt step）。 */
const WORKFLOW_ID = 'wfl-probe-2026-09-09';
const STEP_SHELL_ID = 'step-probe-shell';
const STEP_ID = 'step-probe-sce1';
const STAGE_ID = 'stg-probe-main';

const PROBE_YAML = `id: ${WORKFLOW_ID}
name: probe-minimal
version: 1.0.0
skills: []
mcps: []
agents: []
settings:
  defaultTimeout: 120
  maxConcurrentAgents: 2
gates:
  primary:
    enabled: true
stages:
  - id: ${STAGE_ID}
    name: main
    steps:
      - id: ${STEP_SHELL_ID}
      - id: ${STEP_ID}
steps:
  - id: ${STEP_SHELL_ID}
    name: probe-shell
    command:
      type: shell
      value:
        command: echo shell-ok
  - id: ${STEP_ID}
    name: probe1
    command:
      type: prompt
      value:
        promptText: 只回复一行字：miku probe ok。不要调用任何工具。
`;
/** shell 探针 step（2026-09-09 契约：shell 不建子代理 → 无 childId）。 */

// 类型桥（同 real-e2e 结构断言方式）。静态字面量 import type 仅类型面（运行时擦除、
// 不解析文件；真实动态 import 见 beforeAll 的 dsh() file URL）。
type BootCtx = Awaited<ReturnType<
  typeof import('../../../../deepseek-harness/packages/boot/app-boot/src/index.ts')['boot']
>>;

interface SandoreView {
  sandoreEngine: SandoreEngine;
}

function sandoreOf(ctx: BootCtx): SandoreView {
  return ctx as unknown as SandoreView;
}

function onSandore(ctx: BootCtx, event: string, listener: (...args: unknown[]) => void): () => void {
  return (ctx.on as unknown as (name: string, cb: (...args: unknown[]) => void) => () => void)(event, listener);
}

/** probe 结果（一次 follow 尝试）。 */
interface ProbeResult {
  phase: 'running' | 'settled';
  addressKind: 'plain' | 'subagent-continuable' | 'subagent-one-shot';
  outcome: 'ok' | string; // ok=成功；否则错误 code/message 摘要
  records: number;
  messageCount: number;
  sample: string[];
}

describeReal('sandore StepChatPanel 数据通路真实 probe（真 harness + 真 LLM）', () => {
  let bootCtx: BootCtx | undefined;
  let tmpRoot = '';
  let instanceId = '';
  let childId = '';
  let stepPhase: 'none' | 'running' | 'settled' | 'failed' = 'none';
  const probes: ProbeResult[] = [];
  /** step-start 事件里的 childId（按 stepId 记；2026-09-09 契约断言：shell=undefined、真实=真实 id）。 */
  const stepStartChildIds: Record<string, string | undefined> = {};

  /** 对 childId 做一次 follow 尝试（address 形态可配）。 */
  async function tryFollow(
    ctx: BootCtx,
    phase: ProbeResult['phase'],
    kind: ProbeResult['addressKind'],
  ): Promise<ProbeResult> {
    const controller = (ctx as unknown as { sessionController?: { follow(request: unknown, signal: AbortSignal): unknown } }).sessionController;
    if (controller === undefined || typeof (controller as { follow?: unknown }).follow !== 'function') {
      return { phase, addressKind: kind, outcome: 'no-sessionController-service', records: 0, messageCount: 0, sample: [] };
    }
    let address: Record<string, string>;
    if (kind === 'plain') {
      address = { kind: 'session', sessionId: childId };
    } else {
      // 父会话与 mode：从 Session 对象/header 反查（见 runBody 内的解析结果）。
      const header = (await sessionHeaderOf(ctx)) ?? {};
      const parent = header.parentSessionId ?? header.parentSession;
      const mode = kind === 'subagent-continuable' ? 'continuable' : 'one-shot';
      if (typeof parent !== 'string') {
        return { phase, addressKind: kind, outcome: `no-parent-session (header=${JSON.stringify(header)})`, records: 0, messageCount: 0, sample: [] };
      }
      address = { kind: 'subagent', parentSessionId: parent, childSessionId: childId, mode };
    }
    const signal = new AbortController().signal;
    try {
      const iterable = await controller.follow({ address, maxMessages: 50 }, signal);
      const frames = await readFirstFrame(iterable);
      const records = (frames as { records?: unknown[] } | undefined)?.records ?? [];
      const texts: string[] = [];
      for (const record of records as Array<{ event?: { type?: string; data?: { content?: unknown } } }>) {
        const ev = record.event;
        if (ev?.type === 'user/message' || ev?.type === 'assistant/message') {
          const content = ev.data?.content;
          const text = Array.isArray(content)
            ? content.map((b: { type?: string; text?: string }) => (b?.type === 'text' ? b.text ?? '' : '')).join('')
            : '';
          if (text !== '') texts.push(`${ev.type}: ${text.slice(0, 60)}`);
        }
      }
      return { phase, addressKind: kind, outcome: 'ok', records: records.length, messageCount: texts.length, sample: texts.slice(0, 4) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as { code?: string } | undefined)?.code;
      return { phase, addressKind: kind, outcome: code === undefined ? message : `${code}: ${message.slice(0, 160)}`, records: 0, messageCount: 0, sample: [] };
    }
  }

  /** 读 follow async iterable 的第一帧（opening snapshot）后即中止。 */
  async function readFirstFrame(iterable: unknown): Promise<unknown> {
    const iterator = (iterable as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    try {
      const first = await iterator.next();
      return first.done ? undefined : first.value;
    } finally {
      await iterator.return?.();
    }
  }

  /** 从可用的宿主服务解析子代理会话 header（尽力而为，缺服务返回 undefined）。 */
  async function sessionHeaderOf(ctx: BootCtx): Promise<{ parentSessionId?: string; origin?: string } | undefined> {
    const candidates: Array<{ label: string; value: unknown }> = [];
    // (a) ctx.sessions.get(childId) —— dsh Session（header 字段名可能不同，同时抓 keys）。
    try {
      const manager = (ctx as unknown as { sessions?: { get(id: unknown): unknown } }).sessions;
      const session = manager?.get?.(childId as never) as
        | { header?: unknown; snapshotEvents?(): unknown[]; id?: unknown }
        | undefined;
      if (session !== undefined) {
        candidates.push({ label: 'sessions.get.header', value: session.header });
        const keys = Object.keys(session as object);
        candidates.push({ label: `sessions.get.keys(${keys.length})`, value: keys.slice(0, 24) });
        if (typeof session.id === 'string') candidates.push({ label: 'sessions.get.id', value: session.id });
      } else {
        candidates.push({ label: 'sessions.get', value: '(undefined)' });
      }
    } catch (error) {
      candidates.push({ label: 'sessions.get', value: `error: ${String(error).slice(0, 120)}` });
    }
    // (b) ctx.agents.get(childId) —— 活 agent（session/header 或 parent 面）。
    try {
      const agents = (ctx as unknown as { agents?: { get(id: unknown): unknown } }).agents;
      const agent = agents?.get?.(childId as never) as Record<string, unknown> | undefined;
      if (agent !== undefined) {
        candidates.push({ label: 'agents.get', value: Object.fromEntries(
          Object.entries(agent).filter(([k]) => /header|session|parent|id|mode/i.test(k)).slice(0, 10),
        ) });
      } else {
        candidates.push({ label: 'agents.get', value: '(undefined)' });
      }
    } catch (error) {
      candidates.push({ label: 'agents.get', value: `error: ${String(error).slice(0, 120)}` });
    }
    // (c) persistence inspect。
    try {
      const persistence = (ctx as unknown as { sessionPersistence?: { inspect(id: string): Promise<unknown> } }).sessionPersistence;
      if (persistence?.inspect !== undefined) {
        const inspected = await persistence.inspect(childId);
        candidates.push({ label: 'sessionPersistence.inspect', value: inspected });
      }
    } catch (error) {
      candidates.push({ label: 'sessionPersistence.inspect', value: `error: ${String(error).slice(0, 120)}` });
    }
    // 找第一个含 parentSessionId/origin 的对象（递归浅扫两层）。
    for (const c of candidates) {
      const found = shallowFindParent(c.value);
      if (found !== undefined) return found;
    }
    // 记录辅助信息到全局日志（无 parent 时也要能看到）。
    console.log('[probe] header 解析候选：' + JSON.stringify(candidates.map(c => ({ label: c.label, value: summarize(c.value) }))));
    return undefined;
  }

  function shallowFindParent(value: unknown): { parentSessionId?: string; origin?: string } | undefined {
    const walk = (v: unknown, depth: number): { parentSessionId?: string; origin?: string } | undefined => {
      if (v === null || typeof v !== 'object' || depth > 2) return undefined;
      const record = v as Record<string, unknown>;
      if (typeof record.parentSessionId === 'string' || typeof record.parentSession === 'string') {
        return {
          parentSessionId: (record.parentSessionId as string | undefined) ?? (record.parentSession as string | undefined),
          origin: typeof record.origin === 'string' ? (record.origin as string) : undefined,
        };
      }
      for (const value of Object.values(record)) {
        const found = walk(value, depth + 1);
        if (found !== undefined) return found;
      }
      return undefined;
    };
    return walk(value, 0);
  }

  function summarize(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length <= 8) return record;
    return `{${keys.slice(0, 8).join(', ')}, ...(${keys.length} keys)}`;
  }

  beforeAll(async () => {
    process.env.DSH_PERMISSION_MODE = 'danger-full-access';
    process.env.DSH_TELEMETRY_DISABLED = '1';

    const { boot, composeEntries, loadLayeredEnv, loadOptionalPatches, loadOverlayPatches } = await import(dsh('packages/boot/app-boot/src/index.ts'));
    const { provideCmdline } = await import(dsh('packages/boot/cmdline/src/index.ts'));
    const { DSH_LAUNCH_ENVIRONMENT_KEY } = await import(dsh('packages/util/launch-environment/src/index.ts'));
    const { prepareProfile, homePatchPath, resolveTelemetryPatch } = await import(dsh('apps/cli/src/profile-boot.ts'));
    const { credentialRef } = await import(dsh('packages/credentials/credentials/src/index.ts'));
    const shippedPresetRoot = fileURLToPath(new URL(dsh('apps/cli/config/agent-presets/')));

    tmpRoot = join(process.cwd(), 'log', 'e2e', randomUUID());
    await mkdir(tmpRoot, { recursive: true });
    const overlayYaml = [
      '# sandore probe overlay：隔离存储',
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
    const overlayPath = join(tmpRoot, 'overlay.yml');
    await writeFile(overlayPath, overlayYaml, 'utf8');

    const profile = prepareProfile('web');
    const homePatches = loadOptionalPatches('dsh', homePatchPath()) ?? [];
    // 只加隔离存储 overlay：sandore 插件行由 profile bundles 提供（2026 实装核查：
    // web profile bundles 已含 sandore；再叠 cordis.yml 的 sandore insert 会
    // duplicate loader entry id: sandore）。
    const overlays = [
      ...loadOverlayPatches('dsh', resolve(overlayPath)),
    ];
    const bundlePatches = profile.layers.flatMap(layer => layer.patches);
    const rows = new Map<string, { id?: string; config?: unknown }>();
    for (const row of composeEntries([bundlePatches, profile.patches, homePatches, overlays])) {
      if (typeof row.id === 'string') rows.set(row.id, row);
    }
    if (rows.has('agent-presets')) {
      overlays.push({
        id: 'agent-presets',
        config: {
          ...(rows.get('agent-presets')?.config ?? {}) as Record<string, unknown>,
          roots: [{ path: shippedPresetRoot, trust: 'system' }],
        },
      });
    }
    const telemetryPatch = resolveTelemetryPatch(process.env.DSH_TELEMETRY_DISABLED, rows.has('session-telemetry-otel'));
    const patches = [
      ...bundlePatches,
      ...profile.patches,
      ...homePatches,
      ...overlays,
      ...(telemetryPatch === undefined ? [] : [telemetryPatch]),
    ];
    console.log('[probe] patches=' + patches.length + '（sandore 行来自 profile bundles: '
      + JSON.stringify(patches.filter(p => p?.id === 'sandore').map(p => p?.config ?? null)) + '）');
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
    // 诊断：boot 返回的 ctx 实际成员（插件树是否真的挂载）。
    try {
      const keys = Object.keys(bootedCtx as unknown as Record<string, unknown>);
      console.log(`[probe] bootCtx keys(${keys.length}): ${keys.slice(0, 60).join(', ')}`);
    } catch (error) {
      console.log(`[probe] bootCtx keys 枚举异常: ${String(error).slice(0, 200)}`);
    }
    const loaded = (bootedCtx as unknown as { _loaded?: unknown });
    if (loaded._loaded !== undefined) {
      console.log(`[probe] ctx._loaded keys: ${JSON.stringify(Object.keys(loaded._loaded as object).slice(0, 40))}`);
    }

    // 就绪轮询：插件树应用可能异步完成（loader/async import），等核心服务出现
    // （credentials/llm/sessions 任一）或超时（30s）再继续。
    const readyAt = Date.now();
    for (;;) {
      const any = (bootedCtx as unknown as Record<string, unknown>);
      if (any.credentials !== undefined || any.llm !== undefined || any.sessions !== undefined) break;
      if (Date.now() - readyAt > 30_000) {
        console.warn('[probe] 等待 30s 后核心服务仍未出现（插件树可能加载失败）；继续并记录证据');
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    // 软预检：登记/llm/sessions/sessionController 服务可用性 + 模型凭据（缺失只记录，
    // 后续真实执行/探测的报错会给出证据；真 harness 的插件组合可能缺若干宿主行）。
    const probeService = (name: string): string => {
      try {
        const value = (bootedCtx as unknown as Record<string, unknown>)[name];
        return value === undefined ? 'missing' : typeof value;
      } catch {
        return 'error';
      }
    };
    for (const name of ['credentials', 'llm', 'sessions', 'sessionController', 'agents', 'sessionPersistence']) {
      console.log(`[probe] ctx.${name} = ${probeService(name)}`);
    }
    try {
      const resolved = await bootedCtx.credentials.resolve(credentialRef('MINIMAX_CN_API_KEY'));
      console.log(`[probe] MINIMAX_CN_API_KEY resolved=${resolved === undefined ? 'NO' : 'yes'}`);
    } catch (error) {
      console.log(`[probe] credentials.resolve 异常（继续）：${String(error).slice(0, 160)}`);
    }
    const llm = (bootedCtx as unknown as { llm?: { listModels(provider: string): Promise<Array<{ id: string }>> } }).llm;
    if (llm !== undefined) {
      try {
        const models = await llm.listModels(MODEL_PROVIDER);
        console.log(`[probe] listModels(${MODEL_PROVIDER}) = ${models.map(m => m.id).join(', ') || '(空)'}`);
        if (!models.some(m => m.id === MODEL_ID)) {
          console.log(`[probe] 模型 ${MODEL_ID} 不在 provider 目录（可能换用其它模型）`);
        }
      } catch (error) {
        console.log(`[probe] listModels 异常（继续）：${String(error).slice(0, 160)}`);
      }
    }

    // 注入最小工作流定义。
    const def = parseWorkflowYaml(PROBE_YAML);
    const now = new Date().toISOString();
    await sandoreOf(bootedCtx).sandorePersistence.definitions.put(WORKFLOW_ID, {
      yaml: PROBE_YAML,
      name: def.name,
      version: def.version,
      createdAt: now,
      updatedAt: now,
    });

    console.log(`[probe] boot 完成（tmpRoot=${tmpRoot}），最小工作流已注入 ${WORKFLOW_ID}`);
  }, BOOT_TIMEOUT_MS);

  it('真实跑最小工作流，运行中/settle 后对子代理会话做 plain vs subagent 地址 follow probe', {
    timeout: RUN_TIMEOUT_MS + 60_000,
  }, async () => {
    const ctx = bootCtx;
    if (ctx === undefined) throw new Error('probe: bootCtx 未初始化');

    const engine = sandoreOf(ctx).sandoreEngine;

    // 自动回答 question（避免 ask 卡住实例）。
    const answerDisposer = onSandore(ctx, 'sandore/question', (...args: unknown[]) => {
      const info = args[0] as Partial<DagRunInfo> | undefined;
      const entry = args[1] as Partial<PendingQuestionEntry> | undefined;
      if (info === undefined || entry === undefined || entry.requestId === undefined
        || entry.payload === undefined || info.taskId !== instanceId) return;
      const answers = entry.payload.questions.map(q => {
        const first = q.options?.[0];
        return { id: q.id, selected: first === undefined ? [] : [first.label] };
      });
      void Promise.resolve().then(() => engine.replyQuestion(instanceId, entry.requestId, { answers }))
        .catch((error: unknown) => ctx.logger.warn(`probe: replyQuestion failed: ${String(error)}`));
    });
    const disposers: Array<() => void> = [answerDisposer];
    for (const name of ['sandore/step-start', 'sandore/step-completed', 'sandore/step-failed'] as const) {
      disposers.push(onSandore(ctx, name, (...args: unknown[]) => {
        const info = args[0] as Partial<DagRunInfo> | undefined;
        if (info === undefined || info.taskId !== instanceId) return;
        const stepId = args[1];
        if (typeof stepId === 'string' && name === 'sandore/step-start') {
          stepStartChildIds[stepId] = args[2] === undefined ? undefined : String(args[2]);
        }
        console.log(`[probe] ${name} stepId=${String(stepId ?? '').slice(0, 24)} childId=${args[2] ?? '(无)'}`);
      }));
    }

    // 启动实例。
    const run = await engine.startInstance({
      workflowId: WORKFLOW_ID,
      originalInput: 'probe run',
      cwd: tmpRoot,
      model: { provider: MODEL_PROVIDER, model: MODEL_ID },
      permission: 'danger-full-access',
    });
    instanceId = run.instanceId;
    console.log(`[probe] startInstance: instanceId=${instanceId} status=${run.status}`);

    // 尽早挂 end 捕获（引擎可能在 probe 期间完成实例，晚挂会错过 sandore/end）。
    let endResultValue: DagResultInfo | undefined;
    const endPromise = new Promise<DagResultInfo>((resolveEnd, rejectEnd) => {
      const timer = setTimeout(() => {
        const state = engine.getInstanceState(instanceId);
        rejectEnd(new Error(`probe 超时：未收到 sandore/end。state.status=${state?.status ?? 'undefined'}`));
      }, RUN_TIMEOUT_MS);
      const dispose = onSandore(ctx, 'sandore/end', (...args: unknown[]) => {
        const info = args[0] as Partial<DagRunInfo> | undefined;
        const result = args[1] as Partial<DagResultInfo> | undefined;
        if (info === undefined || result === undefined || info.taskId !== instanceId) return;
        clearTimeout(timer);
        dispose();
        endResultValue = result as DagResultInfo;
        resolveEnd(result as DagResultInfo);
      });
    });

    /** 从引擎 state 找真实子代理段（running/interacting 且 synthetic=false）的 childId。 */
    const waitForRealChild = async (): Promise<string> => {
      const deadline = Date.now() + RUN_TIMEOUT_MS;
      for (;;) {
        const state = engine.getInstanceState(instanceId);
        const seg = state?.executedSteps.find(s => {
          const runningNow = s.status === 'running' || s.status === 'interacting';
          return runningNow && s.sessionMeta?.synthetic === false && typeof s.sessionMeta?.childId === 'string';
        });
        if (seg !== undefined) return seg.sessionMeta!.childId!;
        // 也可能 step 已完成（太快）：取 completed 的真实段。
        const done = state?.executedSteps.find(s => s.status === 'completed' && s.sessionMeta?.synthetic === false
          && typeof s.sessionMeta?.childId === 'string');
        if (done !== undefined) return done.sessionMeta!.childId!;
        if (Date.now() > deadline) throw new Error('probe 超时：未等到真实子代理段（engine state 无 running/completed 真实段）');
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    };

    // 等真实 childId（synthetic 占位不可 open；真实会话由 startContinuable 发布）。
    childId = await waitForRealChild();
    console.log(`[probe] 真实子代理 childId=${childId}`);
    const metaNow = engine.getInstanceState(instanceId)?.executedSteps
      .find(s => s.sessionMeta?.synthetic === false)?.sessionMeta;
    console.log(`[probe] running 段 meta=${JSON.stringify(metaNow)}`);

    // 运行中 probe：等 1.5s（让 turn 展开）后采样；若已 settle 则跳过并注明。
    await new Promise(resolve => setTimeout(resolve, 1500));
    const stillRunning = engine.getInstanceState(instanceId)?.executedSteps.some(s =>
      (s.status === 'running' || s.status === 'interacting') && s.sessionMeta?.synthetic === false);
    if (stillRunning === true) {
      console.log('[probe] === 运行中（turn 未 settle）probe ===');
      probes.push(await tryFollow(ctx, 'running', 'plain'));
      probes.push(await tryFollow(ctx, 'running', 'subagent-continuable'));
      probes.push(await tryFollow(ctx, 'running', 'subagent-one-shot'));
    } else {
      console.log('[probe] 采样时 step 已 settle，跳过运行中 probe');
    }

    // 等真实段 settle（completed/failed）。
    const settleDeadline = Date.now() + RUN_TIMEOUT_MS;
    for (;;) {
      const state = engine.getInstanceState(instanceId);
      const real = state?.executedSteps.find(s => s.sessionMeta?.synthetic === false
        && (s.status === 'completed' || s.status === 'failed'));
      if (real !== undefined) {
        stepPhase = real.status === 'completed' ? 'settled' : 'failed';
        childId = real.sessionMeta!.childId!;
        break;
      }
      if (Date.now() > settleDeadline) throw new Error('probe 超时：真实子代理段未 settle');
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    console.log(`[probe] settle：childId=${childId} phase=${stepPhase}`);
    const metaSettled = engine.getInstanceState(instanceId)?.executedSteps
      .find(s => s.sessionMeta?.synthetic === false)?.sessionMeta;
    console.log(`[probe] settled 段 meta=${JSON.stringify(metaSettled)}`);

    console.log('[probe] === settle 后 probe ===');
    probes.push(await tryFollow(ctx, 'settled', 'plain'));
    probes.push(await tryFollow(ctx, 'settled', 'subagent-continuable'));
    probes.push(await tryFollow(ctx, 'settled', 'subagent-one-shot'));

    // 等实例 end（引擎收尾），之后 state 完整。
    const endResult = await endPromise;

    // ── 汇总与断言 ──
    console.log('[probe] step-start childId 映射：' + JSON.stringify(stepStartChildIds));
    // 2026-09-09 契约断言：
    // A. step-start 载荷：shell 步骤无 childId（undefined）；prompt 步骤 = 真实会话 id
    //    （引擎先 launchSubagent 拿到真实 childId 才发 step-start，无合成占位）。
    expect(stepStartChildIds[STEP_SHELL_ID], 'shell step-start 无 childId').toBeUndefined();
    expect(stepStartChildIds[STEP_ID], 'prompt step-start childId 为真实 id').toBe(childId);
    // B. 持久化段：shell 段 sessionMeta 无 childId + synthetic:true；prompt 段 childId=真实 id + synthetic:false。
    const stateFinal = engine.getInstanceState(instanceId);
    const shellSeg = stateFinal?.executedSteps.find(s => s.stepId === STEP_SHELL_ID);
    const promptSeg = stateFinal?.executedSteps.find(s => s.stepId === STEP_ID);
    expect(shellSeg?.sessionMeta?.synthetic, 'shell 段 synthetic:true').toBe(true);
    expect(shellSeg?.sessionMeta?.childId, 'shell 段无 childId').toBeUndefined();
    expect(promptSeg?.sessionMeta?.synthetic, 'prompt 段 synthetic:false').toBe(false);
    expect(promptSeg?.sessionMeta?.childId, 'prompt 段 childId 为真实会话 id').toBe(childId);
    // C. parent（hostSessionId = 宿主主代理会话 id）随段持久化：UI 据此组 subagent-kind 地址。
    //    overlay 新建模式（未传 hostSessionId）下宿主主代理会话 id = instanceId。
    expect(promptSeg?.sessionMeta?.hostSessionId, 'prompt 段 hostSessionId（parent）').toBe(instanceId);

    console.log('[probe] 结果汇总：\n' + JSON.stringify(probes, null, 2));
    console.log('[probe] 实例终态：' + JSON.stringify({
      status: engine.getInstanceState(instanceId)?.status,
      executedSteps: (engine.getInstanceState(instanceId)?.executedSteps ?? []).map(s => ({
        stepId: s.stepId,
        status: s.status,
        childId: s.sessionMeta?.childId,
        synthetic: s.sessionMeta?.synthetic,
      })),
    }, null, 2));

    // 期望事实（供修复决策）：
    // 1. settle 后 plain 地址 follow 应被宿主拒（session/agent-busy）→ 坐实「plain open
    //    永远失败、面板 open 不可能成功」的根因；若反而 ok，说明根因另有其因（输出已给足证据）。
    const plainSettled = probes.find(p => p.phase === 'settled' && p.addressKind === 'plain');
    if (plainSettled !== undefined) {
      console.log('[probe] plain(settled) = ' + plainSettled.outcome);
      expect(plainSettled.outcome).not.toBe('ok');
    }
    // 2. settle 后 subagent 地址（continuable 或 one-shot）至少一种 ok，且带回真实消息。
    const okSettled = probes.filter(p => p.phase === 'settled' && p.addressKind !== 'plain' && p.outcome === 'ok');
    if (okSettled.length > 0) {
      const best = okSettled[0]!;
      console.log(`[probe] subagent 地址(settled, ${best.addressKind}) ok：records=${best.records} messages=${best.messageCount}`);
      expect(best.messageCount, `subagent 地址 follow 应带回真实消息（sample=${JSON.stringify(best.sample)}）`).toBeGreaterThan(0);
    } else {
      console.warn('[probe] 没有任何 subagent 形态在 settle 后 ok（见汇总，可能需补查 parent/mode）');
    }

    for (const dispose of disposers) dispose();
  });

  afterAll(async () => {
    if (bootCtx !== undefined) {
      try {
        await bootCtx.fiber.dispose();
      } catch (error) {
        console.error('[probe] ctx.fiber.dispose() failed:', error);
      }
      bootCtx = undefined;
    }
    if (tmpRoot !== '') {
      try {
        await rm(tmpRoot, { recursive: true, force: true });
      } catch (error) {
        console.error('[probe] 清理临时目录失败:', error);
      }
    }
  }, 120_000);
});
