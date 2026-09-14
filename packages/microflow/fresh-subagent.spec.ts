/**
 * step 执行子代理「必须全新」不变量的单测（2026-09 真机缺陷）。
 *
 * ## 缺陷与证据
 * DSH `fork` provider 会给子代理 seed **父代理会话的闭合 turn 前缀**
 * （`packages/subagent/subagent-fork-in-process/src/index.ts:48-54` 的
 * `completedTurnPrefix(parent)`，`:76-90` 作为 `{seed}` 传给驱动，`:71`
 * `inheritsParentContext = true`）。step 子代理的 parent 是**宿主主代理**，于是每个 step
 * 会话都被灌进主代理历史（真机表现：step 面板里先出现主代理的「工作流已启动」
 * 「进展更新」，之后才是该 step 自己的提示词）。
 *
 * `spawn` provider 语义相反（`subagent-spawn-in-process/src/index.ts:49-50,54-65`：
 * `inheritsParentContext = false`、`start` 传 `{}`、`prepareContinuable` 返回 `{}`），
 * capabilities 与 fork 完全相同（五项全 true）→ 换用不丢能力。
 *
 * ## 本文件锁定
 * ① `FRESH_SUBAGENT_PROVIDER` 语义与名字；② {@link assertFreshSubagentProvider} 守卫对
 * 「继承父上下文」的 provider **响亮拒绝**（防止将来有人改回 `fork`）；
 * ③ 三条 `startContinuable` 路径（step 执行 / fillParams / secondary 门禁）都传 fresh
 * provider；④ 两条评估类 fork（Phase B/D、retry-fork）**保持**以 step 会话为 seed 源，
 * 且**拒绝**把宿主会话当源。
 * @module @meiyukichan/dsh-sandore/microflow/src/fresh-subagent.spec
 */
import { describe, expect, it } from 'vitest';

import { assertFreshSubagentProvider, FRESH_SUBAGENT_PROVIDER } from './subagents.ts';
import type { SubagentProviderInfo, SubagentRuntime } from './subagents.ts';

/** 最小 subagents 桩（只需要 `getProvider`）。 */
function runtimeWith(provider: SubagentProviderInfo | undefined): SubagentRuntime {
  return { getProvider: () => provider } as unknown as SubagentRuntime;
}

describe('FRESH_SUBAGENT_PROVIDER（step 子代理必须全新）', () => {
  it('names the DSH spawn provider (inheritsParentContext = false)', () => {
    expect(FRESH_SUBAGENT_PROVIDER).toBe('spawn');
  });

  it('accepts a fresh provider and a runtime without a provider registry', () => {
    expect(() => assertFreshSubagentProvider(runtimeWith({ name: 'spawn', inheritsParentContext: false }), 'spawn')).not.toThrow();
    // provider 表不可查询（mock/最小运行时）：跳过（由名字 + 单测锁语义）。
    expect(() => assertFreshSubagentProvider(runtimeWith(undefined), 'spawn')).not.toThrow();
    expect(() => assertFreshSubagentProvider({} as SubagentRuntime, 'spawn')).not.toThrow();
  });

  it('refuses a provider that inherits the parent session context (the fork regression guard)', () => {
    expect(() => assertFreshSubagentProvider(runtimeWith({ name: 'fork', inheritsParentContext: true }), 'fork'))
      .toThrowError(/inherits the parent session context/);
    // 报错信息必须指路（用 spawn）并点明后果（污染 step 上下文）。
    expect(() => assertFreshSubagentProvider(runtimeWith({ name: 'fork', inheritsParentContext: true }), 'fork'))
      .toThrowError(new RegExp(`use '${FRESH_SUBAGENT_PROVIDER}'`));
  });

  it('is safe when the provider omits the inheritance flag', () => {
    expect(() => assertFreshSubagentProvider(runtimeWith({ name: 'custom' }), 'custom')).not.toThrow();
  });
});

describe('startContinuable 调用点一律使用 fresh provider（三条执行类路径）', () => {
  it('step-runner 的 launchSubagent / fillParams 与 finalize 门禁都用 FRESH_SUBAGENT_PROVIDER 作为缺省', async () => {
    // 直接读源码文本断言（覆盖三条调用点、且抗「有人改回字面量 fork」的回归）。
    const { readFileSync } = await import('node:fs');
    const stepRunner = readFileSync(new URL('./step-runner.ts', import.meta.url), 'utf8');
    const finalize = readFileSync(new URL('./finalize-manager.ts', import.meta.url), 'utf8');
    // 缺省 provider 常量（不写字面量 'fork'）。
    expect(stepRunner).toContain('config.subagentProvider ?? FRESH_SUBAGENT_PROVIDER');
    expect(finalize).toContain('this.config.subagentProvider ?? FRESH_SUBAGENT_PROVIDER');
    // step-runner 两处 startContinuable（launchSubagent + fillParams）各有守卫。
    expect(stepRunner.match(/assertFreshSubagentProvider\(this\.ctx\.subagents, this\.subagentProvider\)/g)).toHaveLength(2);
    expect(finalize).toContain('assertFreshSubagentProvider(this.ctx.subagents, provider)');
    // 源码里不允许再出现「provider 缺省 fork」的写法。
    expect(stepRunner).not.toContain("subagentProvider ?? 'fork'");
    expect(finalize).not.toContain("subagentProvider ?? 'fork'");
  });

  it('评估/重试类 fork 保持以 step 会话为源（不得改成 fresh、不得以宿主会话为源）', async () => {
    const { readFileSync } = await import('node:fs');
    const recovery = readFileSync(new URL('../workflow/recovery-manager.ts', import.meta.url), 'utf8');
    const engine = readFileSync(new URL('../workflow/workflow-engine.ts', import.meta.url), 'utf8');
    const forkSession = readFileSync(new URL('./fork-session.ts', import.meta.url), 'utf8');
    // retry-fork：fork 源是 step 段自己的 childId（不变量注释 + 引擎侧守卫）。
    expect(recovery).toContain('this.deps.forkSession(childId, boundary)');
    expect(engine).toContain("if (source === active.state.taskId)");
    // 评估类 fork：拒绝把宿主会话当源。
    expect(forkSession).toContain('if (stepSessionId === opts.hostAgentId)');
  });
});
