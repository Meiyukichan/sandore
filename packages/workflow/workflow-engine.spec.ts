/**
 * workflow-engine.ts（SandoreEngineRuntime）的集成测试：线性执行到 completed、
 * 事件序、双发可观测、childId/sessionMeta、失败/中止终态与持久化快照。
 * @module @meiyukichan/dsh-sandore/workflow/src/workflow-engine.spec
 */
import { Context } from '@deepseek-ai/cordis';
import type { LlmRuntime, TextBlock } from '@deepseek-ai/dsh-llm';
import type { SessionStore } from '@deepseek-ai/dsh-session';
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { describe, expect, it, vi } from 'vitest';

import { assistantMessageEvent, FakeAgent, FakeAgentRegistry } from '../tests/mocks/agents.ts';
import { FakeLlm, textChunks } from '../tests/mocks/llm.ts';
import { FakeSessionStore } from '../tests/mocks/sessions.ts';
import { FakeSessionTitle } from '../tests/mocks/session-title.ts';
import { FakeShell, successResult } from '../tests/mocks/shell.ts';
import { MemoryStorageDomain } from '../tests/mocks/storage-domain.ts';
import { FakeSubagents } from '../tests/mocks/subagents.ts';
import { FakeSubprocess } from '../tests/mocks/subprocess.ts';
import { FakeUserQuestions } from '../tests/mocks/user-questions.ts';
import { FakeWorkspace, FakeWorkspaceRegistry } from '../tests/mocks/workspace.ts';
import { SandoreError } from './errors.ts';
import { SandoreEngineRuntime, SandoreEngineStub } from './index.ts';
import { registerGlobalAskTool } from './ask-tool.ts';
import type { DagRun, DagStartRequest, SandoreConfig, SandoreEngine, WorkflowTaskState } from './index.ts';
import { SandorePersistence } from './persistence.ts';
import type { ShellExecutor } from './shell.ts';
import { parseWorkflowYaml } from './yaml-parser.ts';

/** UUID 正则（合成 sessionId 统一纯 UUID 格式）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 两 Stage（shell → prompt）线性定义。 */
const linearYaml = `id: wfl-linear
name: linear
version: "1.0.0"
stages:
  - id: stg-1
    name: 分析
    steps:
      - id: step-abc
  - id: stg-2
    name: 推理
    steps:
      - id: step-prompt
steps:
  - id: step-abc
    command:
      type: shell
      value:
        command: "echo hello"
  - id: step-prompt
    command:
      type: prompt
      value:
        promptText: "summarize"
`;

/** Stage 级条件分支：stg-entry 完成后按 branch.condition 选下一 Stage
 *  （验证 tryAdvanceStage 评估 Stage branch.condition，不再盲取首个 Stage 目标）。 */
const stageBranchYaml = `id: wfl-stage-branch
name: stage-branch
version: "1.0.0"
stages:
  - id: stg-entry
    name: 入口
    steps:
      - id: step-entry
    branches:
      - condition:
          type: prompt
          value:
            promptText: "判断是否进入分支B"
        next: stg-b
      - next: stg-default
  - id: stg-b
    name: 分支B
    steps:
      - id: step-b
  - id: stg-c
    name: 分支C
    steps:
      - id: step-c
  - id: stg-default
    name: 默认
    steps:
      - id: step-default
steps:
  - id: step-entry
    command:
      type: shell
      value:
        command: "echo entry"
  - id: step-b
    command:
      type: shell
      value:
        command: "echo b"
  - id: step-c
    command:
      type: shell
      value:
        command: "echo c"
  - id: step-default
    command:
      type: shell
      value:
        command: "echo default"
`;

/** Stage 级多条件分支（无默认分支）：entry→[condA→stg-a, condB→stg-b]，
 *  stageOrder=[entry, mid, a, b]，数组下一 of entry=stg-mid（≠ 条件目标，便于区分条件命中与兜底）。 */
const stageBranchMultiYaml = `id: wfl-stage-multi
name: stage-multi
version: "1.0.0"
stages:
  - id: stg-entry
    name: 入口
    steps:
      - id: step-entry
    branches:
      - condition:
          type: prompt
          value:
            promptText: "判断是否进入A"
        next: stg-a
      - condition:
          type: prompt
          value:
            promptText: "判断是否进入B"
        next: stg-b
  - id: stg-mid
    name: 中转
    steps:
      - id: step-mid
  - id: stg-a
    name: A
    steps:
      - id: step-a
  - id: stg-b
    name: B
    steps:
      - id: step-b
steps:
  - id: step-entry
    command:
      type: shell
      value:
        command: "echo entry"
  - id: step-mid
    command:
      type: shell
      value:
        command: "echo mid"
  - id: step-a
    command:
      type: shell
      value:
        command: "echo a"
  - id: step-b
    command:
      type: shell
      value:
        command: "echo b"
`;

/** 单 Stage 多 Step（A 输出被 B 引用）定义。 */
const multiStepYaml = `id: wfl-multi
name: multi
version: "1.0.0"
stages:
  - id: stg-1
    name: 处理
    steps:
      - id: step-a
      - id: step-b
steps:
  - id: step-a
    command:
      type: shell
      value:
        command: "echo hello"
    outputTo:
      - id: opt-a
        path: "out.txt"
  - id: step-b
    command:
      type: prompt
      value:
        promptText: "summarize"
    inputFrom:
      - id: in-a
        path: "step-a"
`;

/** 单 Stage 两个 shell Step（用于第二步失败断言）。 */
const twoShellYaml = `id: wfl-two-shell
name: two-shell
version: "1.0.0"
stages:
  - id: stg-1
    name: 处理
    steps:
      - id: step-a
      - id: step-b
steps:
  - id: step-a
    command:
      type: shell
      value:
        command: "echo ok"
  - id: step-b
    command:
      type: shell
      value:
        command: "false"
`;

/** 单 Stage 单 shell Step（用于崩溃恢复重跑：无需 llm 目录即可跑通）。 */
const shellOnlyYaml = `id: wfl-shell-only
name: shell-only
version: "1.0.0"
stages:
  - id: stg-1
    name: 单shell
    steps:
      - id: step-shell
steps:
  - id: step-shell
    command:
      type: shell
      value:
        command: "echo hi"
`;

/** 单 Stage 两步线性 shell（step-a → step-b 均成功，无 branches 数组顺序兜底），供 between-steps 崩溃恢复测试。 */
const linearShellYaml = `id: wfl-linear-shell
name: linear-shell
version: "1.0.0"
stages:
  - id: stg-1
    name: 两步
    steps:
      - id: step-a
      - id: step-b
steps:
  - id: step-a
    command:
      type: shell
      value:
        command: "echo a"
  - id: step-b
    command:
      type: shell
      value:
        command: "echo b"
`;

/** 完整 DAG（分支 + 并行 + 汇合 + 循环 + 门禁 + 透传变量 + agent 子代理）。 */
const dagYaml = `id: wfl-dag
name: dag
version: "1.0.0"
stages:
  - id: stg-1
    name: 分支
    steps:
      - id: step-branch
        branches:
          - condition:
              type: prompt
              value:
                promptText: "route"
            next: step-agent
          - next: step-parallel
      - id: step-agent
        branches:
          - next: step-merge
      - id: step-parallel
        branches:
          - next: step-merge
      - id: step-fallback
        branches:
          - next: step-merge
      - id: step-merge
  - id: stg-2
    name: 循环
    steps:
      - id: step-loop
        branches:
          - next: step-iter
            loop:
              maxIterations: 3
              next: step-iter
              exitTo: step-finalize
      - id: step-iter
        branches:
          - next: step-loop
      - id: step-finalize
steps:
  - id: step-branch
  - id: step-agent
    command:
      type: agent
      value:
        promptText: "do-work"
  - id: step-parallel
    command:
      type: shell
      value:
        command: "echo parallel"
  - id: step-fallback
    command:
      type: shell
      value:
        command: "echo fallback"
  - id: step-merge
    command:
      type: shell
      value:
        command: "echo merge"
  - id: step-loop
  - id: step-iter
    command:
      type: shell
      value:
        command: "echo iter"
  - id: step-finalize
    command:
      type: prompt
      value:
        promptText: "report \${projectName}"
    passThroughVars:
      - name: projectName
        value: "\${projectName}"
        description: "项目名"
    gates:
      primary:
        enabled: true
`;

/** 单 Stage 单 shell Step 引用 \${projectName}（无声明），供缺陷 15「崩溃恢复保留提取值」测试。 */
const recoverPtvYaml = `id: wfl-recover-ptv
name: recover-ptv
version: "1.0.0"
stages:
  - id: stg-1
    name: 恢复
    steps:
      - id: step-use
steps:
  - id: step-use
    command:
      type: shell
      value:
        command: "echo \${projectName}"
`;

/** 两 Stage：stg-extract（prompt 提取 projectName=sandore）→ stg-use（shell 引用
 *  \${projectName} 且声明同名默认值 "unknown"），供缺陷 15「跨 Stage 同名变量
 *  A 提取 B 默认 → B 不覆盖 A」测试（残余差异二：initState 合并顺序）。 */
const crossStagePtvYaml = `id: wfl-cross-stage-ptv
name: cross-stage-ptv
version: "1.0.0"
stages:
  - id: stg-extract
    name: 提取
    steps:
      - id: step-extract
  - id: stg-use
    name: 使用
    steps:
      - id: step-use
steps:
  - id: step-extract
    command:
      type: prompt
      value:
        promptText: "extract projectName"
    passThroughVars:
      - name: projectName
        value: "\${projectName}"
        description: "项目名"
  - id: step-use
    command:
      type: shell
      value:
        command: "echo \${projectName}"
    passThroughVars:
      - name: projectName
        value: "unknown"
        description: "项目名默认"
`;

/** 两 Stage：stg-use（shell 引用 \${config}）→ stg-define（shell + 声明 config 默认值
 *  "default-cfg"），供缺陷 15「先引用后定义」全局默认收集测试（残余差异一）。 */
const forwardRefYaml = `id: wfl-forward-ref
name: forward-ref
version: "1.0.0"
stages:
  - id: stg-use
    name: 使用
    steps:
      - id: step-use
  - id: stg-define
    name: 定义
    steps:
      - id: step-define
steps:
  - id: step-use
    command:
      type: shell
      value:
        command: "echo \${config}"
  - id: step-define
    command:
      type: shell
      value:
        command: "echo defined"
    passThroughVars:
      - name: config
        value: "default-cfg"
        description: "配置"
`;

/** 分支无匹配（条件 false）→ 数组顺序兜底（用于验证兜底 + branchMeta 现场保留）。 */
const branchFallbackYaml = `id: wfl-branch-fallback
name: branch-fallback
version: "1.0.0"
stages:
  - id: stg-1
    name: 分支
    steps:
      - id: step-branch
        branches:
          - condition:
              type: prompt
              value:
                promptText: "route"
            next: step-matched
      - id: step-fallback
      - id: step-matched
        branches: []
steps:
  - id: step-branch
  - id: step-fallback
    command:
      type: shell
      value:
        command: "echo fallback"
  - id: step-matched
    command:
      type: shell
      value:
        command: "echo matched"
`;

/** 嵌套循环定义：外层 3 次 × 内层 3 次（基准模型：路由门 body 跑 maxIter-1 次，
 *  故 (3-1)×(3-1)=4 次 body 执行；外层重入内层时内层 visitCount 经 resetLoopVisitCounts
 *  从 0 起重新计数——验证跳出时归零语义）。 */
const nestedLoopYaml = `id: wfl-nested-loop
name: nested-loop
version: "1.0.0"
stages:
  - id: stg-1
    name: 嵌套循环
    steps:
      - id: step-outer-loop
        branches:
          - next: step-inner-loop
            loop:
              maxIterations: 3
              next: step-inner-loop
              exitTo: step-done
      - id: step-inner-loop
        branches:
          - next: step-iter
            loop:
              maxIterations: 3
              next: step-iter
              exitTo: step-outer-loop
      - id: step-iter
        branches:
          - next: step-inner-loop
      - id: step-done
steps:
  - id: step-outer-loop
  - id: step-inner-loop
  - id: step-iter
    command:
      type: shell
      value:
        command: "echo iter"
  - id: step-done
    command:
      type: shell
      value:
        command: "echo done"
`;

/** 带 breakCondition 的循环定义（prompt 判定跳出，验证 loopMeta 回写）。 */
const loopBreakYaml = `id: wfl-loop-break
name: loop-break
version: "1.0.0"
stages:
  - id: stg-1
    name: 循环跳出
    steps:
      - id: step-loop
        branches:
          - next: step-iter
            loop:
              maxIterations: 5
              breakCondition:
                type: prompt
                value:
                  promptText: "should we break?"
              next: step-iter
              exitTo: step-done
      - id: step-iter
        branches:
          - next: step-loop
      - id: step-done
steps:
  - id: step-loop
  - id: step-iter
    command:
      type: shell
      value:
        command: "echo iter"
  - id: step-done
    command:
      type: shell
      value:
        command: "echo done"
`;

/** 命令门循环：循环节点自身带 command 且自回边，每趟产生 executed 条目（验证命令门 visitCount 不双重计数）。 */
const loopCommandGateYaml = `id: wfl-loop-command-gate
name: loop-command-gate
version: "1.0.0"
stages:
  - id: stg-1
    name: 命令门循环
    steps:
      - id: step-loop
        branches:
          - next: step-loop
            loop:
              maxIterations: 3
              next: step-loop
              exitTo: step-done
      - id: step-done
steps:
  - id: step-loop
    command:
      type: shell
      value:
        command: "echo loop"
  - id: step-done
    command:
      type: shell
      value:
        command: "echo done"
`;

/** 生成指定 maxIter 的命令门循环 YAML（loop head 自带 command + 自回边）。 */
function commandGateYaml(maxIter: number): string {
  return `id: wfl-cg-${maxIter}
name: loop-command-gate
version: "1.0.0"
stages:
  - id: stg-1
    name: 命令门循环
    steps:
      - id: step-loop
        branches:
          - next: step-loop
            loop:
              maxIterations: ${maxIter}
              next: step-loop
              exitTo: step-done
      - id: step-done
steps:
  - id: step-loop
    command:
      type: shell
      value:
        command: "echo loop"
  - id: step-done
    command:
      type: shell
      value:
        command: "echo done"
`;
}

/** 带 breakCondition 但恒不跳出的循环（每趟评估都产出 loopMeta，不 break），验证 breakCondition 门 visitCount 不双重计数。 */
const loopBreakNoBreakYaml = `id: wfl-loop-break-no-break
name: loop-break-no-break
version: "1.0.0"
stages:
  - id: stg-1
    name: 循环不跳出
    steps:
      - id: step-loop
        branches:
          - next: step-iter
            loop:
              maxIterations: 3
              breakCondition:
                type: prompt
                value:
                  promptText: "should we break?"
              next: step-iter
              exitTo: step-done
      - id: step-iter
        branches:
          - next: step-loop
      - id: step-done
steps:
  - id: step-loop
  - id: step-iter
    command:
      type: shell
      value:
        command: "echo iter"
  - id: step-done
    command:
      type: shell
      value:
        command: "echo done"
`;

/** 混合分支门循环：循环节点同时带 condition 分支与 loop 分支（isLoopControl=false），每趟回边都建路由条目并递增 visitCount（验证不与回边计数叠加）。 */
const loopMixedGateYaml = `id: wfl-loop-mixed-gate
name: loop-mixed-gate
version: "1.0.0"
stages:
  - id: stg-1
    name: 混合门循环
    steps:
      - id: step-loop
        branches:
          - condition:
              type: prompt
              value:
                promptText: "exit early?"
            next: step-exit
          - next: step-iter
            loop:
              maxIterations: 3
              next: step-iter
              exitTo: step-done
      - id: step-iter
        branches:
          - next: step-loop
      - id: step-exit
      - id: step-done
steps:
  - id: step-loop
  - id: step-iter
    command:
      type: shell
      value:
        command: "echo iter"
  - id: step-exit
    command:
      type: shell
      value:
        command: "echo exit"
  - id: step-done
    command:
      type: shell
      value:
        command: "echo done"
`;

/**
 * 复杂工作流 e2e 定义（代码审查与修复流程）：覆盖 prompt 命令 + shell 命令 + 条件分支
 * （shouldExecute）+ 并行分支（无 condition 多 next）+ 循环（loop + breakCondition
 * shouldBreak + maxIterations）+ 收尾门禁（gates primary/secondary）+ 跨 Stage。
 *
 * Stage 1「代码审查与修复」：step-scan(shell) → step-route(路由门) 经条件分支(shouldExecute)
 * 走 step-fix + 并行分支走 step-report，二者汇合 step-merge → step-loop(循环门) 循环体
 * step-iter，breakCondition(shouldBreak) 跳出到 step-exit。
 * Stage 2「门禁收尾」：step-finalize(prompt) 带透传变量(projectName) + 双门禁(primary +
 * secondary)，assess 提取 projectName、primary 纯代码产物校验 + secondary AI 门禁审查
 * 判定产物合格。
 */
const complexReviewFixYaml = `id: wfl-complex
name: complex-review-fix
version: "1.0.0"
stages:
  - id: stg-review
    name: 代码审查与修复
    steps:
      - id: step-scan
      - id: step-route
        branches:
          - condition:
              type: prompt
              value:
                promptText: "判断是否需要修复"
            next: step-fix
          - next: step-report
      - id: step-fix
        branches:
          - next: step-merge
      - id: step-report
        branches:
          - next: step-merge
      - id: step-merge
        branches:
          - next: step-loop
      - id: step-loop
        branches:
          - next: step-iter
            loop:
              maxIterations: 4
              breakCondition:
                type: prompt
                value:
                  promptText: "判断是否跳出循环"
              next: step-iter
              exitTo: step-exit
      - id: step-iter
        branches:
          - next: step-loop
      - id: step-exit
  - id: stg-gate
    name: 门禁收尾
    steps:
      - id: step-finalize
steps:
  - id: step-scan
    command:
      type: shell
      value:
        command: "echo scan"
    outputTo:
      - id: opt-scan
        path: "scan-report.txt"
  - id: step-route
  - id: step-fix
    command:
      type: shell
      value:
        command: "echo fix"
  - id: step-report
    command:
      type: shell
      value:
        command: "echo report"
  - id: step-merge
    command:
      type: shell
      value:
        command: "echo merge"
  - id: step-loop
  - id: step-iter
    command:
      type: shell
      value:
        command: "echo iter"
  - id: step-exit
    command:
      type: shell
      value:
        command: "echo stage1-done"
  - id: step-finalize
    command:
      type: prompt
      value:
        promptText: "分析代码并生成最终报告"
    passThroughVars:
      - name: projectName
        value: "\${projectName}"
        description: "项目名"
    gates:
      primary:
        enabled: true
      secondary:
        enabled: true
        prompt: "审查产物是否合格"
`;

/** 写入一条工作流定义记录。 */
async function putDefinition(persistence: SandorePersistence, id: string, yaml: string): Promise<void> {
  const definition = parseWorkflowYaml(yaml);
  const createdAt = new Date().toISOString();
  await persistence.definitions.put(id, {
    yaml,
    name: definition.name,
    version: definition.version,
    createdAt,
    updatedAt: createdAt,
  });
}

/** 组装一条已完成的实例状态快照（供 getState 兜底读回测试）。 */
function completedSnapshot(instanceId: string): WorkflowTaskState {
  const createdAt = new Date().toISOString();
  return {
    taskId: instanceId,
    workflowId: 'wfl-linear',
    cwd: '/tmp',
    status: 'completed',
    originalInput: 'hello world',
    currentStageId: 'stg-1',
    executedSteps: [{
      id: 'exec-1',
      stepId: 'step-abc',
      stageId: 'stg-1',
      name: 'step-abc',
      status: 'completed',
      visitCount: 1,
      output: [{ type: 'text', text: 'hello' }],
    }],
    stageInfos: [{ id: 'stg-1', name: '分析', status: 'completed' }],
    pendingInteractions: [],
    pendingQueue: [],
    visitCounts: {},
    passThroughVars: {},
    activeLoopIterationStack: [],
    activeLoopNodeId: null,
    activeLoopStack: [],
    pausedChildIds: [],
    stageContracts: {},
    createdAt,
    updatedAt: createdAt,
  };
}

/** 组装一条非终态（running）实例状态快照（供恢复扫描测试）。 */
function runningSnapshot(instanceId: string, workflowId = 'wfl-linear'): WorkflowTaskState {
  const createdAt = new Date().toISOString();
  return {
    taskId: instanceId,
    workflowId,
    cwd: '/tmp',
    status: 'running',
    originalInput: 'hello world',
    currentStageId: 'stg-1',
    executedSteps: [],
    stageInfos: [{ id: 'stg-1', name: '分析', status: 'running' }],
    pendingInteractions: [],
    pendingQueue: [],
    visitCounts: {},
    passThroughVars: {},
    activeLoopIterationStack: [],
    activeLoopNodeId: null,
    activeLoopStack: [],
    pausedChildIds: [],
    stageContracts: {},
    createdAt,
    updatedAt: createdAt,
  };
}

/** 单个已执行 Step 的快照类型。 */
type SnapshotStep = WorkflowTaskState['executedSteps'][number];

/** 构造一条 agent 子代理 Step 快照（running/paused 两态，供恢复分类测试）。 */
function agentStepSnapshot(status: 'running' | 'paused', childId = 'child-1'): SnapshotStep {
  const createdAt = new Date().toISOString();
  return {
    id: 'exec-1',
    stepId: 'step-agent',
    stageId: 'stg-1',
    name: 'step-agent',
    status,
    command: { type: 'agent', value: { promptText: 'do work' } },
    sessionMeta: { childId, synthetic: false, command: 'agent' },
    visitCount: 1,
    ...(status === 'paused' ? { pausedAt: createdAt } : {}),
  };
}

/** 构造一条 shell 合成 Step 快照（synthetic，供「合成 session 标 failed」测试）。 */
function shellStepSnapshot(status: 'running' = 'running'): SnapshotStep {
  return {
    id: 'exec-1',
    stepId: 'step-shell',
    stageId: 'stg-1',
    name: 'step-shell',
    status,
    command: { type: 'shell', value: { command: 'echo hi' } },
    sessionMeta: { childId: 'step-shell-synthetic', synthetic: true, command: 'shell' },
    visitCount: 1,
  };
}

/** 组装一条含单个指定 Step 的实例状态快照（status 决定 pausedChildIds 是否重建）。 */
function stepSnapshot(instanceId: string, workflowId: string, step: SnapshotStep, status: WorkflowTaskState['status']): WorkflowTaskState {
  const createdAt = new Date().toISOString();
  return {
    taskId: instanceId,
    workflowId,
    cwd: '/tmp',
    status,
    originalInput: 'do work',
    currentStageId: step.stageId,
    executedSteps: [step],
    stageInfos: [{ id: step.stageId, name: 'stage', status: status === 'completed' ? 'completed' : 'running' }],
    pendingInteractions: [],
    pendingQueue: [],
    visitCounts: {},
    passThroughVars: {},
    activeLoopIterationStack: [],
    activeLoopNodeId: null,
    activeLoopStack: [],
    pausedChildIds: status === 'paused' ? [step.sessionMeta?.childId ?? step.id] : [],
    stageContracts: {},
    createdAt,
    updatedAt: createdAt,
  };
}

/** 组装一条非终态（paused）实例状态快照（含 paused Step + pausedChildIds，供登记表重建测试）。 */
function pausedSnapshot(instanceId: string, workflowId = 'wfl-agent-fail'): WorkflowTaskState {
  return stepSnapshot(instanceId, workflowId, agentStepSnapshot('paused'), 'paused');
}

/** 组装一条 between-steps 崩溃快照：step-a 已完成落盘、step-b 未执行（无活跃段），供缺陷 9 G 测试。 */
function betweenStepsSnapshot(instanceId: string, workflowId = 'wfl-linear-shell'): WorkflowTaskState {
  const createdAt = new Date().toISOString();
  return {
    taskId: instanceId,
    workflowId,
    cwd: '/tmp',
    status: 'running',
    originalInput: 'do it',
    currentStageId: 'stg-1',
    executedSteps: [{
      id: 'exec-a',
      stepId: 'step-a',
      stageId: 'stg-1',
      name: 'step-a',
      status: 'completed',
      command: { type: 'shell', value: { command: 'echo a' } },
      sessionMeta: { childId: 'step-a-synthetic', synthetic: true, command: 'shell' },
      visitCount: 1,
      createdAt,
      updatedAt: createdAt,
      attemptIndex: 0,
      output: [{ type: 'text', text: 'a' }],
    }],
    stageInfos: [{ id: 'stg-1', name: '两步', status: 'running' }],
    pendingInteractions: [],
    pendingQueue: [],
    visitCounts: { 'step-a': 1 },
    passThroughVars: {},
    activeLoopIterationStack: [],
    activeLoopNodeId: null,
    activeLoopStack: [],
    pausedChildIds: [],
    stageContracts: {},
    createdAt,
    updatedAt: createdAt,
  };
}

/** 组装一条含已提取透传变量（projectName=sandore）的 running 快照（无活跃段、无已完成
 *  Step），供缺陷 15「崩溃恢复保留提取值」测试：recoverInstance 重跑 step-use 时
 *  断言 shell 命令经 replacePassThroughVars 拿到提取值而非保留字面量。 */
function extractedPtvSnapshot(instanceId: string, workflowId = 'wfl-recover-ptv'): WorkflowTaskState {
  const createdAt = new Date().toISOString();
  return {
    taskId: instanceId,
    workflowId,
    cwd: '/tmp',
    status: 'running',
    originalInput: 'do it',
    currentStageId: 'stg-1',
    executedSteps: [],
    stageInfos: [{ id: 'stg-1', name: '恢复', status: 'running' }],
    pendingInteractions: [],
    pendingQueue: [],
    visitCounts: {},
    passThroughVars: {
      projectName: { value: 'sandore', description: '项目名' },
    },
    activeLoopIterationStack: [],
    activeLoopNodeId: null,
    activeLoopStack: [],
    pausedChildIds: [],
    stageContracts: {},
    createdAt,
    updatedAt: createdAt,
  };
}

/** 组装一条含 stale pendingInteractions 的快照（崩溃前 ask 挂起，恢复时需清理），供缺陷 9 B / 27 测试。 */
function stalePendingSnapshot(instanceId: string): WorkflowTaskState {
  const snapshot = pausedSnapshot(instanceId);
  snapshot.pendingInteractions = [{
    id: 'req-stale',
    stageId: 'stg-1',
    stepId: 'step-agent',
    sessionId: instanceId,
    requestId: 'req-stale',
    kind: 'question',
    status: 'pending',
    payload: { questions: [{ id: 'q1', question: 'stale?' }] },
    createdAt: '2026-08-16T00:00:00.000Z',
  }];
  return snapshot;
}

/** 组装集成测试 harness：注入内存 DSH 服务并加载引擎运行时。 */
async function harness(
  config: SandoreConfig = {},
  /**
   * 可选：注入面开关。`agentDefaultModel` 缺省注入（真实部署恒有：宿主会话的模型路由
   * 由它给出，缺了就 no provider/model）；显式 `false` 用于覆盖「服务缺失」降级路径。
   */
  options: { agentDefaultModel?: boolean } = {},
): Promise<{
  ctx: Context;
  engine: SandoreEngine;
  persistence: SandorePersistence;
  llm: FakeLlm;
  shell: FakeShell;
  sessions: FakeSessionStore;
  subagents: FakeSubagents;
  agents: FakeAgentRegistry;
  userQuestions: FakeUserQuestions;
  sessionTitle: FakeSessionTitle;
  /** 全局 `tools.register` 注册的工具定义（registerGlobalAskTool 注册断言用）。 */
  toolsRegistrations: unknown[];
  /** 持久化会话服务桩（`inspect` 可写：覆盖宿主唤醒抑制的持久化兜底判据）。 */
  sessionPersistence: { inspect?: (id: string) => Promise<{ header?: { id?: string; parentSession?: string } } | undefined> };
}> {
  const ctx = new Context();
  const storageDomain = new MemoryStorageDomain();
  ctx.provide('storageDomain', storageDomain as unknown as DomainFacility);
  await ctx.plugin(SandorePersistence);
  const persistence = ctx.sandorePersistence;

  const llm = new FakeLlm();
  const shell = new FakeShell();
  const sessions = new FakeSessionStore();
  const agents = new FakeAgentRegistry(sessions);
  const subagents = new FakeSubagents(ctx, (id) => agents.get(id));
  const subprocess = new FakeSubprocess();
  const userQuestions = new FakeUserQuestions();
  const sessionTitle = new FakeSessionTitle();
  // 全局工具注册表 fake（对齐 DSH `ctx.tools.register`；引擎 init 全局注册
  // sandore_ask_user_question，上游适配后注册发生在引擎 ctx 全局层）。
  const toolsRegistrations: unknown[] = [];
  const tools = {
    register: (tool: unknown) => {
      toolsRegistrations.push(tool);
      return () => {
        const index = toolsRegistrations.indexOf(tool);
        if (index >= 0) toolsRegistrations.splice(index, 1);
      };
    },
  };
  ctx.provide('llm', llm as unknown as LlmRuntime);
  ctx.provide('shell', shell as unknown as ShellExecutor);
  ctx.provide('sessions', sessions as unknown as SessionStore);
  // 持久化会话服务的可写桩：`inspect` 由测试按需注入（宿主唤醒抑制的「持久化兜底」
  // 判据⑤ 需要子会话的持久化 header；缺省无 inspect → 该判据不生效）。
  const sessionPersistence: { inspect?: (id: string) => Promise<{ header?: { id?: string; parentSession?: string } } | undefined> } = {};
  ctx.provide('sessionPersistence', sessionPersistence);
  ctx.provide('subagents', subagents);
  ctx.provide('agents', agents);
  ctx.provide('subprocess', subprocess);
  ctx.provide('userQuestions', userQuestions);
  ctx.provide('sessionTitle', sessionTitle);
  ctx.provide('fs', {});
  ctx.provide('tools', tools);
  // 部署级默认模型（真实部署由 @deepseek-ai/dsh-agent-default-model 提供）：
  // 宿主会话的 `AgentOptions` 与模型选择兜底都取自它（架构修复：宿主 turn 必须有路由）。
  if (options.agentDefaultModel !== false) {
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) });
  }

  await ctx.plugin(SandoreEngineRuntime, config);
  const engine = ctx.sandoreEngine;
  return { ctx, engine, persistence, llm, shell, sessions, subagents, agents, userQuestions, sessionTitle, toolsRegistrations, sessionPersistence };
}

/**
 * 启动实例并让它真正跑起来（入口归一后 `startInstance` 是**两阶段**的第一阶段）。
 *
 * 架构决策 1：`startInstance` 只做「新建真实顶层会话 + 绑定实例（id ≡ 会话 id）+
 * 注入协作上下文」，返回 `{instanceId, status:'pending'}`，**不执行**；执行由该会话
 * 调用 `sandore_workflow_run`（工具层）→ 引擎 `runInstanceInSession(会话 id, 请求)`
 * 触发。本 helper 就是「测试里扮演宿主会话发起 run」：把两阶段串起来，返回第二阶段的
 * DagRun（status='running'），使既有 79 处断言语义保持不变。
 *
 * 例外用法：只想验证第一阶段（建会话 + 注入 + pending）的用例直接调
 * `engine.startInstance(...)`；只想验证「会话内拉起」（已知会话路径）的用例直接调
 * `engine.runInstanceInSession(会话 id, 请求)`。
 */
async function startWorkflow(engine: SandoreEngine, request: DagStartRequest): Promise<DagRun> {
  const run = await engine.startInstance(request);
  return await engine.runInstanceInSession(run.instanceId, request);
}

/** 注册全部 sandore/* 监听器并记录事件（名称 + 参数）。 */
function recordSandoreEvents(ctx: Context): Array<{ name: string; args: unknown[] }> {  const records: Array<{ name: string; args: unknown[] }> = [];
  ctx.on('sandore/start', info => records.push({ name: 'sandore/start', args: [info] }));
  ctx.on('sandore/stage-start', (info, stageId) => records.push({ name: 'sandore/stage-start', args: [info, stageId] }));
  ctx.on('sandore/stage-completed', (info, stageId, contract) => records.push({ name: 'sandore/stage-completed', args: [info, stageId, contract] }));
  ctx.on('sandore/step-start', (info, stepId, childId, name, loopIteration) => records.push({ name: 'sandore/step-start', args: [info, stepId, childId, name, loopIteration] }));
  ctx.on('sandore/step-completed', (info, stepId, childId, output, name, loopIteration) => records.push({ name: 'sandore/step-completed', args: [info, stepId, childId, output, name, loopIteration] }));
  ctx.on('sandore/step-failed', (info, stepId, childId, error, name, loopIteration) => records.push({ name: 'sandore/step-failed', args: [info, stepId, childId, error, name, loopIteration] }));
  ctx.on('sandore/step-phase', (info, stepId, childId, phase, name, loopIteration) => records.push({ name: 'sandore/step-phase', args: [info, stepId, childId, phase, name, loopIteration] }));
  ctx.on('sandore/end', (info, result) => records.push({ name: 'sandore/end', args: [info, result] }));
  ctx.on('sandore/aborted', info => records.push({ name: 'sandore/aborted', args: [info] }));
  return records;
}

/** 等待实例到达 completed/failed 终态（以 sandore/end 为信号）。 */
function waitForEnd(ctx: Context): Promise<void> {
  return new Promise<void>(resolve => {
    ctx.once('sandore/end', () => resolve());
  });
}

/** 段模型定位：同 stepId 取 attemptIndex 最大（最后）的执行段（重试/续跑后新段）。 */
function lastSegmentOf(
  steps: readonly SnapshotStep[],
  stepId: string,
): SnapshotStep | undefined {
  const matches = steps.filter(step => step.stepId === stepId);
  if (matches.length === 0) {
    return undefined;
  }
  return matches.sort((a, b) => (b.attemptIndex ?? 0) - (a.attemptIndex ?? 0))[0];
}

/** 等待实例到达 aborted 终态（以 sandore/aborted 为信号）。 */
function waitForAborted(ctx: Context): Promise<void> {
  return new Promise<void>(resolve => {
    ctx.once('sandore/aborted', () => resolve());
  });
}

/** 等待一次 step-start（用于确认 Step 已开始执行）。 */
function waitForStepStart(ctx: Context): Promise<void> {
  return new Promise<void>(resolve => {
    ctx.once('sandore/step-start', () => resolve());
  });
}

/** `agent/pre-step` waterfall 载荷/决策最小面（与引擎冻结监听器结构对齐，不 import DSH 类型）。 */
type PreStepPayload = {
  agent: { id: string };
  messages: unknown[];
  turn: number;
  step: number;
  signal: AbortSignal;
};
type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: unknown[] };
type PreStepNext = () => Promise<PreStepDecision>;

/**
 * 模拟 DSH 对某 agent 分发一次 `agent/pre-step` waterfall：thisArg 的 filter 全放行，
 * 命中引擎 ctx 注册的监听器（与真实 DSH 在 agent scope 分发、事件沿 scope 链
 * 冒泡到引擎 ctx 等价）。返回最外层监听器（引擎监听器）的决策；`next` 为内建
 * 行为替身（记录是否被调用——被调用意味着该批次未被 park）。
 * @param messages - 本次唤醒认领的消息批次（默认空；park 判定只读 `source.senderSessionId`）。
 */
async function dispatchPreStep(
  ctx: Context,
  agentId: string,
  next: PreStepNext,
  messages: unknown[] = [],
): Promise<PreStepDecision> {
  const thisArg = { [Context.filter]: () => true };
  const payload: PreStepPayload = {
    agent: { id: agentId },
    messages,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  };
  return await (ctx.waterfall as unknown as (
    thisArg: object,
    name: string,
    payload: PreStepPayload,
    next: PreStepNext,
  ) => Promise<PreStepDecision>)(thisArg, 'agent/pre-step', payload, next);
}

/** 让 shell step 挂起（直到 abort signal 触发 finish），保持实例 running 不进入终态。 */
function hangingShell(shell: FakeShell): void {
  shell.runHandler = spec => new Promise(resolve => {
    const finish = (): void => { resolve(successResult(spec, '')); };
    if (spec.signal?.aborted) { finish(); return; }
    spec.signal?.addEventListener('abort', finish, { once: true });
  });
}

describe('SandoreEngineRuntime interface', () => {
  it('is the default export and keeps SandoreEngineStub as a named export', async () => {
    const { ctx } = await harness();
    expect(ctx.sandoreEngine).toBeInstanceOf(SandoreEngineRuntime);
    expect(SandoreEngineStub).toBeTypeOf('function');
  });

  it('declares agents, userQuestions, and sessionTitle in the seam inject list', () => {
    expect(SandoreEngineStub.inject).toContain('agents');
    expect(SandoreEngineStub.inject).toContain('userQuestions');
    expect(SandoreEngineStub.inject).toContain('sessionTitle');
    expect(SandoreEngineRuntime.inject).toContain('agents');
    expect(SandoreEngineRuntime.inject).toContain('userQuestions');
    expect(SandoreEngineRuntime.inject).toContain('sessionTitle');
  });

  it('routes recoverInstance and retryStep on unknown instances to NODE_NOT_FOUND (no longer not-implemented)', async () => {
    const { engine } = await harness();
    await expect(engine.recoverInstance('x')).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
    await expect(engine.retryStep('x', 's', 'continue', 'm')).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
  });

  it('throws NODE_NOT_FOUND for pause/resume on unknown instances', async () => {
    const { engine } = await harness();
    await expect(engine.pauseStep('x', 's')).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
    await expect(engine.resumeStep('x', 's')).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
    await expect(engine.pauseAllSteps('x')).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
    await expect(engine.resumeAllSteps('x')).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
  });

  it('replyQuestion for an unknown instance throws NODE_NOT_FOUND', async () => {
    const { engine } = await harness();
    await expect(engine.replyQuestion('x', 'q', { answers: [] })).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
    await expect(engine.replyPermission('x', 'q', 'once')).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
  });
});

describe('SandoreEngineRuntime startInstance', () => {
  it('throws when the workflowId does not exist and leaves the state table empty', async () => {
    const { engine, persistence } = await harness();
    await expect(
      engine.startInstance({ workflowId: 'wfl-none', originalInput: 'x', cwd: '/tmp' }),
    ).rejects.toBeInstanceOf(SandoreError);
    expect(persistence.state.size).toBe(0);
  });

  it('returns a run whose state is immediately readable via getState', async () => {
    const { engine, persistence } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);

    const run = await startWorkflow(engine, { workflowId: 'wfl-linear', originalInput: 'hello world', cwd: '/tmp' });
    expect(run.status).toBe('running');

    const state = engine.getState(run.instanceId);
    expect(state.originalInput).toBe('hello world');
    expect(['pending', 'running']).toContain(state.status);
  });

  it('creates a host agent via agents.create with meta.cwd and injects the collaboration context (host can act)', async () => {
    const { engine, persistence, agents } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);

    const run = await startWorkflow(engine, { workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/srv/app' });

    expect(agents.createCwds).toEqual(['/srv/app']);
    expect(agents.setupCount).toBe(1);
    const hostAgent = agents.get(run.instanceId);
    expect(hostAgent).toBeDefined();
    // 架构决策 2:宿主主代理不再被冻结（旧语义是「hold idle + pre-step reject」）；
    // 现在它被注入协作上下文唤醒一次，去调用 sandore_workflow_run。
    expect(hostAgent?.followups).toHaveLength(1);
    // 空闲宿主（FakeAgent 默认 status='idle'）走 followup（唤醒、开新 turn），不是 steer。
    expect(hostAgent?.steers).toEqual([]);
    expect(String(hostAgent?.followups[0]?.content[0] && (hostAgent.followups[0]!.content[0] as TextBlock).text))
      .toContain('sandore_workflow_run');
    // 呈现形态（本轮用户反馈）：source 必须是 DSH 上下文注入形态——客户端按
    // `source.kind !== 'user'` 渲染成左侧「上下文注入」行（ui-chat conversation-nodes/
    // message.ts:50），普通 user source 会变成右侧用户气泡。
    expect(hostAgent?.followups[0]?.source).toEqual({
      kind: 'plugin',
      plugin: 'dsh-sandore',
      form: 'notice',
      summary: expect.stringContaining('sandore_workflow_run'),
    });
  });

  it('rejects startInstance when agents.create setup throws and leaves no state', async () => {
    const { engine, persistence, agents } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);
    agents.setupError = new Error('setup boom');

    await expect(
      engine.startInstance({ workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp' }),
    ).rejects.toThrow('setup boom');
    expect(persistence.state.size).toBe(0);
  });

  it('renames the host session title to the user originalInput after creating the host session', async () => {
    const { engine, persistence, sessions, sessionTitle } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);

    const run = await startWorkflow(engine, { workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp' });

    expect(sessionTitle.calls).toHaveLength(1);
    // 新建宿主会话标题 = 用户输入的需求（originalInput），非实例 id。
    expect(sessionTitle.calls[0]?.title).toBe('do it');
    // rename 传入的是经 ctx.sessions.get 读回的 live 宿主 Session（同一引用）。
    expect(sessionTitle.calls[0]?.session).toBe(sessions.get(run.instanceId));
  });

  it('creates a REAL top-level host session whose id IS the instance id (identity holds, pending until run)', async () => {
    const { ctx, engine, persistence, agents, sessions } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);

    // 第一阶段：只建会话 + 注入上下文 + 落 pending 快照，不执行。
    const run = await engine.startInstance({ workflowId: 'wfl-shell-only', originalInput: 'do it', cwd: '/tmp' });
    expect(run.status).toBe('pending');
    expect(engine.getState(run.instanceId).status).toBe('pending');
    // 恒等式（架构决策 1）：hostAgent.id ≡ 宿主会话 id ≡ instanceId。
    expect(agents.get(run.instanceId)).toBeDefined();
    expect(sessions.get(run.instanceId)).toBeDefined();
    // 未执行：没有任何 Step 事件（挂起 shell 不会跑）。
    const records = recordSandoreEvents(ctx);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(records.filter(record => record.name === 'sandore/step-start')).toHaveLength(0);

    // 第二阶段：宿主会话调用 run → 真正开跑。
    const started = await engine.runInstanceInSession(run.instanceId, {
      workflowId: 'wfl-shell-only',
      originalInput: 'do it',
      cwd: '/tmp',
    });
    expect(started).toEqual({ instanceId: run.instanceId, status: 'running' });
  });

  it('rejects a second run while the instance is non-terminal (no duplicate start entry)', async () => {
    const { engine, persistence, shell } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    hangingShell(shell);

    const run = await startWorkflow(engine, { workflowId: 'wfl-shell-only', originalInput: 'do it', cwd: '/tmp' });
    expect(run.status).toBe('running');

    await expect(engine.runInstanceInSession(run.instanceId, {
      workflowId: 'wfl-shell-only',
      originalInput: 'do it again',
      cwd: '/tmp',
    })).rejects.toMatchObject({ code: 'INVALID_OPERATION' });

    await engine.abortInstance(run.instanceId);
  });

  it('rejects a pending-instance run whose workflowId differs from the pre-created instance', async () => {
    const { engine, persistence } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    await putDefinition(persistence, 'wfl-linear', linearYaml);

    const run = await engine.startInstance({ workflowId: 'wfl-shell-only', originalInput: 'do it', cwd: '/tmp' });
    await expect(engine.runInstanceInSession(run.instanceId, {
      workflowId: 'wfl-linear',
      originalInput: 'do it',
      cwd: '/tmp',
    })).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
  });

  it('starts a workflow inside a 调用会话 that was not pre-created by startInstance (known-session path)', async () => {
    const { ctx, engine, persistence, agents, sessions, shell } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    // 预置一个普通顶层会话（用户自己的会话）：它就是宿主会话（不新建）。
    const existingHost = new FakeAgent('sess-user');
    agents.register(existingHost);
    sessions.create('sess-user');
    shell.runHandler = async spec => successResult(spec, 'hi');

    const ended = waitForEnd(ctx);
    const run = await engine.runInstanceInSession('sess-user', {
      workflowId: 'wfl-shell-only',
      originalInput: 'do it',
      cwd: '/tmp',
    });

    // instanceId ≡ 调用会话 id；未新建 hostAgent（复用该会话），无 agents.create。
    expect(run).toEqual({ instanceId: 'sess-user', status: 'running' });
    expect(agents.createCwds).toHaveLength(0);
    expect(agents.get('sess-user')).toBe(existingHost);
    await ended;
    expect(persistence.state.get('sess-user')?.status).toBe('completed');
  });

  it('gives the host session a model route from agentDefaultModel on create (DSH: no provider/model otherwise)', async () => {
    const { engine, persistence, agents } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);

    // 第一阶段（建宿主会话）就必须带上模型路由：DSH `agent-loop/agent.ts:483-485`
    // 在 provider/model 为空时直接抛错（turn 级 error，不冒出 stderr），宿主主代理
    // 就永远无法跑 turn 去调 sandore_workflow_run。
    const run = await engine.startInstance({ workflowId: 'wfl-shell-only', originalInput: 'do it', cwd: '/tmp' });
    expect(agents.createAgentOptions).toEqual([{ provider: 'p', model: 'm' }]);
    // setup 里同时装了 agent-scoped 模型选择（两个 scoped waterfall 监听器）。
    expect(agents.setupListeners.map(entry => entry.name).sort()).toEqual(['agent/request', 'system-prompt/assemble']);
    expect(run.status).toBe('pending');
  });

  it('omits agentOptions when the agentDefaultModel service is absent (no default model deployment)', async () => {
    const { engine, persistence, agents } = await harness({}, { agentDefaultModel: false });
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);

    await engine.startInstance({ workflowId: 'wfl-shell-only', originalInput: 'do it', cwd: '/tmp' });
    // 服务缺失：不传 agentOptions（不抛错），行为与修复前一致。
    expect(agents.createAgentOptions).toEqual([undefined]);
  });

  it('gives the resumed host session the same model route (recoverInstance path)', async () => {
    const { ctx, engine, persistence, sessions, agents, shell } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    shell.runHandler = async spec => successResult(spec, 'hi');
    await persistence.state.put('inst-rec-route', runningSnapshot('inst-rec-route', 'wfl-shell-only'));
    sessions.create('inst-rec-route');

    const ended = waitForEnd(ctx);
    await engine.recoverInstance('inst-rec-route');
    await ended;

    expect(agents.resumeAgentOptions).toEqual([{ provider: 'p', model: 'm' }]);
  });

  it('rejects runInstanceInSession for a session with no live agent', async () => {    const { engine, persistence } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);

    await expect(engine.runInstanceInSession('ghost-host', {
      workflowId: 'wfl-shell-only',
      originalInput: 'do it',
      cwd: '/tmp',
    })).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
  });

  it('allows a new run in the same session once the previous instance is terminal (same slot, fresh state)', async () => {
    const { ctx, engine, persistence, shell } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    shell.runHandler = async spec => successResult(spec, 'hi');

    const first = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-shell-only', originalInput: 'first', cwd: '/tmp' });
    await first;
    expect(persistence.state.get(run.instanceId)?.status).toBe('completed');

    // 终态后可再次 run（同一会话槽位）：新实例沿用同一 id，状态/输入全新。
    const second = waitForEnd(ctx);
    const again = await engine.runInstanceInSession(run.instanceId, {
      workflowId: 'wfl-shell-only',
      originalInput: 'second',
      cwd: '/tmp',
    });
    expect(again).toEqual({ instanceId: run.instanceId, status: 'running' });
    await second;
    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    expect(state?.originalInput).toBe('second');
    expect(state?.executedSteps).toHaveLength(1);
  });

  it('does not fail startInstance when sessionTitle.rename throws and still executes to completion', async () => {
    const { ctx, engine, persistence, sessionTitle } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    sessionTitle.renameError = new Error('title boom');

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-shell-only', originalInput: 'do it', cwd: '/tmp' });

    expect(run.status).toBe('running');
    await ended;
    expect(persistence.state.get(run.instanceId)?.status).toBe('completed');
    expect(sessionTitle.calls).toHaveLength(1);
  });

  it('falls back to the state table when the instance is not in memory', async () => {
    const { engine, persistence } = await harness();
    await persistence.state.put('inst-fallback', completedSnapshot('inst-fallback'));

    const state = engine.getState('inst-fallback');
    expect(state.taskId).toBe('inst-fallback');
    expect(state.status).toBe('completed');
    expect(state.originalInput).toBe('hello world');
    expect(state.currentStageId).toBe('stg-1');
    expect(state.executedSteps).toHaveLength(1);
    expect(state.executedSteps[0]?.stepId).toBe('step-abc');
  });

  it('throws NODE_NOT_FOUND when neither memory nor the state table has the instance', async () => {
    const { engine } = await harness();
    let caught: unknown;
    try {
      engine.getState('inst-none');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SandoreError);
    expect(caught).toMatchObject({ code: 'NODE_NOT_FOUND' });
  });

  it('getInstanceState returns active.state for a running instance (含阶段中间态)', async () => {
    const { engine, persistence } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);

    const run = await startWorkflow(engine, { workflowId: 'wfl-linear', originalInput: 'hello', cwd: '/tmp' });
    // 实例刚启动（fire-and-forget），内存有 active instance
    const live = engine.getInstanceState(run.instanceId);
    expect(live).toBeDefined();
    expect(live?.taskId).toBe(run.instanceId);
    // 显式落地宿主主代理会话 id（恒等 taskId）：消费面不必再依赖约定。
    expect(live?.hostSessionId).toBe(run.instanceId);
    expect(live?.originalInput).toBe('hello');
    // 状态应为 running/pending（fire-and-forget 后内存 state 已更新）
    expect(['pending', 'running']).toContain(live?.status);
  });

  it('hydrateStateMessages 从各段子代理会话按需回填 sessionMessages（state 不再持久化该字段）', async () => {
    const { ctx, engine, persistence } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);
    const run = await startWorkflow(engine, { workflowId: 'wfl-linear', originalInput: 'hello', cwd: '/tmp' });
    // 手工给某个 step 段登记真实 childId，并在该子代理会话里塞两条消息事件。
    const sessions = ctx.get('sessions') as FakeSessionStore;
    const child = sessions.create('child-hydrate');
    child.append('user/message', { id: 'u1', content: [{ type: 'text', text: '来自会话的指令' }] });
    child.append('assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'text', text: '来自会话的答复' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      },
    });
    const raw = engine.getInstanceState(run.instanceId)!;
    const withStep: WorkflowTaskState = {
      ...raw,
      executedSteps: [{
        type: 'default',
        id: 'seg-hydrate',
        stepId: 'step-1',
        stageId: 'stg-1',
        name: 'lint',
        status: 'completed',
        visitCount: 0,
        sessionMeta: { childId: 'child-hydrate', synthetic: false, command: 'prompt' },
      }],
    };
    // 原始 state（= 被持久化的那份）**没有** sessionMessages。
    expect((withStep.executedSteps[0] as { sessionMessages?: unknown }).sessionMessages).toBeUndefined();

    const hydrated = await engine.hydrateStateMessages(withStep);
    const messages = (hydrated.executedSteps[0] as { sessionMessages?: Array<{ text?: string }> }).sessionMessages;
    expect(messages?.map(message => message.text)).toEqual(['来自会话的指令', '来自会话的答复']);
    // 不改入参（返回新对象）。
    expect((withStep.executedSteps[0] as { sessionMessages?: unknown }).sessionMessages).toBeUndefined();
  });

  it('getInstanceState returns undefined when instance is not in memory (终态清表/未启动)', async () => {
    const { engine, persistence } = await harness();
    // 直接写入持久化（不经过引擎内存）
    await persistence.state.put('inst-persisted', completedSnapshot('inst-persisted'));

    // 内存无此实例 → getInstanceState 返回 undefined
    const live = engine.getInstanceState('inst-persisted');
    expect(live).toBeUndefined();
  });

  it('seeds global default pass-through vars at start so a forward reference resolves (defect 15)', async () => {
    const { ctx, engine, persistence, shell } = await harness();
    await putDefinition(persistence, 'wfl-forward-ref', forwardRefYaml);
    // shell 回显命令本身，便于断言经 replacePassThroughVars 替换后的实际命令。
    shell.runHandler = async spec => successResult(spec, spec.command);

    const ended = waitForEnd(ctx);
    await startWorkflow(engine, { workflowId: 'wfl-forward-ref', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    // 全局默认收集（first-wins，残余差异一）：step-use（Stage 1）引用 ${config}，而
    // config 的字面量默认值 "default-cfg" 只在 Stage 2 的 step-define 声明。startInstance
    // 全局播种后，Stage 1 执行时 replacePassThroughVars 拿到 'default-cfg' 而非保留
    // 字面量 ${config}。修复前（passThroughVars 初始为 {}）此处为 'echo ${config}'。
    expect(shell.specs.map(spec => spec.command)).toEqual(['echo default-cfg', 'echo defined']);
  });
});

describe('SandoreEngineRuntime host agent workspace attach', () => {
  it('attaches the new host agent to the web workspace resolved by cwd', async () => {
    const { ctx, engine, persistence } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    // 显式提供 workspaceRegistry（默认 harness 不 provide，仅本 describe 内注入）。
    const workspace = new FakeWorkspace('/ws/project');
    const registry = new FakeWorkspaceRegistry([workspace]);
    ctx.provide('workspaceRegistry', registry);

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-shell-only', originalInput: 'do it', cwd: '/ws/project' });
    await ended;

    // 新建分支 attach：hostAgent.id = instanceId 挂到 cwd 命中的 workspace 成员账。
    expect(workspace.attached).toEqual([run.instanceId]);
    expect(persistence.state.get(run.instanceId)?.status).toBe('completed');
  });

  it('auto-creates a workspace when cwd does not resolve to a registered one (对齐 DSH ensureWorkspace)', async () => {
    const { ctx, engine, persistence } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    const registry = new FakeWorkspaceRegistry([new FakeWorkspace('/ws/project')]);
    ctx.provide('workspaceRegistry', registry);

    // cwd 未命中任何已登记 workspace：attach 前自动 create（不再抛 INVALID_OPERATION），
    // 实例正常启动，hostAgent 会话挂到按 cwd 新建的 workspace 成员账。
    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-shell-only', originalInput: 'do it', cwd: '/other/dir' });
    await ended;

    const created = await registry.resolveByPath('/other/dir');
    expect(created).toBeDefined();
    expect(created?.attached).toEqual([run.instanceId]);
    expect(persistence.state.get(run.instanceId)?.status).toBe('completed');
  });

  it('silently skips attach when no workspaceRegistry is provided (test/headless degradation)', async () => {
    const { ctx, engine, persistence } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);

    // 默认 harness 不 provide workspaceRegistry：attach 静默跳过（测试/headless 退化），
    // 实例正常启动；cwd 仍按必填透传进状态快照。
    const run = await startWorkflow(engine, { workflowId: 'wfl-shell-only', originalInput: 'do it', cwd: '/tmp' });
    expect(run.status).toBe('running');
    expect(persistence.state.get(run.instanceId)?.cwd).toBe('/tmp');
    expect(ctx.get('workspaceRegistry')).toBeUndefined();
  });

  it('re-attaches the recovered host agent to the workspace from the snapshot cwd', async () => {
    const { ctx, engine, persistence, sessions } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    const workspace = new FakeWorkspace('/ws/project');
    const registry = new FakeWorkspaceRegistry([workspace]);
    ctx.provide('workspaceRegistry', registry);

    // 崩溃恢复：running 快照的 cwd 指向 workspace 目录（宿主会话 header 同 cwd）。
    await persistence.state.put('inst-recover', { ...runningSnapshot('inst-recover', 'wfl-shell-only'), cwd: '/ws/project' });
    sessions.create('inst-recover');

    const ended = waitForEnd(ctx);
    const result = await engine.recoverInstance('inst-recover');
    expect(result.status).toBe('running');
    await ended;

    // 恢复重建 hostAgent 后重新 attach（hostAgent.id = instanceId，对齐 startInstance 新建分支）。
    expect(workspace.attached).toEqual(['inst-recover']);
    expect(persistence.state.get('inst-recover')?.status).toBe('completed');
  });
});

describe('SandoreEngineRuntime linear execution', () => {
  it('runs a shell Step then a prompt Step to completed with the exact event order', async () => {
    const { ctx, engine, persistence, llm, shell, agents, sessions } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);
    shell.runHandler = async spec => successResult(spec, 'hello');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    llm.streamHandler = () => textChunks('summary');
    // prompt Step 走可续接子代理（决策 D3）：注册真实 childId 并回填最终输出。
    const promptChild = new FakeAgent('child-1');
    promptChild.session.append(assistantMessageEvent([{ type: 'text', text: 'summary' }]));
    agents.register(promptChild);

    const records = recordSandoreEvents(ctx);
    const ended = waitForEnd(ctx);

    const run = await startWorkflow(engine, { workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    expect(records.map(record => record.name)).toEqual([
      'sandore/start',
      'sandore/stage-start',
      'sandore/step-start',
      'sandore/step-completed',
      'sandore/stage-completed',
      'sandore/stage-start',
      'sandore/step-start',
      'sandore/step-completed',
      'sandore/stage-completed',
      'sandore/end',
    ]);

    // Round 25（去污染）：宿主会话不再承载 sandore/* 事件（Cordis 事件断言见上
    // L1473-1484 records；宿主会话仅保留 sandbox/mode 等宿主自身事件）。
    const session = sessions.get(run.instanceId);
    expect(session?.events.some(event => event.type.startsWith('sandore/'))).toBe(false);

    // prompt 成功：step-completed 事件 payload 的 output 即聚合 ContentBlock[]，
    // 且 name 为 Step 定义 id（YAML 未写 name 时兜底回退 id）；非循环 Step 无 loopIteration。
    const promptCompleted = records.find(record => record.name === 'sandore/step-completed' && record.args[1] === 'step-prompt');
    expect(promptCompleted?.args[3]).toEqual([{ type: 'text', text: 'summary' }]);
    expect(promptCompleted?.args[4]).toBe('step-prompt');
    expect(promptCompleted?.args[5]).toBeUndefined();

    // 完成后 state 表读回快照。
    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    expect(state?.executedSteps).toHaveLength(2);
    expect(state?.executedSteps[0]?.status).toBe('completed');
    expect(state?.executedSteps[1]?.status).toBe('completed');
    expect(state?.executedSteps[0]?.output).toEqual([{ type: 'text', text: 'hello' }]);
    expect(state?.executedSteps[1]?.output).toEqual([{ type: 'text', text: 'summary' }]);
    expect(state?.stageInfos[0]?.status).toBe('completed');
    expect(state?.stageInfos[1]?.status).toBe('completed');
    expect(Object.keys(state?.stageContracts ?? {})).toHaveLength(2);
  });

  it('executes multiple steps within a stage in order and assembles the stage contract', async () => {
    const { ctx, engine, persistence, llm, shell, agents } = await harness();
    await putDefinition(persistence, 'wfl-multi', multiStepYaml);
    shell.runHandler = async spec => successResult(spec, 'hello');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    llm.streamHandler = () => textChunks('summary');
    // step-b 为 prompt Step，走可续接子代理：注册真实 childId 并回填最终输出。
    const promptChild = new FakeAgent('child-1');
    promptChild.session.append(assistantMessageEvent([{ type: 'text', text: 'summary' }]));
    agents.register(promptChild);

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-multi', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    expect(state?.executedSteps.map(step => step.stepId)).toEqual(['step-a', 'step-b']);
    const contract = state?.stageContracts['stg-1'];
    expect(contract?.stageId).toBe('stg-1');
    expect(contract?.stageName).toBe('处理');
    expect(contract?.status).toBe('completed');
    expect(contract?.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(contract?.artifacts[0]?.stepId).toBe('step-a');
    expect(contract?.artifacts[0]?.outputToId).toBe('opt-a');
  });

  it('continues to completed even when a ctx.emit listener throws', async () => {
    const { ctx, engine, persistence, llm, shell, agents } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);
    shell.runHandler = async spec => successResult(spec, 'hello');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    llm.streamHandler = () => textChunks('summary');
    // prompt Step 走可续接子代理：注册真实 childId 并回填最终输出。
    const promptChild = new FakeAgent('child-1');
    promptChild.session.append(assistantMessageEvent([{ type: 'text', text: 'summary' }]));
    agents.register(promptChild);

    ctx.on('sandore/step-start', () => {
      throw new Error('listener boom');
    });

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    expect(persistence.state.get(run.instanceId)?.status).toBe('completed');
  });

  it('synthesizes childId and sessionMeta for each executed step', async () => {
    const { ctx, engine, persistence, llm, shell, agents } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);
    shell.runHandler = async spec => successResult(spec, 'hello');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    llm.streamHandler = () => textChunks('summary');
    // prompt Step 走可续接子代理：注册真实 childId 并回填最终输出。
    const promptChild = new FakeAgent('child-1');
    promptChild.session.append(assistantMessageEvent([{ type: 'text', text: 'summary' }]));
    agents.register(promptChild);

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    // shell 不建子代理（2026-09-09）：sessionMeta 无 childId、synthetic:true。
    expect(state?.executedSteps[0]?.sessionMeta?.childId).toBeUndefined();
    expect(state?.executedSteps[0]?.sessionMeta?.synthetic).toBe(true);
    expect(state?.executedSteps[0]?.sessionMeta?.command).toBe('shell');
    // prompt 走真实子代理（决策 D3）：childId 为真实会话 id、synthetic:false、command 保留 'prompt'；
    // hostSessionId = parent（overlay 新建宿主 = taskId = instanceId），贯穿持久化（2026-09-09）。
    expect(state?.executedSteps[1]?.sessionMeta?.childId).toBe('child-1');
    expect(state?.executedSteps[1]?.sessionMeta?.synthetic).toBe(false);
    expect(state?.executedSteps[1]?.sessionMeta?.command).toBe('prompt');
    expect(state?.executedSteps[1]?.sessionMeta?.hostSessionId).toBe(run.instanceId);
  });
});

describe('SandoreEngineRuntime failure', () => {
  it('fails the instance on shell nonzero exit and emits step-failed', async () => {
    const { ctx, engine, persistence, shell } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);
    shell.runHandler = async spec => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: '', truncated: false },
      stderr: { text: 'boom', truncated: false },
    });

    const records = recordSandoreEvents(ctx);
    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('failed');
    expect(state?.executedSteps[0]?.error).toContain('boom');
    const failed = records.find(record => record.name === 'sandore/step-failed');
    expect(failed).toBeDefined();
    expect(failed?.args[1]).toBe('step-abc');
    expect(failed?.args[4]).toBe('step-abc');
  });

  it('keeps the first step completed when the second step fails', async () => {
    const { ctx, engine, persistence, shell } = await harness();
    await putDefinition(persistence, 'wfl-two-shell', twoShellYaml);
    shell.runHandler = async spec => (spec.command.includes('echo')
      ? successResult(spec, 'ok')
      : {
        exitCode: 2,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: spec.timeoutMs,
        stdout: { text: '', truncated: false },
        stderr: { text: 'second boom', truncated: false },
      });

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-two-shell', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('failed');
    expect(state?.executedSteps).toHaveLength(2);
    expect(state?.executedSteps[0]?.status).toBe('completed');
    expect(state?.executedSteps[1]?.status).toBe('failed');
    expect(state?.executedSteps[1]?.error).toBeTruthy();
  });

  it('fails the instance with failure.message on prompt finish error', async () => {
    const { ctx, engine, persistence, llm, shell, agents, subagents } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);
    shell.runHandler = async spec => successResult(spec, 'hello');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    // prompt Step 走可续接子代理：child status=running 不自动 settle，由测试触发
    // settle(error) 模拟模型失败（对齐 DSH `subagent/end` stopReason=error）。
    const promptChild = new FakeAgent('child-1');
    promptChild.status = 'running';
    agents.register(promptChild);

    const stepStarted = waitForStepStart(ctx);
    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;
    subagents.settleChild('child-1', 'error');
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('failed');
    expect(state?.executedSteps[1]?.error).toContain('settle error');
  });
});

describe('SandoreEngineRuntime abort', () => {
  it('aborts a hanging shell step to the aborted terminal state', async () => {
    const { ctx, engine, persistence, shell } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);
    shell.runHandler = spec => new Promise(resolve => {
      const finish = (): void => {
        resolve({
          exitCode: null,
          signal: 'SIGTERM',
          timedOut: false,
          aborted: true,
          timeoutMs: spec.timeoutMs,
          stdout: { text: '', truncated: false },
          stderr: { text: '', truncated: false },
        });
      };
      if (spec.signal?.aborted) {
        finish();
        return;
      }
      spec.signal?.addEventListener('abort', finish, { once: true });
    });

    const records = recordSandoreEvents(ctx);
    const aborted = waitForAborted(ctx);
    const stepStarted = waitForStepStart(ctx);

    const run = await startWorkflow(engine, { workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;
    await engine.abortInstance(run.instanceId);
    await aborted;

    // 收敛到单一出口：abortInstance 显式发射一次，runInstance failed 分支不再重复发射。
    expect(records.filter(record => record.name === 'sandore/aborted')).toHaveLength(1);
    expect(persistence.state.get(run.instanceId)?.status).toBe('aborted');
  });

  it('rejects abortInstance for a completed instance', async () => {
    const { ctx, engine, persistence, llm, shell } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);
    shell.runHandler = async spec => successResult(spec, 'hello');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    llm.streamHandler = () => textChunks('summary');

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    await expect(engine.abortInstance(run.instanceId)).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
  });
});

/**
 * 中止广播幂等：**同一实例同一次中止，`sandore/aborted` 恒恰一次**。
 *
 * 实测竞态（e2e F 层 ⑪ 收到 2 次 `sandore/aborted`）的两条路径与交错点：
 * ① `abortInstance`（workflow-engine.ts:709）经 `markAborted`（:738）落 aborted 态 +
 *    广播一次；
 * ② 主循环 aborted 兜底分支（workflow-engine.ts:1527）同样经 `markAborted`（:1535）。
 *
 * 交错成因（修复前的守卫为何失效）：被 kill 的 shell Step 以 `aborted: true` 结算 →
 * StepRunner 抛 `STEP_EXECUTION`（step-runner.ts:544-547）→ StageExecutor catch 分支
 * `commitState({ status: 'failed' })`（stage-executor.ts:901-903）经引擎回调
 * （workflow-engine.ts:1377 的 `commitState`）把内存态**打回 failed** → 兜底分支原守卫
 * `status !== 'aborted'` 读到 failed 而误判「尚未落态」→ 二次落态 + 二次广播。
 * 探针实测：兜底守卫当时观察到的 status 正是 `failed`（而非 abortInstance 落的 aborted）。
 * `sandore/end` 不重复（中止分支直接 return），故只有 aborted 双发。
 */
describe('SandoreEngineRuntime abort 幂等广播', () => {
  /**
   * 中止后才结算的 shell Step：结算**推迟一个宏任务**，稳定复现「abortInstance 落态 +
   * 广播 → 失败回写打回 failed → 兜底分支二次广播」的交错（不依赖时序抖动）。
   */
  function shellAbortedAfterAbort(shell: FakeShell): void {
    shell.runHandler = spec => new Promise(resolve => {
      const settle = (): void => {
        resolve({
          exitCode: null,
          signal: 'SIGTERM',
          timedOut: false,
          aborted: true,
          timeoutMs: spec.timeoutMs,
          stdout: { text: '', truncated: false },
          stderr: { text: '', truncated: false },
        });
      };
      // 关键：不在 abort 监听里同步结算——推到下一个宏任务，保证 abortInstance 的
      // markAborted 落态 + 广播（workflow-engine.ts:709 处的 await）先完成。
      const defer = (): void => { setTimeout(settle, 0); };
      if (spec.signal?.aborted) { defer(); return; }
      spec.signal?.addEventListener('abort', defer, { once: true });
    });
  }

  /**
   * 冲净中止后的收敛链：失败回写与主循环兜底分支都挂在首次广播**之后**的微任务链上，
   * 只等 `sandore/aborted` 就断言会漏掉第二次广播（既有用例的盲区）。
   */
  async function drainLoop(): Promise<void> {
    for (let round = 0; round < 10; round += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  it('中止 running shell step：两路径交错仍恰一次 sandore/aborted、终态 aborted、无 sandore/end', async () => {
    const { ctx, engine, persistence, shell } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);
    shellAbortedAfterAbort(shell);

    const records = recordSandoreEvents(ctx);
    const stepStarted = waitForStepStart(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;
    await engine.abortInstance(run.instanceId);
    await drainLoop();

    // ① abortInstance 广播 + ② 兜底分支（失败回写把内存态打回 failed 后仍进入兜底）——
    // 幂等标记保证只广播一次。
    expect(records.filter(record => record.name === 'sandore/aborted')).toHaveLength(1);
    // 中止契约：不发 sandore/end。
    expect(records.filter(record => record.name === 'sandore/end')).toHaveLength(0);
    // 终态必须持久化为 aborted（兜底重发被收敛后仍要保证落态）。
    expect(persistence.state.get(run.instanceId)?.status).toBe('aborted');
  });

  it('中止后 shell Step 成功结算：主循环兜底分支读到已落态，单路径仍恰一次 sandore/aborted', async () => {
    const { ctx, engine, persistence, shell } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    // 中止与自然完成竞争：shell 在 abort 后以**成功**结算（无失败回写）→ 主循环兜底
    // 分支读到的仍是 abortInstance 落的 aborted 态（守卫/一次性标记生效路径）。
    shell.runHandler = spec => new Promise(resolve => {
      const settle = (): void => { setTimeout(() => resolve(successResult(spec, '')), 0); };
      if (spec.signal?.aborted) { settle(); return; }
      spec.signal?.addEventListener('abort', settle, { once: true });
    });

    const records = recordSandoreEvents(ctx);
    const stepStarted = waitForStepStart(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-shell-only', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;
    await engine.abortInstance(run.instanceId);
    await drainLoop();

    expect(records.filter(record => record.name === 'sandore/aborted')).toHaveLength(1);
    expect(records.filter(record => record.name === 'sandore/end')).toHaveLength(0);
    expect(persistence.state.get(run.instanceId)?.status).toBe('aborted');
  });

  it('中止 ask 挂起实例：问答 waiter 随 abort 拒绝时仍不发 sandore/end、终态 aborted', async () => {
    const { ctx, engine, persistence, llm, agents, sessions, userQuestions } = await harness();
    await putDefinition(persistence, 'wfl-ask', askYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    // prompt Step（step-ask）走可续接子代理：注册真实 childId 并回填最终输出。
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'work done' }]));
    agents.register(child);
    // 复用宿主会话（hostSessionId）→ ask 上报宿主（userQuestions.ask，场景 B）才真正发起。
    const existingHost = new FakeAgent('host-1');
    agents.register(existingHost);
    sessions.create('host-1');
    // 收尾评估判定 ask（ask 保底中断）→ 引擎 interactions.ask → 上报宿主弹窗。
    llm.streamHandler = () => textChunks('{"completionType":"ask","passThroughVars":{"projectName":"sandore"},"askQuestion":{"questions":[{"id":"q1","question":"Which?"}]}}');
    // 第三条中止路径：DSH 弹窗随实例中止被取消 → userQuestions.ask reject →
    // interaction-manager failQuestion 拒绝引擎 waiter → 异常冒泡出 runInstance 到
    // runAndCatch。若不收口，runAndCatch 会落 failed + 发 sandore/end（中止契约破裂）。
    userQuestions.resolveNext = request => new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => { reject(new Error('question aborted')); }, { once: true });
    });

    const records = recordSandoreEvents(ctx);
    const question = waitForQuestion(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-ask', originalInput: 'do it', cwd: '/tmp' });
    await question;
    await engine.abortInstance(run.instanceId);
    await drainLoop();

    expect(records.filter(record => record.name === 'sandore/aborted')).toHaveLength(1);
    // 中止路径不发 sandore/end（ask waiter 拒绝也不得把实例落 failed）。
    expect(records.filter(record => record.name === 'sandore/end')).toHaveLength(0);
    expect(persistence.state.get(run.instanceId)?.status).toBe('aborted');
  });

  it('回归：completed / failed 路径 sandore/end 恒恰一次且无 sandore/aborted', async () => {
    // completed（shellOnlyYaml：单 shell Step 自然完成，无需 llm）。
    {
      const { ctx, engine, persistence, shell } = await harness();
      await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
      shell.runHandler = async spec => successResult(spec, 'hi');

      const records = recordSandoreEvents(ctx);
      const ended = waitForEnd(ctx);
      const run = await startWorkflow(engine, { workflowId: 'wfl-shell-only', originalInput: 'do it', cwd: '/tmp' });
      await ended;
      await drainLoop();

      expect(records.filter(record => record.name === 'sandore/end')).toHaveLength(1);
      expect(records.filter(record => record.name === 'sandore/aborted')).toHaveLength(0);
      expect(persistence.state.get(run.instanceId)?.status).toBe('completed');
    }
    // failed（twoShellYaml：第二步 shell 失败 → failed 终态）。
    {
      const { ctx, engine, persistence, shell } = await harness();
      await putDefinition(persistence, 'wfl-two-shell', twoShellYaml);
      shell.runHandler = async spec => (spec.command === 'false'
        ? {
          exitCode: 1,
          signal: null,
          timedOut: false,
          aborted: false,
          timeoutMs: spec.timeoutMs,
          stdout: { text: '', truncated: false },
          stderr: { text: 'boom', truncated: false },
        }
        : successResult(spec, 'ok'));

      const records = recordSandoreEvents(ctx);
      const ended = waitForEnd(ctx);
      const run = await startWorkflow(engine, { workflowId: 'wfl-two-shell', originalInput: 'do it', cwd: '/tmp' });
      await ended;
      await drainLoop();

      // 失败路径照旧：sandore/end(failed) 一次；runAndCatch 的中止收口不得吞掉真实失败。
      expect(records.filter(record => record.name === 'sandore/end')).toHaveLength(1);
      expect(records.filter(record => record.name === 'sandore/aborted')).toHaveLength(0);
      expect(persistence.state.get(run.instanceId)?.status).toBe('failed');
    }
  });
});

/**
 * 架构决策 2：宿主主代理**不再被冻结**，改为在 `agent/pre-step` 里**只 park 本实例
 * Step 子代理发来的消息**（DSH 结算通知 `source.kind='subagent-settled'` / 显式子代理
 * 消息 `source.kind='agent-message'`，二者都带 `source.senderSessionId = childId`）。
 *
 * 判定依据（引擎 registerHostSessionNoticeFilter / isInstanceChildMessage）：
 * ① `senderSessionId` ∈ 本实例 executedSteps 的全部 childId（含多段/paused）∪
 *    生命周期暂停登记表；
 * ② 兜底：`ctx.sessions.get(senderSessionId).header.parentSession === 宿主会话 id`
 *    （覆盖未落 executedSteps 的引擎自建子代理：fillParams、secondary 门禁等）。
 *
 * **DSH 语义（实测/源码确认）**：`{kind:'reject'}` 关闭该 turn（`turn/end` reason
 * `blocked`）且**不产生任何模型调用**；被认领的消息按 DSH `consumed-work.ts:33-49`
 * 的原文「the pre-step rejection that produced it discarded the claimed messages」
 * 被**消费丢弃**（不会在下次唤醒时重新可见）——故本组用例断言的是「不唤醒」而非
 * 「parked 后可见」；子代理的产出自有引擎通道落盘（见最后一个用例）。
 */
describe('SandoreEngineRuntime host session message park（架构决策 2：取代冻结机制）', () => {
  /** 起一个 running 实例并等它的 Step 子代理 childId 落到快照（挂起子代理保持 running）。 */
  async function runningInstanceWithChild(): Promise<{
    ctx: Context;
    engine: SandoreEngine;
    persistence: Awaited<ReturnType<typeof harness>>['persistence'];
    agents: FakeAgentRegistry;
    subagents: FakeSubagents;
    sessions: FakeSessionStore;
    sessionPersistence: Awaited<ReturnType<typeof harness>>['sessionPersistence'];
    instanceId: string;
    childId: string;
  }> {
    const { ctx, engine, persistence, llm, agents, subagents, sessions, sessionPersistence } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);
    provideLlmDirectory(llm);
    // 挂起子代理：status='running' → 不自动 settle，step 保持 running，实例保持 running。
    const child = new FakeAgent('child-1');
    child.status = 'running';
    agents.register(child);
    const stepStarted = waitForStepStart(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-agent-fail', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;
    await vi.waitFor(() => {
      const step = persistence.state.get(run.instanceId)?.executedSteps.find(s => s.stepId === 'step-agent');
      expect(step?.sessionMeta?.childId).toBe('child-1');
    });
    return { ctx, engine, persistence, agents, subagents, sessions, sessionPersistence, instanceId: run.instanceId, childId: 'child-1' };
  }

  /** 一条来自指定子代理会话的消息（source 形状对齐 DSH continuation.ts 的两种投递）。 */
  function childMessage(senderSessionId: string, kind = 'subagent-settled'): unknown {
    return { id: `msg-${kind}-${senderSessionId}`, content: [{ type: 'text', text: 'settled' }], source: { kind, senderSessionId, form: 'notice', summary: 'child settled' } };
  }

  it('parks a settlement notice from this instance step subagent (reject, next not called, no model call)', async () => {
    const { ctx, engine, instanceId, childId } = await runningInstanceWithChild();

    const next = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] }));
    const decision = await dispatchPreStep(ctx, instanceId, next, [childMessage(childId)]);
    expect(decision).toEqual({ kind: 'reject' });
    expect(next).not.toHaveBeenCalled();

    await engine.abortInstance(instanceId);
  });

  it('parks an explicit agent-message from this instance child too (not only settlement notices)', async () => {
    const { ctx, engine, instanceId, childId } = await runningInstanceWithChild();

    const next = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] }));
    const decision = await dispatchPreStep(ctx, instanceId, next, [
      { id: 'm1', content: [{ type: 'text', text: 'report' }], source: { kind: 'agent-message', form: 'relay', senderSessionId: childId } },
    ]);
    expect(decision).toEqual({ kind: 'reject' });
    expect(next).not.toHaveBeenCalled();

    await engine.abortInstance(instanceId);
  });

  it('parks a notice from an AUXILIARY child (fillParams / secondary gate) whose live session is already gone — the 2026-09 real-machine leak', async () => {
    const { ctx, engine, instanceId, sessions } = await runningInstanceWithChild();

    // 真机缺陷（指令 2 的漏网来源）：fillParams 参数填充 / secondary 门禁子代理由引擎
    // 经 `ctx.subagents.startContinuable` 自建，其 childId **不落 executedSteps**；settle
    // 时 live 会话即被 dispose（`sessions.get` 读不到）→ 旧判据①②双双落空 → 通知放行
    // → 宿主主代理被唤醒（真机表现：工作流仍在跑却多出一条「进展更新」）。
    // 修复：`session/created` 登记表（判据③）在**创建时**记录归属，与被 dispose 无关。
    ctx.emit('session/created' as 'sandore/subagent-settled', {
      header: { id: 'gate-child', parentSession: instanceId },
    } as never);
    // live 会话不存在（模拟 settle 后 dispose）——旧判据必然落空。
    expect(sessions.get('gate-child')).toBeUndefined();

    const next = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] }));
    const decision = await dispatchPreStep(ctx, instanceId, next, [childMessage('gate-child')]);
    expect(decision).toEqual({ kind: 'reject' });
    expect(next).not.toHaveBeenCalled();

    await engine.abortInstance(instanceId);
  });

  it('parks an unregistered auxiliary child via the durable-parentage fallback (persistence header)', async () => {
    const { ctx, engine, sessionPersistence, instanceId } = await runningInstanceWithChild();

    // 判据⑤（持久化兜底）：登记监听晚于子会话创建 / 进程重启后遗留的辅助子代理——
    // 登记表为空、live 会话已 dispose，只有持久化 header 能证明它是本实例的子会话。
    sessionPersistence.inspect = async (id: string) => (id === 'orphan-child'
      ? { header: { id: 'orphan-child', parentSession: instanceId } }
      : undefined);

    const next = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] }));
    const decision = await dispatchPreStep(ctx, instanceId, next, [childMessage('orphan-child')]);
    expect(decision).toEqual({ kind: 'reject' });
    expect(next).not.toHaveBeenCalled();

    await engine.abortInstance(instanceId);
  });

  it('does not park a foreign sender even when persistence says nothing about it (no over-parking)', async () => {
    const { ctx, engine, sessionPersistence, instanceId } = await runningInstanceWithChild();
    // inspect 命中别的 parent（如别的实例的宿主会话）→ 不属本实例 → 放行。
    sessionPersistence.inspect = async (id: string) => ({ header: { id, parentSession: 'another-host-session' } });

    const next = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] }));
    const decision = await dispatchPreStep(ctx, instanceId, next, [childMessage('foreign-child')]);
    expect(decision.kind).toBe('enter');
    expect(next).toHaveBeenCalledTimes(1);

    await engine.abortInstance(instanceId);
  });

  it('lets a user message through (host agent keeps its autonomy)', async () => {
    const { ctx, engine, instanceId } = await runningInstanceWithChild();

    const userMessage = { id: 'u1', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } };
    const next = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [userMessage] }));
    const decision = await dispatchPreStep(ctx, instanceId, next, [userMessage]);
    expect(decision).toEqual({ kind: 'enter', messages: [userMessage] });
    expect(next).toHaveBeenCalledTimes(1);

    await engine.abortInstance(instanceId);
  });

  it('lets ask/permission related input through (they are not child-subagent inbox messages)', async () => {
    const { ctx, engine, instanceId } = await runningInstanceWithChild();

    // ask/permission 卡片走 DSH user-interaction 通道（userQuestions.ask / 审批弹窗），
    // 不经 inbox；此处以「非子代理来源的 plugin/user-message」代表用户可答输入。
    const card = { id: 'q1', content: [{ type: 'text', text: 'answer me' }], source: { kind: 'plugin', plugin: 'dsh-user-questions' } };
    const next = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [card] }));
    const decision = await dispatchPreStep(ctx, instanceId, next, [card]);
    expect(decision).toEqual({ kind: 'enter', messages: [card] });
    expect(next).toHaveBeenCalledTimes(1);

    await engine.abortInstance(instanceId);
  });

  it('lets messages from other agents through (other instances / DSH subagents / unknown shape)', async () => {
    const { ctx, engine, instanceId } = await runningInstanceWithChild();

    const foreign = [
      // 别的 sandore 实例（或 DSH 自己的子代理）的结算通知：senderSessionId 不属本实例。
      childMessage('child-of-another-instance'),
      // source 形状不完整（无 senderSessionId）：无法归属 → 放行（宁可多一次唤醒也不吞消息）。
      { id: 'm2', content: [], source: { kind: 'subagent-settled' } },
    ];
    const next = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: foreign }));
    const decision = await dispatchPreStep(ctx, instanceId, next, foreign);
    expect(decision.kind).toBe('enter');
    expect(next).toHaveBeenCalledTimes(1);

    await engine.abortInstance(instanceId);
  });

  it('mixed batch: removes only this instance children messages, the user message still enters', async () => {
    const { ctx, engine, instanceId, childId } = await runningInstanceWithChild();

    const userMessage = { id: 'u2', content: [{ type: 'text', text: 'steer' }], source: { kind: 'user' } };
    const next = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] }));
    const decision = await dispatchPreStep(ctx, instanceId, next, [userMessage, childMessage(childId)]);
    expect(decision.kind).toBe('enter');
    expect(decision.kind === 'enter' ? decision.messages : []).toEqual([userMessage]);
    expect(next).not.toHaveBeenCalled();

    await engine.abortInstance(instanceId);
  });

  it('judgement ②: a child session whose header.parentSession is this host session is parked even before it lands in executedSteps', async () => {
    const { ctx, engine, persistence, sessions, agents, subagents, instanceId } = await runningInstanceWithChild();

    // 引擎自建但未落 executedSteps 的子代理（fillParams / secondary 门禁）：只有会话 header 可判归属。
    const extra = sessions.create('gate-child');
    (extra as unknown as { header?: { parentSession?: string } }).header = { parentSession: instanceId };
    expect(persistence.state.get(instanceId)?.executedSteps.some(s => s.sessionMeta?.childId === 'gate-child')).toBe(false);

    const next = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] }));
    const decision = await dispatchPreStep(ctx, instanceId, next, [childMessage('gate-child')]);
    expect(decision).toEqual({ kind: 'reject' });
    expect(next).not.toHaveBeenCalled();

    expect(agents.get(instanceId)).toBeDefined();
    await engine.abortInstance(instanceId);
    expect(subagents.childStatus('child-1')).toBeDefined();
  });

  it('does not touch a step subagent own pre-step (park only applies to the host session)', async () => {
    const { ctx, engine, instanceId, childId } = await runningInstanceWithChild();

    const next = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] }));
    const decision = await dispatchPreStep(ctx, childId, next, [childMessage(childId)]);
    expect(decision).toEqual({ kind: 'enter', messages: [] });
    expect(next).toHaveBeenCalledTimes(1);

    await engine.abortInstance(instanceId);
  });

  it('passes child messages through once the instance is terminal (one wake for the final report)', async () => {
    const { ctx, engine, persistence, shell } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    shell.runHandler = async spec => successResult(spec, 'hi');
    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-shell-only', originalInput: 'do it', cwd: '/tmp' });
    await ended;
    expect(persistence.state.get(run.instanceId)?.status).toBe('completed');

    const next = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] }));
    const decision = await dispatchPreStep(ctx, run.instanceId, next, [childMessage('child-x')]);
    expect(decision).toEqual({ kind: 'enter', messages: [] });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('engine wakes the host session exactly once when the instance reaches a terminal state', async () => {
    const { ctx, engine, persistence, agents, shell } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    shell.runHandler = async spec => successResult(spec, 'hi');
    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-shell-only', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    const host = agents.get(run.instanceId)!;
    // followup #1 = 协作上下文注入（决策 4）；followup #2 = 终态收尾通知（决策 2 闭环）——
    // 即整个实例生命周期只额外唤醒宿主一次（每个 Step 的结算通知已被 park）。
    const texts = host.followups.map(call => (call.content[0] as TextBlock).text);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('sandore_workflow_run');
    expect(texts[1]).toContain('[sandore 工作流]');
    expect(texts[1]).toContain('status=completed');
    // 两条消息都必须是上下文注入 source（本轮用户反馈：原先是右侧用户气泡）。
    // 唤醒语义不受 source 影响——由 followup（next-turn + 唤醒驱动）决定。
    expect(host.followups.map(call => call.source)).toEqual([
      { kind: 'plugin', plugin: 'dsh-sandore', form: 'notice', summary: expect.stringContaining('sandore_workflow_run') },
      { kind: 'plugin', plugin: 'dsh-sandore', form: 'notice', summary: expect.stringContaining('status=completed') },
    ]);
  });

  it('steers the BUSY host session on the terminal notice instead of opening an extra turn', async () => {
    const { ctx, engine, persistence, agents, shell } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    // 门控 shell：把实例停在「执行中」，好在终态通知发出前把宿主置为忙（status='running'）。
    let releaseShell: (() => void) | undefined;
    const shellGate = new Promise<void>(resolve => { releaseShell = resolve; });
    let enteredShell: (() => void) | undefined;
    const shellEntered = new Promise<void>(resolve => { enteredShell = resolve; });
    shell.runHandler = async spec => {
      enteredShell?.();
      await shellGate;
      return successResult(spec, 'hi');
    };
    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-shell-only', originalInput: 'do it', cwd: '/tmp' });
    await shellEntered;

    // 宿主主代理此刻正忙（turn 未结束）：终态通知必须 `steer`（并进当前 turn 的**下一步**），
    // 不能 `followup`（next-turn：排在当前 turn 之后，宿主忙时要等整个 turn 才取，既多造一个
    // turn 又与 DSH `SubagentContinuationManager.notifySettlement` 的分流口径分叉——
    // `continuation.ts:1574-1577`）。
    const host = agents.get(run.instanceId)!;
    host.status = 'running';
    releaseShell!();
    await ended;

    // followup 只剩启动期那一次协作上下文注入；终态通知改走 steer → 不额外开 turn。
    expect(host.followups).toHaveLength(1);
    expect((host.followups[0]!.content[0] as TextBlock).text).toContain('sandore_workflow_run');
    expect(host.steers).toHaveLength(1);
    const steered = (host.steers[0]!.content[0] as TextBlock).text;
    expect(steered).toContain('[sandore 工作流]');
    expect(steered).toContain('status=completed');
    // 呈现形态与 followup 通道一致（左侧「上下文注入」行，而非右侧用户气泡）。
    expect(host.steers[0]!.source).toEqual({
      kind: 'plugin',
      plugin: 'dsh-sandore',
      form: 'notice',
      summary: expect.stringContaining('status=completed'),
    });
  });

  it('child output stays accounted for even though its inbox notice is consumed (engine-side channel)', async () => {
    const { ctx, engine, persistence, llm, agents, subagents } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);
    provideLlmDirectory(llm);
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'step result' }]));
    child.status = 'idle';
    agents.register(child);
    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-agent-fail', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    // 结算通知被 park（丢弃）不影响账目：子代理输出经引擎自己的 settle 通道落到快照。
    const step = persistence.state.get(run.instanceId)?.executedSteps.find(s => s.stepId === 'step-agent');
    expect(step?.output).toEqual([{ type: 'text', text: 'step result' }]);
    expect(subagents.settlements.map(s => s.childId)).toContain('child-1');
  });
});

/**
 * 架构决策 6：宿主会话 turn 被用户中断（输入框「停止生成」）→ 实例 paused。
 *
 * DSH 语义（查证）：输入框按钮 = `input.stop`（停止生成），会话级动作经 `session.cancel`
 * → `agent.cancel({kind:'user'},{keepInbox:true})` abort 当前 turn，**DSH 没有「暂停会话」
 * 能力**。可观测信号 = `session/event` 的 `turn/end` + `reason.kind==='aborted'` +
 * `reason.reason.kind==='user'`（`user` 才代表用户点了停止生成）。本插件把该信号解释为
 * 「暂停本工作流实例」——**这是本插件附加的语义**。
 */
describe('SandoreEngineRuntime host turn abort（架构决策 6：停止生成 → 实例 paused）', () => {
  /** 模拟 DSH 分发一次 `session/event`（宿主会话的 turn/end）。 */
  function dispatchSessionEvent(ctx: Context, sessionId: string, reason: unknown): void {
    const thisArg = { [Context.filter]: () => true };
    (ctx.emit as unknown as (thisArg: object, name: string, session: unknown, event: unknown) => void)(
      thisArg,
      'session/event',
      { id: sessionId },
      { type: 'turn/end', data: { turn: 1, reason } },
    );
  }

  it('pauses the instance when the host session turn is aborted by the user', async () => {
    const { ctx, engine, persistence, llm, agents, subagents } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);
    provideLlmDirectory(llm);
    const child = new FakeAgent('child-1');
    child.status = 'running';
    agents.register(child);
    const stepStarted = waitForStepStart(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-agent-fail', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;
    await vi.waitFor(() => {
      const step = persistence.state.get(run.instanceId)?.executedSteps.find(s => s.stepId === 'step-agent');
      expect(step?.status).toBe('running');
    });

    dispatchSessionEvent(ctx, run.instanceId, { kind: 'aborted', reason: { kind: 'user' } });
    await vi.waitFor(() => {
      expect(persistence.state.get(run.instanceId)?.status).toBe('paused');
    });
    // 走既有 pause 路径：interrupt 运行中 Step 子代理（ancestor authority）+ 登记表。
    expect(subagents.interrupts.some(call => call.targetSessionId === 'child-1')).toBe(true);
    expect(persistence.state.get(run.instanceId)?.pausedChildIds).toEqual(['child-1']);

    await engine.abortInstance(run.instanceId);
  });

  it('ignores aborted turns from other causes and from other sessions', async () => {
    const { ctx, engine, persistence, llm, agents } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);
    provideLlmDirectory(llm);
    const child = new FakeAgent('child-1');
    child.status = 'running';
    agents.register(child);
    const stepStarted = waitForStepStart(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-agent-fail', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;

    // ① 非 user 原因（disposed/parent/hook）不触发暂停。
    dispatchSessionEvent(ctx, run.instanceId, { kind: 'aborted', reason: { kind: 'disposed' } });
    dispatchSessionEvent(ctx, run.instanceId, { kind: 'aborted', reason: { kind: 'parent' } });
    // ② 正常结束的 turn 不触发。
    dispatchSessionEvent(ctx, run.instanceId, { kind: 'completed' });
    // ③ 别的会话（非本实例宿主）不触发。
    dispatchSessionEvent(ctx, 'some-other-session', { kind: 'aborted', reason: { kind: 'user' } });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(persistence.state.get(run.instanceId)?.status).toBe('running');
    expect(persistence.state.get(run.instanceId)?.pausedChildIds).toEqual([]);

    await engine.abortInstance(run.instanceId);
  });
});

describe('SandoreEngineRuntime recoverInstance（入口归一后的单一路径：agents.resume(instanceId)）', () => {
  it('cold-resumes the host agent of the instance id (no reuse branch anymore)', async () => {
    const { ctx, engine, persistence, sessions, shell } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    shell.runHandler = async spec => successResult(spec, 'hello');
    // 空 executedSteps 的 running 快照：recoverInstance 冷恢复宿主主代理后重跑 runInstance。
    await persistence.state.put('inst-rec-2', runningSnapshot('inst-rec-2', 'wfl-shell-only'));
    sessions.create('inst-rec-2');

    const ended = waitForEnd(ctx);
    const result = await engine.recoverInstance('inst-rec-2');
    expect(result.status).toBe('running');
    await ended;
    expect(persistence.state.get('inst-rec-2')?.status).toBe('completed');
  });

  it('recovery creates NO new subagent sessions (freshness is a creation-time property)', async () => {
    const { ctx, engine, persistence, sessions, subagents, shell } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    shell.runHandler = async spec => successResult(spec, 'hello');
    await persistence.state.put('inst-rec-fresh', runningSnapshot('inst-rec-fresh', 'wfl-shell-only'));
    sessions.create('inst-rec-fresh');
    const startsBefore = subagents.continuableStarts.length;

    const ended = waitForEnd(ctx);
    await engine.recoverInstance('inst-rec-fresh');
    await ended;

    // 崩溃恢复路径**不创建**新子代理：既有子代理会话经 queue 投递冷恢复（followup），
    // 会话种子在创建时即已定格（用 fresh provider → 无父历史）→ 恢复后依然 fresh。
    expect(subagents.continuableStarts.length).toBe(startsBefore);
  });

  it('keeps a pending instance pending on recovery (execution still waits for the host run call)', async () => {    const { ctx, engine, persistence, sessions, shell } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    // pending 快照：overlay 新建后宿主会话还没调用 run 就重启（两阶段语义）。
    await persistence.state.put('inst-pending', {
      ...runningSnapshot('inst-pending', 'wfl-shell-only'),
      status: 'pending',
    });
    sessions.create('inst-pending');
    shell.runHandler = async spec => successResult(spec, 'hi');

    const result = await engine.recoverInstance('inst-pending');
    expect(result.status).toBe('pending');
    // 未自动执行：没有任何 Step 快照。
    expect(persistence.state.get('inst-pending')?.executedSteps).toEqual([]);

    // 宿主会话随后调 run 仍能开跑（同一槽位）。
    const started = await engine.runInstanceInSession('inst-pending', {
      workflowId: 'wfl-shell-only',
      originalInput: 'do it',
      cwd: '/tmp',
    });
    expect(started.status).toBe('running');
    await waitForEnd(ctx);
    expect(persistence.state.get('inst-pending')?.status).toBe('completed');
  });

  it('fails fast with a readable error when the host session of the instance cannot be resumed', async () => {    const { engine, persistence, agents } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    await persistence.state.put('inst-rec-ghost', runningSnapshot('inst-rec-ghost', 'wfl-shell-only'));
    // 会话未发布 → resume 后 ctx.sessions.get 读不到 → INVALID_OPERATION。
    agents.createError = undefined;
    await expect(engine.recoverInstance('inst-rec-ghost'))
      .rejects.toMatchObject({ code: 'INVALID_OPERATION' });
  });
});

describe('SandoreEngineRuntime setPermissionMode', () => {
  /**
   * 折叠读取 session.events 中最新 `sandbox/mode` 事件的 mode（对齐 DSH
   * `setSandboxMode` 折叠语义：每次受限调用取最新 sandbox/mode 事件值，
   * 而非创建时快照）。缺陷 29 验证运行中切换后宿主会话折叠值即时变化。
   */
  function effectiveSandboxMode(events: ReadonlyArray<{ type: string; data: unknown }>): string | undefined {
    let mode: string | undefined;
    for (const event of events) {
      if (event.type === 'sandbox/mode' && event.data !== null && typeof event.data === 'object'
        && 'mode' in (event.data as Record<string, unknown>)) {
        mode = (event.data as { mode: string }).mode;
      }
    }
    return mode;
  }

  /** 让 shell step 挂起（直到 abort signal 触发 finish），保持实例 running 不进入终态。 */
  function hangingShell(shell: FakeShell): void {
    shell.runHandler = spec => new Promise(resolve => {
      const finish = (): void => { resolve(successResult(spec, '')); };
      if (spec.signal?.aborted) { finish(); return; }
      spec.signal?.addEventListener('abort', finish, { once: true });
    });
  }

  it('re-applies sandbox mode on the host session and persists state.permission (缺陷 29)', async () => {
    const { ctx, engine, persistence, shell, sessions } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);
    hangingShell(shell);
    const stepStarted = waitForStepStart(ctx);

    const run = await startWorkflow(engine, { workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp', permission: 'read-only' });
    await stepStarted;
    const session = sessions.get(run.instanceId)!;

    // 创建时应用 read-only：宿主 session 含 sandbox/mode=read-only 事件，快照 permission=read-only。
    expect(effectiveSandboxMode(session.events)).toBe('read-only');
    expect(persistence.state.get(run.instanceId)?.permission).toBe('read-only');

    // 运行中切换到 workspace-write（复用 applyPermission 可重入：追加 sandbox/mode
    // 事件 + setPolicy，DSH 折叠读取取最新，幂等重放不累积副作用）。
    await engine.setPermissionMode(run.instanceId, 'workspace-write');

    // 宿主 session 新增 sandbox/mode=workspace-write 事件（折叠后 effectiveSandboxMode 变化）。
    expect(effectiveSandboxMode(session.events)).toBe('workspace-write');
    // 快照 permission 同步更新并持久化（UI 列表/详情可读当前权限；recoverInstance 靠
    // session 事件重放恢复权限，快照字段保持一致避免漂移）。
    expect(persistence.state.get(run.instanceId)?.permission).toBe('workspace-write');

    await engine.abortInstance(run.instanceId);
  });

  it('throws NODE_NOT_FOUND for an unknown instance (缺陷 29)', async () => {
    const { engine } = await harness();
    await expect(engine.setPermissionMode('inst-none', 'read-only')).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
  });

  it('rejects a terminal instance with INVALID_OPERATION (缺陷 29)', async () => {
    const { ctx, engine, persistence, llm, shell } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);
    shell.runHandler = async spec => successResult(spec, 'hello');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    llm.streamHandler = () => textChunks('summary');

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp', permission: 'read-only' });
    await ended;

    await expect(engine.setPermissionMode(run.instanceId, 'workspace-write')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
  });

  // ── 子代理快照契约（SA8 核实要求固化）──────────────────────────────────
  // sandore Step 以子代理运行（step-runner.ts startContinuable，parent=宿主），委派时
  // 快照宿主 sandbox+approval。故运行中切换权限对【宿主会话】与【切换后新委派的
  // Step】即时生效，但【已运行 Step 子代理】保持其委派时的权限快照——与基准
  // 「StepRunner 闭包 `() => this._permissionMode` 每次权限请求读最新值」语义不同。
  // 此为既定架构差异，非缺陷。mock 不模拟真实 sandbox 折叠，故以「setPermissionMode
  // 不触及 subagents 任何调用路径」+「宿主 effectiveSandboxMode 即时变化」为可观测契约
  // 代理指标，固化「已委派子代理快照不被运行中切换回溯」的语义边界。
  it('subagent delegation snapshot is not retroactively changed by runtime switch (缺陷 29 架构差异, 非缺陷)', async () => {
    const { ctx, engine, persistence, shell, sessions, subagents } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);
    hangingShell(shell);
    const stepStarted = waitForStepStart(ctx);

    const run = await startWorkflow(engine, { workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp', permission: 'read-only' });
    await stepStarted;
    const session = sessions.get(run.instanceId)!;

    // 委派时刻基线：宿主会话 effectiveSandboxMode=read-only（子代理在 startContinuable
    // 时快照此值——已运行 Step 子代理的权限请求按此旧值判定）。
    expect(effectiveSandboxMode(session.events)).toBe('read-only');
    const startsBefore = subagents.continuableStarts.length;

    // 运行中切换到 workspace-write。
    await engine.setPermissionMode(run.instanceId, 'workspace-write');

    // ①宿主会话 effectiveSandboxMode 即时变为 workspace-write（折叠读取最新事件）。
    //    切换后新委派的 Step 在 startContinuable 时会快照此新值 → 即时生效。
    expect(effectiveSandboxMode(session.events)).toBe('workspace-write');

    // ②setPermissionMode 不触及 subagents 任何调用路径：不触发新子代理委派、不
    //    followup、不 interrupt 已运行子代理。sandore 子代理在 startContinuable 时
    //    快照宿主 sandbox+approval，运行中切换只对宿主会话追加 sandbox/mode 事件，
    //    不回溯已委派子代理——故已运行 Step 子代理的委派快照保持其创建时的值
    //    （权限请求仍按旧模式判定）。【架构差异 vs 基准】基准 StepRunner 以闭包
    //    `() => this._permissionMode` 每次权限请求读最新值，运行中切换对已运行 Step
    //    也即时生效；sandore 因子代理委派快照机制，已运行 Step 保持旧快照。此差异
    //    为既定架构，非缺陷。
    expect(subagents.continuableStarts.length).toBe(startsBefore);
    expect(subagents.followups).toHaveLength(0);
    expect(subagents.interrupts).toHaveLength(0);

    await engine.abortInstance(run.instanceId);
  });
});

describe('SandoreEngineRuntime DAG execution', () => {
  it('routes branches, runs the loop, extracts pass-through vars and passes the gate to completed', async () => {
    const { ctx, engine, persistence, llm, shell, subagents, agents } = await harness();
    await putDefinition(persistence, 'wfl-dag', dagYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);

    // 条件分支评估（批量 shouldExecute 分支 id 数组）→ agent 执行 → prompt 执行（子代理）→
    // 收尾 Phase A assess（hasAsk 格式）→ Phase B 真 fork/降级（compressedOutput 合并
    // JSON，偏离 2：不复用 Phase A 结果）。primary 门禁为纯代码产物校验（零 AI）。
    // 按首条消息文本分发：shouldExecute → 批量分支 JSON；compressedOutput → Phase B 收尾 JSON；
    // 其余（hasAsk）→ Phase A 评估 JSON。
    llm.streamHandler = (options) => {
      const text = (options.messages[0]?.content[0] as TextBlock | undefined)?.text ?? '';
      if (text.includes('shouldExecute')) {
        // Round 20：批量模板——返回满足条件的分支 id 数组（branchId = branch.next）。
        return textChunks('{"shouldExecute": ["step-agent"]}');
      }
      if (text.includes('compressedOutput')) {
        return textChunks('{"passThroughVars":{"projectName":"sandore"},"compressedOutput":"finalize 摘要"}');
      }
      return textChunks('{"hasAsk":false,"passThroughVars":{"projectName":"sandore"}}');
    };

    // agent Step 走可续接子代理：注册真实 childId 并回填最终 assistant 输出。
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'agent output' }]));
    agents.register(child);
    // prompt Step（step-finalize）同为真实子代理（决策 D3）：childId=child-2。
    const promptChild = new FakeAgent('child-2');
    promptChild.session.append(assistantMessageEvent([{ type: 'text', text: 'report done' }]));
    agents.register(promptChild);

    const records = recordSandoreEvents(ctx);
    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-dag', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');

    // 分支路由：匹配 agent 分支 + 并行分支；回退分支未执行；汇合节点仅执行一次。
    // 注：基准模型下路由门+body 的 body 跑 maxIter-1 次（loop head 每 visit 一次，
    // 末次 break 不路由到 body），故 step-loop(maxIter=3) 的 body(step-iter) 跑 2 次。
    const stepIds = state?.executedSteps.map(step => step.stepId);
    expect(stepIds).toEqual([
      'step-branch',
      'step-parallel',
      'step-agent',
      'step-merge',
      'step-iter',
      'step-iter',
      'step-finalize',
    ]);
    expect(stepIds?.filter(id => id === 'step-fallback')).toHaveLength(0);
    expect(stepIds?.filter(id => id === 'step-merge')).toHaveLength(1);

    // 分支决策点保留 branchMeta 评估现场（批量 shouldExecute 分支 id 数组判定输出）。
    const branchEntry = state?.executedSteps.find(step => step.stepId === 'step-branch');
    expect(branchEntry?.branchMeta?.status).toBe('completed');
    expect(branchEntry?.branchMeta?.result).toBe('{"shouldExecute": ["step-agent"]}');

    // agent Step：真实 childId（synthetic:false）+ hostSessionId（parent）+ 子代理最终输出。
    const agentStep = state?.executedSteps.find(step => step.stepId === 'step-agent');
    expect(agentStep?.sessionMeta).toEqual({
      childId: 'child-1',
      synthetic: false,
      command: 'agent',
      hostSessionId: run.instanceId, // overlay 新建宿主：parent = taskId = instanceId
    });
    expect(agentStep?.output).toEqual([{ type: 'text', text: 'agent output' }]);

    // hostAgent 注入：agent Step 的子代理 parent 即宿主主代理（id = instanceId）。
    expect(subagents.continuableStarts[0]?.request.parent.id).toBe(run.instanceId);

    // 循环：2 次扁平迭代（路由门 body 跑 maxIter-1 次），loopIteration 嵌套路径；
    // 段 id 为纯 UUID（§3.3）；loop body 为 shell（不建子代理，2026-09-09）→
    // sessionMeta 无 childId、synthetic:true。
    const iterations = state?.executedSteps.filter(step => step.stepId === 'step-iter') ?? [];
    expect(iterations.map(step => step.loopIteration)).toEqual([[1], [2]]);
    expect(iterations[0]?.id).toMatch(UUID_RE);
    expect(iterations[0]?.sessionMeta?.synthetic).toBe(true);
    expect(iterations[0]?.sessionMeta?.childId).toBeUndefined();
    expect(iterations[1]?.visitCount).toBe(2);

    // 透传变量回写：finalize 提取 projectName 并保留 description。
    expect(state?.passThroughVars['projectName']).toEqual({ value: 'sandore', description: '项目名' });

    // 门禁通过（primary 纯代码产物校验，无 outputTo → 通过；无 secondary → 零门禁 AI）：
    // finalizeMeta 记录 gateResult + currentPhase='completed'。
    const finalizeStep = state?.executedSteps.find(step => step.stepId === 'step-finalize');
    expect(finalizeStep?.finalizeMeta?.gateResult?.gatesPassed).toBe(true);
    expect(finalizeStep?.finalizeMeta?.gateResult?.primaryPassed).toBe(true);
    expect(finalizeStep?.finalizeMeta?.currentPhase).toBe('completed');

    // llm 调用覆盖：条件分支 1 + Phase A assess 1 + Phase B 重新 assess 1 = 3 次
    // （primary 纯代码校验零 AI；prompt Step 输出来自子代理会话，不消费 llm.stream）。
    expect(llm.calls).toHaveLength(3);

    // agent Step 的 step-completed 事件载荷：真实 childId + 最终 output + name；
    // 非循环 Step 无 loopIteration。
    const agentCompleted = records.find(record => record.name === 'sandore/step-completed' && record.args[1] === 'step-agent');
    expect(agentCompleted?.args[2]).toBe('child-1');
    expect(agentCompleted?.args[3]).toEqual([{ type: 'text', text: 'agent output' }]);
    expect(agentCompleted?.args[4]).toBe('step-agent');
    expect(agentCompleted?.args[5]).toBeUndefined();

    // 循环内 Step 的 step-completed 事件载荷：name + 扁平迭代路径（末尾位置）。
    const iterCompleted = records.filter(record => record.name === 'sandore/step-completed' && record.args[1] === 'step-iter');
    expect(iterCompleted.map(record => record.args[4])).toEqual(['step-iter', 'step-iter']);
    expect(iterCompleted.map(record => record.args[5])).toEqual([[1], [2]]);

    // 两 Stage 均 completed，契约落盘。
    expect(state?.stageInfos.map(info => info.status)).toEqual(['completed', 'completed']);
    expect(Object.keys(state?.stageContracts ?? {})).toHaveLength(2);
  });

  it('falls back to array order and preserves branchMeta when no branch matches', async () => {
    const { ctx, engine, persistence, llm, shell } = await harness();
    await putDefinition(persistence, 'wfl-branch-fallback', branchFallbackYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    // Round 20：批量模板——空数组 = 无分支命中。
    llm.streamHandler = () => textChunks('{"shouldExecute": []}');

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-branch-fallback', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    const stepIds = state?.executedSteps.map(step => step.stepId);
    expect(stepIds).toEqual(['step-branch', 'step-fallback', 'step-matched']);

    // branchMeta 保留原始评估结果（空数组证明条件分支未命中）。
    const branchEntry = state?.executedSteps.find(step => step.stepId === 'step-branch');
    expect(branchEntry?.branchMeta?.status).toBe('completed');
    expect(branchEntry?.branchMeta?.result).toBe('{"shouldExecute": []}');
  });

  it('retries an AI condition branch when the first output is unparseable then passes on the retry', async () => {
    const { ctx, engine, persistence, llm, shell } = await harness();
    await putDefinition(persistence, 'wfl-branch-fallback', branchFallbackYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    // 首轮返回乱码（不可解析 shouldExecute 数组）→ evaluateConditions 触发 follow-up
    // 重试 → 第二轮返回合法分支 id 数组（branchId = branch.next = step-matched）。
    const responses = ['I cannot decide', '{"shouldExecute": ["step-matched"]}'];
    let callIndex = 0;
    llm.streamHandler = () => textChunks(responses[callIndex++] ?? '');

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-branch-fallback', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');

    // 重试后条件通过 → step-matched 执行；step-fallback 未命中（条件分支优先于数组兜底）。
    const stepIds = state?.executedSteps.map(step => step.stepId);
    expect(stepIds).toEqual(['step-branch', 'step-matched']);

    // 条件评估共 2 次 llm.stream 调用（首轮乱码 + 1 次纠正重试）。
    expect(llm.calls).toHaveLength(2);
    const branchEntry = state?.executedSteps.find(step => step.stepId === 'step-branch');
    expect(branchEntry?.branchMeta?.status).toBe('completed');
    expect(branchEntry?.branchMeta?.result).toBe('{"shouldExecute": ["step-matched"]}');
  });

  it('falls back to array order when an AI condition branch exhausts shouldExecute retries', async () => {
    const { ctx, engine, persistence, llm, shell } = await harness();
    await putDefinition(persistence, 'wfl-branch-fallback', branchFallbackYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    // 始终返回乱码：首轮 + MAX_BRANCH_EVAL_RETRIES(2) 次重试均不可解析 → 兜底 false。
    llm.streamHandler = () => textChunks('totally not json');

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-branch-fallback', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');

    // 重试耗尽 → 条件未通过 → 数组顺序兜底 step-fallback；step-matched 未执行。
    const stepIds = state?.executedSteps.map(step => step.stepId);
    expect(stepIds).toEqual(['step-branch', 'step-fallback', 'step-matched']);

    // 条件评估共 3 次 llm.stream 调用（首轮 + 2 次重试）。
    expect(llm.calls).toHaveLength(3);
    const branchEntry = state?.executedSteps.find(step => step.stepId === 'step-branch');
    expect(branchEntry?.branchMeta?.status).toBe('completed');
    expect(branchEntry?.branchMeta?.result).toBe('totally not json');
  });

  it('executes nested loops fully on every outer iteration (inner loop visitCount resets)', async () => {
    const { ctx, engine, persistence, shell } = await harness();
    await putDefinition(persistence, 'wfl-nested-loop', nestedLoopYaml);
    shell.runHandler = async spec => successResult(spec, 'iter');

    const records = recordSandoreEvents(ctx);
    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-nested-loop', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');

    // 基准模型：路由门 body 跑 maxIter-1 次。外层 maxIter=3 → 外层 body(内层循环) 跑 2
    // 次（外层 visit 1、2 继续，visit 3 跳出）；内层 maxIter=3 → 内层 body 跑 2 次。
    // 故 (3-1)×(3-1)=4 次 body 执行，loopIteration 路径 [[1,1],[1,2],[2,1],[2,2]]。
    // 外层重入内层时内层 visitCount 经 resetLoopVisitCounts 从 0 起重新计数
    // （跳出时归零作用域语义），验证嵌套重入不残留旧计数。
    const iterations = state?.executedSteps.filter(step => step.stepId === 'step-iter') ?? [];
    expect(iterations.map(step => step.loopIteration)).toEqual([[1, 1], [1, 2], [2, 1], [2, 2]]);

    // 事件 payload 的 loopIteration 为嵌套完整路径数组（与 state 快照一致）。
    const iterCompleted = records.filter(record => record.name === 'sandore/step-completed' && record.args[1] === 'step-iter');
    expect(iterCompleted.map(record => record.args[5])).toEqual([[1, 1], [1, 2], [2, 1], [2, 2]]);
  });

  it('runs the loop to maxIterations when the output-driven breakCondition never signals done', async () => {
    const { ctx, engine, persistence, llm, shell } = await harness();
    await putDefinition(persistence, 'wfl-loop-break', loopBreakYaml);
    shell.runHandler = async spec => successResult(spec, 'iter');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    // fork-based 改造（缺陷 4）：breakCondition 走 fork 会话注入全量历史；step-iter 为 shell
    // 合成 session（无真实 session 可 fork）→ 判断降级为临时会话（judgePrompt 不含手动 I/O 块）。
    // mock 恒返回 shouldBreak=false → 每趟不跳 → 跑满 maxIter=5 后硬上限 break。
    llm.streamHandler = () => textChunks('{"shouldBreak": false}');

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-loop-break', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    // 循环体 step-iter 跑 maxIter-1 次（visit 1..4 继续，visit 5 硬上限 break）。
    const iterations = state?.executedSteps.filter(step => step.stepId === 'step-iter') ?? [];
    expect(iterations).toHaveLength(4);
    // 跑满 maxIter 后跳出，进入 step-done 收尾。
    expect(state?.executedSteps.some(step => step.stepId === 'step-done')).toBe(true);
    // fork-based 改造：breakCondition 走专用 shouldBreak 模板（不再手动注入 I/O 块——
    // shell step 降级为临时会话，AI 依据 promptText 判断）。
    const breakPrompt = llm.calls
      .map(call => (call.messages[0]?.content[0] as TextBlock | undefined)?.text ?? '')
      .find(text => text.includes('shouldBreak'));
    expect(breakPrompt).toBeDefined();
  });

  it('runs a command-gate loop exactly maxIterations times (loop head carries a command)', async () => {
    const { ctx, engine, persistence, shell } = await harness();
    await putDefinition(persistence, 'wfl-loop-command-gate', loopCommandGateYaml);
    shell.runHandler = async spec => successResult(spec, 'loop');

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-loop-command-gate', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');

    // 命令门（loop head 自带 command + 自回边）：基准模型 maxIter = loop head 被 visit
    // 的次数，命令门每 visit 一次就跑一次 command → 命令跑 maxIter 次。visitCount 递增
    // 已统一移至 runLoop（单一递增点），checkLoopBreak 只读，根治双重计数。
    const iterations = state?.executedSteps.filter(step => step.stepId === 'step-loop') ?? [];
    expect(iterations).toHaveLength(3);
    // 跳出后进入 step-done 收尾。
    expect(state?.executedSteps.some(step => step.stepId === 'step-done')).toBe(true);
  });

  it('runs a command-gate loop exactly N times for maxIter=N (1..6)', async () => {
    const { ctx, engine, persistence, shell } = await harness();
    shell.runHandler = async spec => successResult(spec, 'loop');

    for (let maxIter = 1; maxIter <= 6; maxIter += 1) {
      const wfId = `wfl-cg-${maxIter}`;
      await putDefinition(persistence, wfId, commandGateYaml(maxIter));

      const ended = waitForEnd(ctx);
      const run = await startWorkflow(engine, { workflowId: wfId, originalInput: 'do it', cwd: '/tmp' });
      await ended;

      const state = persistence.state.get(run.instanceId);
      expect(state?.status).toBe('completed');
      // 命令门：maxIter=N → command 跑 N 次（loop head 每 visit 一次即跑一次 command，
      // 末次 visit 触发 break）。根治修前 maxIter=4 只跑 3 次的双重计数 bug。
      const iterations = state?.executedSteps.filter(step => step.stepId === 'step-loop') ?? [];
      expect(iterations).toHaveLength(maxIter);
      // 跳出后进入 step-done 收尾。
      expect(state?.executedSteps.some(step => step.stepId === 'step-done')).toBe(true);
      // 清理实例避免跨轮干扰。
      persistence.state.delete(run.instanceId);
    }
  });

  it('runs a breakCondition loop exactly maxIterations times when shouldBreak stays false', async () => {
    const { ctx, engine, persistence, llm, shell } = await harness();
    await putDefinition(persistence, 'wfl-loop-break-no-break', loopBreakNoBreakYaml);
    shell.runHandler = async spec => successResult(spec, 'iter');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    llm.streamHandler = () => textChunks('{"shouldBreak": false}');

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-loop-break-no-break', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');

    // breakCondition 门：loop-manager 每趟评估产出 loopMeta，step-navigator continue
    // 与 break 分支均透传 loopMeta（缺陷 23）→ 每次评估都回写对应 step-loop 路由条目。
    // 不双重计数：visitCount 递增仍由 runLoop 单一完成（缺陷 3 已重构），路由条目仅
    // 快照当前值——continue 透传不触发提前跳出。基准模型下路由门 body 跑 maxIter-1 次，
    // 故循环体执行 2 次。
    const iterations = state?.executedSteps.filter(step => step.stepId === 'step-iter') ?? [];
    expect(iterations).toHaveLength(2);
    expect(iterations.map(step => step.loopIteration)).toEqual([[1], [2]]);
  });

  it('writes loopMeta to step-loop routing entries on both continue and break (defect 23)', async () => {
    const { ctx, engine, persistence, llm, shell } = await harness();
    await putDefinition(persistence, 'wfl-loop-break', loopBreakYaml);
    shell.runHandler = async spec => successResult(spec, 'iter');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    // fork-based 改造（缺陷 4）：breakCondition 走 fork 会话注入全量历史；step-iter 为 shell
    // 合成 session（无真实 session 可 fork）→ 判断降级为临时会话。mock：首次评估 false（继续），
    // 第二次评估 true（跳出）——验证 continue 与 break 两条 step-loop 路由条目均回写 loopMeta
    // （缺陷 23：修复前 continue 分支丢弃 outcome.loopMeta，仅 break 条目回写）。
    let breakCall = 0;
    llm.streamHandler = (options) => {
      const text = (options.messages[0]?.content[0] as TextBlock | undefined)?.text ?? '';
      if (text.includes('shouldBreak')) {
        breakCall += 1;
        return textChunks(breakCall === 1 ? '{"shouldBreak": false}' : '{"shouldBreak": true}');
      }
      return textChunks('summary');
    };

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-loop-break', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');

    // 缺陷 23：continue 分支（首评 false）与 break 分支（次评 true）均透传 loopMeta →
    // 两条 step-loop 路由条目均含 loopMeta(completed)。修复前 continue 分支不透传，
    // 仅 break 条目回写（loop-manager.spec L174-175 实证 checkLoopBreak 在 shouldBreak=false
    // 时同样产出 loopMeta(completed)）。
    const loopEntries = state?.executedSteps.filter(step => step.stepId === 'step-loop') ?? [];
    expect(loopEntries).toHaveLength(2);
    expect(loopEntries.every(entry => entry.loopMeta?.status === 'completed')).toBe(true);
    // 两条均携带 shouldBreak 评估现场（continue=false 现场、break=true 现场）。
    expect(loopEntries[0]?.loopMeta?.result).toContain('shouldBreak');
    expect(loopEntries[1]?.loopMeta?.result).toContain('shouldBreak');

    // continue 透传不双重计数回归（缺陷 3 point ② 已由 runLoop 单一递增解决）：
    // 循环体 step-iter 仅在首趟 continue 后跑一次（第二趟 break 直接跳出，未再跑 body）。
    const iterEntries = state?.executedSteps.filter(step => step.stepId === 'step-iter') ?? [];
    expect(iterEntries).toHaveLength(1);
    // 跳出后进入 step-done 收尾。
    expect(state?.executedSteps.some(step => step.stepId === 'step-done')).toBe(true);
  });

  it('runs a mixed-gate loop exactly maxIterations times when the condition branch never matches', async () => {
    const { ctx, engine, persistence, llm, shell } = await harness();
    await putDefinition(persistence, 'wfl-loop-mixed-gate', loopMixedGateYaml);
    shell.runHandler = async spec => successResult(spec, 'iter');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    // 条件分支恒不命中（批量空数组）→ 循环跑到 maxIterations 硬上限。
    llm.streamHandler = () => textChunks('{"shouldExecute": []}');

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-loop-mixed-gate', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');

    // 混合门（condition + loop，isLoopControl=false）：基准模型下路由门 body 跑
    // maxIter-1 次。visitCount 递增已统一移至 runLoop（单一递增点），回边/checkLoopBreak
    // 只读不递增，根治双重计数。故循环体执行 2 次。
    const iterations = state?.executedSteps.filter(step => step.stepId === 'step-iter') ?? [];
    expect(iterations).toHaveLength(2);
    expect(iterations.map(step => step.loopIteration)).toEqual([[1], [2]]);
    // 条件分支恒不命中 → step-exit 未执行；跳出后进入 step-done 收尾。
    expect(state?.executedSteps.some(step => step.stepId === 'step-exit')).toBe(false);
    expect(state?.executedSteps.some(step => step.stepId === 'step-done')).toBe(true);
  });

  it('does not let a later stage default override an earlier stage extracted pass-through var (defect 15)', async () => {
    const { ctx, engine, persistence, llm, shell, agents } = await harness();
    await putDefinition(persistence, 'wfl-cross-stage-ptv', crossStagePtvYaml);
    // shell 回显命令本身，便于断言 step-use 拿到的实际值。
    shell.runHandler = async spec => successResult(spec, spec.command);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    // step-extract 为 prompt Step，走可续接子代理：注册真实 childId 并回填最终输出。
    const promptChild = new FakeAgent('child-1');
    promptChild.session.append(assistantMessageEvent([{ type: 'text', text: 'extracted text' }]));
    agents.register(promptChild);

    // step-extract（prompt）执行 → finalize Phase A assess（hasAsk 格式）+ Phase B 收尾
    // （compressedOutput 合并 JSON）提取 projectName=sandore；Stage 2 step-use 声明同名
    // 默认值 "unknown"（非 \${} 引用 → 不触发 assess）。按首条消息文本分发：
    // compressedOutput → Phase B 收尾 JSON；其余（hasAsk）→ Phase A 评估 JSON。
    llm.streamHandler = (options) => {
      const text = (options.messages[0]?.content[0] as TextBlock | undefined)?.text ?? '';
      if (text.includes('compressedOutput')) {
        return textChunks('{"passThroughVars":{"projectName":"sandore"},"compressedOutput":"摘要"}');
      }
      return textChunks('{"hasAsk":false,"passThroughVars":{"projectName":"sandore"}}');
    };

    const ended = waitForEnd(ctx);
    await startWorkflow(engine, { workflowId: 'wfl-cross-stage-ptv', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    // 残余差异二修复（initState 合并顺序）：Stage 2 step-use 声明同名 projectName
    // 默认值 "unknown"，但合并顺序已改为「input 提取值覆盖定义默认值」→ step-use
    // 拿到 'sandore' 而非被 'unknown' 覆盖。修复前（旧合并顺序：定义值覆盖提取值）
    // 此处为 'echo unknown'，破坏跨 Stage 变量传递链。
    expect(shell.specs.map(spec => spec.command)).toEqual(['echo sandore']);
  });
});

/** 单 Stage prompt Step 带透传变量（触发 finalize assess → ask）。 */
const askYaml = `id: wfl-ask
name: ask
version: "1.0.0"
stages:
  - id: stg-1
    name: 提问
    steps:
      - id: step-ask
steps:
  - id: step-ask
    command:
      type: prompt
      value:
        promptText: "do it"
    passThroughVars:
      - name: projectName
        value: "\${projectName}"
        description: "项目名"
`;

/** 单 Stage 多 Step：step-ask（prompt + 门禁 + 透传变量）触发中途 ask，step-after 为剩余 Step。 */
const askMidYaml = `id: wfl-ask-mid
name: ask-mid
version: "1.0.0"
stages:
  - id: stg-1
    name: 中途提问
    steps:
      - id: step-ask
      - id: step-after
steps:
  - id: step-ask
    command:
      type: prompt
      value:
        promptText: "do it"
    passThroughVars:
      - name: projectName
        value: "\${projectName}"
        description: "项目名"
    gates:
      primary:
        enabled: true
  - id: step-after
    command:
      type: shell
      value:
        command: "echo done"
`;

/**
 * 收尾阶段流转（sandore/step-phase 事件全四相）：
 * step-ask（prompt + 透传变量）触发 ask 保底中断（ask-detect）→ 回答后续跑
 * （finalizing → completed）；step-gate（shell + 门禁 + outputTo 缺失文件）
 * primary 纯代码产物校验不通过（finalizing → gating → Step failed）。
 */
const phaseFlowYaml = `id: wfl-phase-flow
name: phase-flow
version: "1.0.0"
stages:
  - id: stg-1
    name: 收尾阶段
    steps:
      - id: step-ask
      - id: step-gate
steps:
  - id: step-ask
    command:
      type: prompt
      value:
        promptText: "do it"
    passThroughVars:
      - name: projectName
        value: "\${projectName}"
        description: "项目名"
  - id: step-gate
    command:
      type: shell
      value:
        command: "echo gate"
    outputTo:
      - id: opt-a
        path: "missing-report.txt"
    gates:
      primary:
        enabled: true
`;

/** 单 Stage agent Step（子代理 final result 含 [[SANDORE_ASK]] 标记块——双通道 ask 重构后按普通输出透传）。 */
const delegatedAskYaml = `id: wfl-delegated
name: delegated
version: "1.0.0"
stages:
  - id: stg-1
    name: 委托
    steps:
      - id: step-agent
steps:
  - id: step-agent
    command:
      type: agent
      value:
        promptText: "do-work"
`;

/** 等待一次 sandore/question 事件并返回载荷（用于读取 requestId）。 */
function waitForQuestion(ctx: Context): Promise<{ info: unknown; question: unknown }> {
  return new Promise(resolve => {
    ctx.once('sandore/question', (info, question) => resolve({ info, question }));
  });
}

describe('SandoreEngineRuntime Stage-level conditional branching', () => {
  it('evaluates the Stage branch condition and routes to the matched Stage when shouldExecute is true', async () => {
    const { ctx, engine, persistence, llm, shell } = await harness();
    await putDefinition(persistence, 'wfl-stage-branch', stageBranchYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    // Stage 条件评估（StageContract-based，非 fork）：批量返回命中的 branchId → 取 stg-b。
    llm.streamHandler = () => textChunks('{"shouldExecute": ["stg-b"]}');

    const records = recordSandoreEvents(ctx);
    const ended = waitForEnd(ctx);
    await startWorkflow(engine, { workflowId: 'wfl-stage-branch', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    const completedStages = records
      .filter(record => record.name === 'sandore/stage-completed')
      .map(record => record.args[1]);
    // 条件命中 stg-b → 数组顺序继续 stg-c → stg-default → 结束。
    expect(completedStages).toEqual(['stg-entry', 'stg-b', 'stg-c', 'stg-default']);
  });

  it('skips a false Stage branch condition and falls through to the default (no-condition) branch', async () => {
    const { ctx, engine, persistence, llm, shell } = await harness();
    await putDefinition(persistence, 'wfl-stage-branch', stageBranchYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    // Stage 条件评估：批量返回空数组 → 跳过 stg-b，走无 condition 的默认分支 stg-default。
    llm.streamHandler = () => textChunks('{"shouldExecute": []}');

    const records = recordSandoreEvents(ctx);
    const ended = waitForEnd(ctx);
    await startWorkflow(engine, { workflowId: 'wfl-stage-branch', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    const completedStages = records
      .filter(record => record.name === 'sandore/stage-completed')
      .map(record => record.args[1]);
    // 条件不命中 → 默认分支 stg-default（stg-default 为数组末位，无后续 → 结束），
    // 不走盲取首个 Stage 目标（旧 tryAdvanceStage 会取 stg-b）。
    expect(completedStages).toEqual(['stg-entry', 'stg-default']);
  });

  it('routes to Stage A when the first multi-condition branch matches (skips array-order stg-mid)', async () => {
    const { ctx, engine, persistence, llm, shell } = await harness();
    await putDefinition(persistence, 'wfl-stage-multi', stageBranchMultiYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    // 批量一次评估：condA 命中 → 取 stg-a（定义序首个命中；condB 同批评估但不影响结果）。
    llm.streamHandler = () => textChunks('{"shouldExecute": ["stg-a"]}');

    const records = recordSandoreEvents(ctx);
    const ended = waitForEnd(ctx);
    await startWorkflow(engine, { workflowId: 'wfl-stage-multi', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    const completedStages = records
      .filter(record => record.name === 'sandore/stage-completed')
      .map(record => record.args[1]);
    // 条件命中 stg-a（跳过数组下一 stg-mid）→ stg-a 数组顺序继续 stg-b → 结束。
    expect(completedStages).toEqual(['stg-entry', 'stg-a', 'stg-b']);
  });

  it('routes to Stage B when the first condition is false and the second matches', async () => {
    const { ctx, engine, persistence, llm, shell } = await harness();
    await putDefinition(persistence, 'wfl-stage-multi', stageBranchMultiYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    // 批量一次评估：condA false → 跳过；condB 命中 → 取 stg-b。
    llm.streamHandler = () => textChunks('{"shouldExecute": ["stg-b"]}');

    const records = recordSandoreEvents(ctx);
    const ended = waitForEnd(ctx);
    await startWorkflow(engine, { workflowId: 'wfl-stage-multi', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    const completedStages = records
      .filter(record => record.name === 'sandore/stage-completed')
      .map(record => record.args[1]);
    // 第二条件命中 stg-b（跳过数组下一 stg-mid 与 stg-a）→ stg-b 数组末位无后续 → 结束。
    expect(completedStages).toEqual(['stg-entry', 'stg-b']);
  });
});

describe('SandoreEngineRuntime interaction', () => {
  it('registers a pending question, asks via userQuestions (hostAgent), and resumes after the card reply', async () => {
    const { ctx, engine, persistence, llm, agents, subagents, sessions, userQuestions } = await harness();
    await putDefinition(persistence, 'wfl-ask', askYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    // 入口归一（架构决策 1）：ask 一律上报宿主会话（reportToHost 恒 true）——
    // 宿主会话就是引擎为本实例新建的那个真实顶层会话（id = instanceId）。
    // prompt Step（step-ask）走可续接子代理：注册真实 childId 并回填最终输出。
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'work done' }]));
    agents.register(child);

    // prompt Step 输出（子代理）→ finalize assess ①（ask JSON）→ 回答注回子代理 →
    // 重新收集输出 + 重新评估 ②（completed JSON）。
    const responses = [
      '{"completionType":"ask","passThroughVars":{"projectName":"sandore"},"askQuestion":{"questions":[{"id":"q1","question":"Which?","options":[{"label":"A"},{"label":"B"}]}]}}',
      '{"completionType":"completed","passThroughVars":{}}',
    ];
    let callIndex = 0;
    llm.streamHandler = () => textChunks(responses[callIndex++ % responses.length] ?? '');

    const firedQuestions: unknown[] = [];
    ctx.on('sandore/question', (info, question) => firedQuestions.push({ info, question }));

    // 卡片回复：捕获 ask 请求并回填答案。
    userQuestions.resolveNext = async (request) => {
      expect(request.questions).toEqual([{ id: 'q1', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }]);
      return { answers: [{ id: 'q1', selected: ['A'] }] };
    };

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-ask', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    // ask 以宿主主代理（id ≡ instanceId，架构决策 1）身份发起——一律上报宿主会话。
    expect(userQuestions.calls).toHaveLength(1);
    expect(userQuestions.calls[0]?.agent?.id).toBe(run.instanceId);

    // sandore/question 事件：pending 条目（kind/status/payload）。
    expect(firedQuestions).toHaveLength(1);
    const fired = firedQuestions[0] as { question: { kind: string; status: string; payload: { questions: Array<{ id: string }> } } };
    expect(fired.question.kind).toBe('question');
    expect(fired.question.status).toBe('pending');
    expect(fired.question.payload.questions[0]?.id).toBe('q1');

    // 回复后恢复：Step completed + 实例 completed + 条目不再持久化（pending 已清，
    // 交互管理器只持久化 pending，§3.6A）。Round 26：回答**不写入** userMessages
    // （kind:'answer'）——回答仅 followup 注回子代理，不注入 discussion 时间轴。
    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    expect(state?.executedSteps.find(step => step.stepId === 'step-ask')?.status).toBe('completed');
    expect(state?.pendingInteractions).toEqual([]);
    const answers = state?.userMessages?.filter(message => message.kind === 'answer');
    expect(answers).toEqual([]);
    // 回答经 followup 注回子代理（source user，内容 'A'——子代理会话内可见）。
    const followup = subagents.followups.find(item => item.childId === 'child-1');
    expect(followup?.content).toEqual([{ type: 'text', text: 'A' }]);
  });

  it('supports the replyQuestion compat path when the card channel is unavailable', async () => {
    const { ctx, engine, persistence, llm, agents, subagents } = await harness();
    await putDefinition(persistence, 'wfl-ask', askYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    // prompt Step（step-ask）走可续接子代理：注册真实 childId 并回填最终输出。
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'work done' }]));
    agents.register(child);

    const responses = [
      '{"completionType":"ask","passThroughVars":{"projectName":"sandore"},"askQuestion":{"questions":[{"id":"q1","question":"Which?","options":[{"label":"A"},{"label":"B"}]}]}}',
      '{"completionType":"completed","passThroughVars":{}}',
    ];
    let callIndex = 0;
    llm.streamHandler = () => textChunks(responses[callIndex++ % responses.length] ?? '');

    const question = waitForQuestion(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-ask', originalInput: 'do it', cwd: '/tmp' });
    const fired = await question;
    const requestId = (fired.question as { requestId: string }).requestId;

    // 兼容路径回复：resolve ask 的 await 并恢复执行。
    await engine.replyQuestion(run.instanceId, requestId, { answers: [{ id: 'q1', selected: ['B'] }] });
    await waitForEnd(ctx);

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    // 回答后 pending 已清（只持久化 pending）。Round 26：回答不写入 userMessages。
    expect(state?.pendingInteractions).toEqual([]);
    const answers = state?.userMessages?.filter(message => message.kind === 'answer');
    expect(answers).toEqual([]);
    // 回答经 followup 注回子代理（内容 'B'）。
    const followup = subagents.followups.find(item => item.childId === 'child-1');
    expect(followup?.content).toEqual([{ type: 'text', text: 'B' }]);
  });

  it('resumes the remaining steps and re-runs the gate after a mid-stage ask', async () => {
    const { ctx, engine, persistence, llm, shell, agents, sessions, userQuestions } = await harness();
    await putDefinition(persistence, 'wfl-ask-mid', askMidYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    shell.runHandler = async spec => successResult(spec, 'done');
    // 入口归一（架构决策 1）：ask 一律上报宿主会话（无 hostSessionId 分流）。
    // prompt Step（step-ask）走可续接子代理：注册真实 childId 并回填最终输出。
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'work done' }]));
    agents.register(child);

    // assess ①（ask JSON）→ 回答注回 → 重新评估 ②（completed JSON）→ Phase B 重新
    // fork + 重新 assess ③（completed JSON）→ 门禁（primary 纯代码产物校验，零 AI）。
    // 偏离 2：Phase B 重新 assess，故 completed JSON 需供给两次；step-ask 无 outputTo
    // → primary 校验直接通过，无门禁 AI 调用。
    const responses = [
      '{"completionType":"ask","passThroughVars":{"projectName":"sandore"},"askQuestion":{"questions":[{"id":"q1","question":"Which?","options":[{"label":"A"},{"label":"B"}]}]}}',
      '{"completionType":"completed","passThroughVars":{}}',
      '{"completionType":"completed","passThroughVars":{}}',
    ];
    let callIndex = 0;
    llm.streamHandler = () => textChunks(responses[callIndex++ % responses.length] ?? '');

    userQuestions.resolveNext = async () => ({ answers: [{ id: 'q1', selected: ['A'] }] });

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-ask-mid', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    // 剩余 Step 不丢失：step-ask 与 step-after 均执行。
    expect(state?.executedSteps.map(step => step.stepId)).toEqual(['step-ask', 'step-after']);
    // ask 回复后重跑门禁：step-ask 的 finalizeMeta 记录 gateResult。
    const askStep = state?.executedSteps.find(step => step.stepId === 'step-ask');
    expect(askStep?.status).toBe('completed');
    expect(askStep?.finalizeMeta?.gateResult?.gatesPassed).toBe(true);
  });

  it('emits sandore/step-phase on finalize phase transitions (ask-detect → finalizing → routing → gating/completed)', async () => {
    const { ctx, engine, persistence, llm, shell, agents, userQuestions, sessions } = await harness();
    await putDefinition(persistence, 'wfl-phase-flow', phaseFlowYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    shell.runHandler = async spec => successResult(spec, 'gate done');
    // 入口归一（架构决策 1）：ask 一律上报宿主会话（无 hostSessionId 分流）。
    // prompt Step（step-ask）走可续接子代理：注册真实 childId 并回填最终输出。
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'work done' }]));
    agents.register(child);

    // LLM 调用序：① step-ask Phase A assess（ask JSON）→ 回答注回 → 重新评估 ②
    // （completed JSON）→ Phase B 收尾 ③（compressedOutput 合并 JSON，走降级——child-1
    // 无事件源）→ routing → completed；④ step-gate 为 shell 步骤（Round 20：跳过
    // Phase A/B 收尾评估，零 llm 调用）→ Phase C primary 纯代码门禁（outputTo 缺失
    // 文件，fs 空 → 不通过）→ gating → Step failed → 实例 failed。
    // 按首条消息文本分发：分支/循环专用模板（shouldExecute/shouldBreak）按其字段名；
    // 其余为收尾调用——Phase A（buildAssessPrompt 精简后）含「输出是否是在向用户提问」，
    // Phase B（buildPhaseBFinalizePrompt）含 compressedOutput——按调用序：第 1 次 Phase A
    // 调用（step-ask）返回 ask JSON 触发 ask-detect；后续 Phase A 返回无 ask JSON；
    // Phase B 返回统一收尾 JSON（passThroughVars + compressedOutput，对 parseFinalizeResult
    // 有效）。
    let phaseACall = 0;
    llm.streamHandler = (options) => {
      const text = (options.messages[0]?.content[0] as TextBlock | undefined)?.text ?? '';
      if (text.includes('shouldBreak')) {
        return textChunks('{"shouldBreak": false}');
      }
      if (text.includes('输出是否是在向用户提问')) {
        // Phase A ask 判定（精简：仅 hasAsk/askQuestion）。
        phaseACall += 1;
        return phaseACall === 1
          ? textChunks('{"hasAsk":true,"askQuestion":{"questions":[{"id":"q1","question":"Which?","options":[{"label":"A"},{"label":"B"}]}]}}')
          : textChunks('{"hasAsk":false,"askQuestion":{"questions":[]}}');
      }
      if (text.includes('compressedOutput')) {
        // Phase B 收尾（透传变量 + 输出压缩）。
        return textChunks('{"hasAsk":false,"passThroughVars":{},"compressedOutput":"摘要"}');
      }
      // 理论不可达（收尾/分支均含特征字段）；兜底返回完成 JSON。
      return textChunks('{"hasAsk":false,"passThroughVars":{}}');
    };

    userQuestions.resolveNext = async () => ({ answers: [{ id: 'q1', selected: ['A'] }] });

    const records = recordSandoreEvents(ctx);
    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-phase-flow', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    // 收尾阶段流转事件：step-ask ask-detect → finalizing → routing → completed（ask 回复
    // 后续跑；Phase D routing 在门禁通过后、completed 前落盘）；step-gate finalizing →
    // gating（primary 门禁不通过，**不执行 Phase D**）。载荷 phase/name 正确，
    // childId 为真实子代理（prompt）；shell（2026-09-09 起不建子代理）→ childId undefined。
    const phaseRecords = records.filter(record => record.name === 'sandore/step-phase');
    expect(phaseRecords.map(record => ({
      stepId: record.args[1] as string,
      childId: record.args[2] as string | undefined,
      phase: record.args[3] as string,
      name: record.args[4] as string,
    }))).toEqual([
      { stepId: 'step-ask', childId: 'child-1', phase: 'ask-detect', name: 'step-ask' },
      // Round 17：onForkCreated 替代空快照——shell 降级无 fork 子代理，仅 1 个 finalizing（done）
      { stepId: 'step-ask', childId: 'child-1', phase: 'finalizing', name: 'step-ask' },
      { stepId: 'step-ask', childId: 'child-1', phase: 'routing', name: 'step-ask' },
      { stepId: 'step-ask', childId: 'child-1', phase: 'completed', name: 'step-ask' },
      // Round 20：step-gate 为 shell 步骤，跳过 Phase A/B → 无 finalizing 事件；
      // Phase C primary 门禁直接失败（2 个 gating：running 快照 + 终态）。
      { stepId: 'step-gate', childId: undefined, phase: 'gating', name: 'step-gate' },
      { stepId: 'step-gate', childId: undefined, phase: 'gating', name: 'step-gate' },
    ]);

    // Round 25（去污染）：宿主会话不再承载 sandore/* 事件（Cordis 半边断言已覆盖）
    // ——此处反转断言宿主会话保持干净（入口归一后宿主会话 id ≡ instanceId）。
    expect(sessions.get(run.instanceId)?.events.some(event => event.type === 'sandore/step-phase')).toBe(false);

    // 阶段状态落盘对齐事件：step-ask completed（finalizeMeta completed）、
    // step-gate failed（finalizeMeta gating + gateResult 未过）。
    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('failed');
    const askStep = state?.executedSteps.find(step => step.stepId === 'step-ask');
    expect(askStep?.status).toBe('completed');
    expect(askStep?.finalizeMeta?.currentPhase).toBe('completed');
    const gateStep = state?.executedSteps.find(step => step.stepId === 'step-gate');
    expect(gateStep?.status).toBe('failed');
    expect(gateStep?.finalizeMeta?.currentPhase).toBe('gating');
    expect(gateStep?.finalizeMeta?.gateResult?.gatesPassed).toBe(false);
  });

  // ── Round 7：收尾阶段中间态同步集成测试 ──────────────────────────────────

  it('emitStepPhase 发出时 active.state 已含最新 finalizeMeta（Round 7 中间态同步）', async () => {
    const { ctx, engine, persistence, llm, shell, agents, sessions, userQuestions } = await harness();
    await putDefinition(persistence, 'wfl-phase-flow', phaseFlowYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    shell.runHandler = async spec => successResult(spec, 'gate done');
    // 入口归一（架构决策 1）：ask 一律上报宿主会话（无 hostSessionId 分流）。
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'work done' }]));
    agents.register(child);

    // LLM 调用序：与 wfl-phase-flow 测试一致。
    let finalizeCall = 0;
    llm.streamHandler = (options) => {
      const text = (options.messages[0]?.content[0] as TextBlock | undefined)?.text ?? '';
      if (text.includes('shouldBreak')) {
        return textChunks('{"shouldBreak": false}');
      }
      if (text.includes('compressedOutput')) {
        finalizeCall += 1;
        return finalizeCall === 1
          ? textChunks('{"hasAsk":true,"passThroughVars":{},"askQuestion":{"questions":[{"id":"q1","question":"Which?","options":[{"label":"A"},{"label":"B"}]}]},"compressedOutput":"摘要"}')
          : textChunks('{"hasAsk":false,"passThroughVars":{},"compressedOutput":"摘要"}');
      }
      return textChunks('{"hasAsk":false,"passThroughVars":{}}');
    };
    userQuestions.resolveNext = async () => ({ answers: [{ id: 'q1', selected: ['A'] }] });

    // 关键断言：在 sandore/step-phase 事件监听器中，检查 engine.getInstanceState 返回的
    // active.state 里对应 step 的 finalizeMeta.currentPhase 已等于事件 phase。
    const midstateSnapshots: Array<{ stepId: string; phase: string; finalizeMetaPhase: string | undefined; hasStep: boolean; stepsCount: number }> = [];
    ctx.on('sandore/step-phase', (info, stepId, childId, phase) => {
      const state = engine.getInstanceState((info as { taskId: string }).taskId);
      const step = state?.executedSteps.find(s => s.stepId === stepId);
      midstateSnapshots.push({
        stepId,
        phase,
        finalizeMetaPhase: step?.finalizeMeta?.currentPhase,
        hasStep: step !== undefined,
        stepsCount: state?.executedSteps.length ?? 0,
      });
    });

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-phase-flow', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    // 验证每个 step-phase 事件发出时，active.state 里的 finalizeMeta.currentPhase 已是最新。
    // ask-detect 事件是 Phase A 发出的（在 commitFinalize 之前），不含 finalizeMeta，跳过。
    for (const snap of midstateSnapshots) {
      if (snap.phase === 'ask-detect') continue;
      expect({ stepId: snap.stepId, phase: snap.phase, hasStep: snap.hasStep, stepsCount: snap.stepsCount, finalizeMetaPhase: snap.finalizeMetaPhase })
        .toEqual(expect.objectContaining({ finalizeMetaPhase: snap.phase }));
    }

    // 完整事件流存在。
    const phases = midstateSnapshots.map(s => s.phase);
    expect(phases).toEqual(expect.arrayContaining(['finalizing', 'gating', 'completed']));
  });

  it('rejectQuestion marks the ask Step failed + instance failed (no reject bubbling to runAndCatch, 缺陷 26)', async () => {
    const { ctx, engine, persistence, llm, agents } = await harness();
    await putDefinition(persistence, 'wfl-ask', askYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    // prompt Step（step-ask）走可续接子代理：注册真实 childId 并回填最终输出。
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'work done' }]));
    agents.register(child);
    // 不设 resolveNext / 不推 answers → FakeUserQuestions.ask 挂起，等待 rejectQuestion。
    const responses = [
      '{"completionType":"ask","passThroughVars":{"projectName":"sandore"},"askQuestion":{"questions":[{"id":"q1","question":"Which?","options":[{"label":"A"},{"label":"B"}]}]}}',
    ];
    let callIndex = 0;
    llm.streamHandler = () => textChunks(responses[callIndex++ % responses.length] ?? '');

    const records = recordSandoreEvents(ctx);
    const question = waitForQuestion(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-ask', originalInput: 'do it', cwd: '/tmp' });
    const fired = await question;
    const requestId = (fired.question as { requestId: string }).requestId;

    // 拒绝问答：rejectQuestion resolve 占位解挂 waiter（非 reject），引擎检测后标 Step failed。
    await engine.rejectQuestion(run.instanceId, requestId);
    await waitForEnd(ctx);

    const state = persistence.state.get(run.instanceId);
    // 实例落 failed（经 handleRejectedQuestion 显式代码，非异常冒泡 runAndCatch）。
    expect(state?.status).toBe('failed');
    // ask Step 正确置 failed（非滞留 interacting）。
    const askStep = state?.executedSteps.find(step => step.stepId === 'step-ask');
    expect(askStep?.status).toBe('failed');
    expect(askStep?.error).toBe('Question rejected by user');
    // 双发 sandore/step-failed（StageExecutor 未对 interacting Step 触发，引擎显式补发）。
    const stepFailed = records.find(record => record.name === 'sandore/step-failed');
    expect(stepFailed?.args[1]).toBe('step-ask');
    // 双发 sandore/end(failed)。
    const ended = records.find(record => record.name === 'sandore/end');
    expect((ended?.args[1] as { status: string }).status).toBe('failed');
    // pending 条目已清（终态条目不进快照）。
    expect(state?.pendingInteractions).toEqual([]);
  });

  it('rejectQuestion emits sandore/question_rejected for UI refresh (缺陷 26)', async () => {
    const { ctx, engine, persistence, llm, agents, sessions } = await harness();
    await putDefinition(persistence, 'wfl-ask', askYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    // 入口归一（架构决策 1）：ask 一律上报宿主会话（无 hostSessionId 分流）。
    // prompt Step（step-ask）走可续接子代理：注册真实 childId 并回填最终输出。
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'work done' }]));
    agents.register(child);
    const responses = [
      '{"completionType":"ask","passThroughVars":{"projectName":"sandore"},"askQuestion":{"questions":[{"id":"q1","question":"Which?","options":[{"label":"A"},{"label":"B"}]}]}}',
    ];
    let callIndex = 0;
    llm.streamHandler = () => textChunks(responses[callIndex++ % responses.length] ?? '');

    const rejectedFired: unknown[] = [];
    ctx.on('sandore/question_rejected', (info, questionEntry) => rejectedFired.push({ info, questionEntry }));
    const question = waitForQuestion(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-ask', originalInput: 'do it', cwd: '/tmp' });
    const fired = await question;
    const requestId = (fired.question as { requestId: string }).requestId;

    await engine.rejectQuestion(run.instanceId, requestId);
    await waitForEnd(ctx);

    expect(rejectedFired).toHaveLength(1);
    const entry = (rejectedFired[0] as { questionEntry: { kind: string; status: string; requestId: string } }).questionEntry;
    expect(entry.kind).toBe('question');
    expect(entry.status).toBe('rejected');
    expect(entry.requestId).toBe(requestId);
  });

  it('caps finalize ask rounds at MAX_FINALIZE_ASK_ROUNDS (3) and completes with the last output (status 流转)', async () => {
    const { ctx, engine, persistence, llm, agents, sessions, userQuestions } = await harness();
    await putDefinition(persistence, 'wfl-ask', askYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    // 入口归一（架构决策 1）：ask 一律上报宿主会话（无 hostSessionId 分流）。
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'work done' }]));
    agents.register(child);
    // 恒返回 hasAsk=true + askQuestion（评估永不判定完成）→ 引擎 ask 闭环反复触发。
    llm.streamHandler = () => textChunks(
      '{"hasAsk":true,"passThroughVars":{},"askQuestion":{"questions":[{"id":"q1","question":"Which?","options":[{"label":"A"},{"label":"B"}]}]}}',
    );
    userQuestions.resolveNext = async () => ({ answers: [{ id: 'q1', selected: ['A'] }] });

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-ask', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    // 轮次上限（4.7）：最多 3 轮 ask（首次 + 2 次续问），之后 runPhaseA 把最后 output
    // 视为完成（不再续问），实例收敛 completed。
    expect(userQuestions.calls).toHaveLength(3);
    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    const askStep = state?.executedSteps.find(step => step.stepId === 'step-ask');
    expect(askStep?.status).toBe('completed');
  });
});

describe('SandoreEngineRuntime 双通道 ask（4.4：[[SANDORE_ASK]] 机制已删）', () => {
  it('treats a [[SANDORE_ASK]] marker block as ordinary output (no delegation, no followup)', async () => {
    const { ctx, engine, persistence, llm, agents, subagents, userQuestions } = await harness();
    await putDefinition(persistence, 'wfl-delegated', delegatedAskYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);

    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([
      { type: 'text', text: '[[SANDORE_ASK]]{"questions":[{"id":"q1","question":"Which?"}]}[[/SANDORE_ASK]]' },
    ]));
    agents.register(child);

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-delegated', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    // 标记块机制已删：不转接、不 ask、不 followup——输出原样透传（子代理提问走
    // child-scope ask_user_question 工具，见 askFromSubagent 测试）。
    expect(userQuestions.calls).toHaveLength(0);
    expect(subagents.followups).toHaveLength(0);
    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    expect(state?.executedSteps.find(step => step.stepId === 'step-agent')?.output).toEqual([
      { type: 'text', text: '[[SANDORE_ASK]]{"questions":[{"id":"q1","question":"Which?"}]}[[/SANDORE_ASK]]' },
    ]);
  });

  it('does not delegate an invalid marker block (treated as ordinary output)', async () => {
    const { ctx, engine, persistence, llm, agents, subagents, userQuestions } = await harness();
    await putDefinition(persistence, 'wfl-delegated', delegatedAskYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);

    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([
      { type: 'text', text: '[[SANDORE_ASK]]not json[[/SANDORE_ASK]]' },
    ]));
    agents.register(child);

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-delegated', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    expect(userQuestions.calls).toHaveLength(0);
    expect(subagents.followups).toHaveLength(0);
    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    expect(state?.executedSteps.find(step => step.stepId === 'step-agent')?.output).toEqual([
      { type: 'text', text: '[[SANDORE_ASK]]not json[[/SANDORE_ASK]]' },
    ]);
  });
});

describe('SandoreEngineRuntime askFromSubagent（双通道 ask 通道 1）', () => {
  it('routes a subagent question to the engine-level ask (hostAgent identity) and returns the answer', async () => {
    const { ctx, engine, persistence, llm, agents, sessions, userQuestions } = await harness();
    await putDefinition(persistence, 'wfl-ask', askYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    // 入口归一（架构决策 1）：宿主会话 = 本实例新建会话；ask 一律上报宿主。
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'work done' }]));
    agents.register(child);
    llm.streamHandler = () => textChunks('{"hasAsk":false,"passThroughVars":{}}');

    // 等待实例跑完（Step 段已写入 executedSteps，sessionMeta.childId = child-1）。
    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-ask', originalInput: 'do it', cwd: '/tmp' });
    await ended;
    // 真实 DSH：子代理 session.header.parentSession = 宿主主代理会话 id（childSessionMeta）；
    // mock 手动补写（恒等式：hostAgent.id ≡ instanceId）。
    child.session.header = { parentSession: run.instanceId };

    const firedQuestions: unknown[] = [];
    ctx.on('sandore/question', (info, question) => firedQuestions.push({ info, question }));
    userQuestions.resolveNext = async request => {
      expect(request.questions).toEqual([{ id: 'q1', question: 'Which?' }]);
      return { answers: [{ id: 'q1', selected: ['A'] }] };
    };
    const answer = await engine.askFromSubagent(child, [{ id: 'q1', question: 'Which?' }]);

    expect(answer).toEqual({ answers: [{ id: 'q1', selected: ['A'] }] });
    // 以宿主主代理（id ≡ instanceId）身份发起（非子代理自身——避免 DELEGATED_CALLER）。
    expect(userQuestions.calls[userQuestions.calls.length - 1]?.agent?.id).toBe(run.instanceId);
    // 提问登记期间发射 sandore/question（pending 条目；回答后已终态化，仅 pending 持久化）。
    expect(firedQuestions).toHaveLength(1);
    const firedEntry = firedQuestions[0] as { question: { kind: string; payload: { questions: Array<{ id: string }> } } };
    expect(firedEntry.question.kind).toBe('question');
    expect(firedEntry.question.payload.questions[0]?.id).toBe('q1');
  });

  it('throws STEP_EXECUTION when the question is rejected (缺陷 26 显式落态)', async () => {
    const { ctx, engine, persistence, llm, agents, userQuestions } = await harness();
    await putDefinition(persistence, 'wfl-ask', askYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'work done' }]));
    agents.register(child);
    llm.streamHandler = () => textChunks('{"hasAsk":false,"passThroughVars":{}}');

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-ask', originalInput: 'do it', cwd: '/tmp' });
    await ended;
    child.session.header = { parentSession: run.instanceId };

    const asking = engine.askFromSubagent(child, [{ id: 'q1', question: 'Which?' }]);
    // 等 pending 条目登记后拒绝（resolve 占位 → askFromSubagent 抛 STEP_EXECUTION）。
    await new Promise(resolve => setImmediate(resolve));
    const state = persistence.state.get(run.instanceId);
    const entry = state?.pendingInteractions.find(item => item.kind === 'question');
    expect(entry).toBeDefined();
    await engine.rejectQuestion(run.instanceId, (entry as { requestId: string }).requestId);

    await expect(asking).rejects.toMatchObject({ code: 'STEP_EXECUTION' });
  });

  it('throws INVALID_OPERATION for unknown parent session or unknown child', async () => {
    const { ctx, engine, persistence, llm, agents } = await harness();
    await putDefinition(persistence, 'wfl-ask', askYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'work done' }]));
    agents.register(child);
    llm.streamHandler = () => textChunks('{"hasAsk":false,"passThroughVars":{}}');

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-ask', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    // 无 parent session header → INVALID_OPERATION。
    await expect(engine.askFromSubagent(
      child,
      [{ id: 'q1', question: 'Q?' }],
    )).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    // parent session 命中但 child 不匹配任何 Step 段 → INVALID_OPERATION。
    child.session.header = { parentSession: run.instanceId };
    const unknownChild = new FakeAgent('no-such-child');
    unknownChild.session.header = { parentSession: run.instanceId };
    await expect(engine.askFromSubagent(
      unknownChild,
      [{ id: 'q1', question: 'Q?' }],
    )).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
  });
});

describe('SandoreEngineRuntime registerGlobalAskTool gate（上游适配：全局注册 + execute 期 gate，仅当前非终态 sandore 实例的子代理）', () => {
  it('registers the global sandore ask tool once; execute gates on non-sandore callers and active sandore subagents', async () => {
    const { ctx, engine, persistence, llm, subagents, agents, sessions, userQuestions, toolsRegistrations } = await harness();
    await putDefinition(persistence, 'wfl-prompt-only', promptOnlyYaml);
    provideLlmDirectory(llm);
    // prompt Step 挂起：child status='running' 不自动 settle → 实例保持 running（非终态）。
    const child = new FakeAgent('child-1');
    child.status = 'running';
    agents.register(child);
    // 入口归一（架构决策 1）：ask 一律上报宿主会话（恒 true）→ gate 命中时上报宿主并返回。

    const stepStarted = waitForStepStart(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-prompt-only', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;

    // 引擎启动时全局注册 6 个工具（Service.init → registerGlobalAskTool + 5 个
    // sandore_workflow_* 工具，见 host-tools.ts）；此处按名取
    // sandore_ask_user_question，描述说明它是 sandore 工作流子代理的提问通道。
    expect(toolsRegistrations).toHaveLength(6);
    expect(toolsRegistrations.map(entry => (entry as { name: string }).name).sort())
      .toEqual([
        'sandore_ask_user_question',
        'sandore_workflow',
        'sandore_workflow_control',
        'sandore_workflow_run',
        'sandore_workflow_send_message',
        'sandore_workflow_status',
      ]);
    const tool = toolsRegistrations.find(entry => (entry as { name: string }).name === 'sandore_ask_user_question') as {
      name: string;
      description: string;
      execute(args: { questions: Array<{ id: string; question: string }> }, exec: { agent?: FakeAgent; signal?: AbortSignal }): Promise<unknown>;
    };
    expect(tool.name).toBe('sandore_ask_user_question');
    expect(tool.description).toContain('Sandore workflow step subagent');

    // Step 子代理委派请求携带 toolFilter deny 全局版 ask_user_question（引导模型用
    // sandore 通道）**并** deny send_message（架构决策 5：子代理不向主代理汇报）。
    // step-start 事件先于 startContinuable 发出，经 waitFor 等委派请求登记。
    await vi.waitFor(() => {
      expect(subagents.continuableStarts.length).toBeGreaterThan(0);
      expect(subagents.continuableStarts[0]?.request.toolFilter).toEqual({ deny: ['ask_user_question', 'send_message'] });
    });

    // 入口归一（架构决策 1）：真实子代理段的 hostSessionId = parent = instanceId
    // （onChildStarted 回填并持久化，UI 组 subagent-kind 地址的权威来源）。
    const live = persistence.state.get(run.instanceId);
    const stepSeg = live?.executedSteps.find(s => s.sessionMeta?.childId === 'child-1');
    expect(stepSeg?.sessionMeta?.hostSessionId).toBe(run.instanceId);
    expect(stepSeg?.sessionMeta?.synthetic).toBe(false);

    // gate 未命中（exec.agent 缺失）：抛清晰说明的错误。
    await expect(tool.execute({ questions: [{ id: 'q1', question: 'Q?' }] }, {}))
      .rejects.toThrow('sandore_ask_user_question is only available to sandore workflow step subagents');
    // gate 未命中（parent 非任何活跃 sandore 实例的宿主主代理会话）：同样拒绝。
    const outsider = new FakeAgent('outsider');
    outsider.session.header = { parentSession: 'some-other-session' };
    await expect(tool.execute({ questions: [{ id: 'q1', question: 'Q?' }] }, { agent: outsider }))
      .rejects.toThrow('sandore_ask_user_question is only available to sandore workflow step subagents');

    // gate 命中（parent = 当前非终态实例的宿主主代理会话 = instanceId，且 childId 命中
    // Step 段）：路由到引擎 askFromSubagent 并返回 DSH 答案形状。
    child.session.header = { parentSession: run.instanceId };
    userQuestions.resolveNext = async () => ({ answers: [{ id: 'q1', selected: ['A'] }] });
    await expect(tool.execute({ questions: [{ id: 'q1', question: 'Q?' }] }, { agent: child }))
      .resolves.toEqual({ answers: [{ id: 'q1', selected: ['A'] }] });

    // 实例终态（completed）后：同一宿主主代理的后续子代理不再放行（避免提问路由到
    // 已结束实例的交互管理器）。
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    subagents.settleChild('child-1', 'completed');
    await waitForEnd(ctx);
    await expect(tool.execute({ questions: [{ id: 'q1', question: 'Q?' }] }, { agent: child }))
      .rejects.toThrow('sandore_ask_user_question is only available to sandore workflow step subagents');
  });

  it('skips registration when the tools service is absent (minimal stub deployment)', () => {
    // registerGlobalAskTool 对 tools 服务缺失静默跳过（返回空 disposer，不阻塞引擎
    // 启动）——与旧 contribution 对 subagents 缺省的降级一致。
    const bareCtx = new Context();
    const disposer = registerGlobalAskTool(bareCtx, {
      isSandoreSubagentParentSession: () => false,
      askFromSubagent: async () => ({ answers: [] }),
    });
    expect(disposer).toBeTypeOf('function');
  });
});

/** 单 Stage 单 agent Step（用于重试续跑集成测试：首跑无输出 failed，续跑回填输出 completed）。 */
const agentFailYaml = `id: wfl-agent-fail
name: agent-fail
version: "1.0.0"
stages:
  - id: stg-1
    name: 单agent
    steps:
      - id: step-agent
steps:
  - id: step-agent
    command:
      type: agent
      value:
        promptText: "do work"
`;

/** 单 Stage 三 Step：shell（outputTo）→ agent（中间失败可重试）→ shell（剩余 Step）。 */
const multiStepRetryYaml = `id: wfl-multi-retry
name: multi-retry
version: "1.0.0"
stages:
  - id: stg-1
    name: 重试续跑
    steps:
      - id: step-a
      - id: step-b
      - id: step-c
steps:
  - id: step-a
    command:
      type: shell
      value:
        command: "echo hello"
    outputTo:
      - id: opt-a
        path: "out-a.txt"
  - id: step-b
    command:
      type: agent
      value:
        promptText: "do work"
    outputTo:
      - id: opt-b
        path: "out-b.txt"
  - id: step-c
    command:
      type: shell
      value:
        command: "echo done"
`;

describe('SandoreEngineRuntime recovery', () => {
  it('throws INVALID_OPERATION when recovering a terminal instance', async () => {
    const { engine, persistence } = await harness();
    await persistence.state.put('inst-done', completedSnapshot('inst-done'));

    await expect(engine.recoverInstance('inst-done')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
  });

  it('retries a failed agent step with continue mode and resumes to completed', async () => {
    const { ctx, engine, persistence, llm, agents, subagents, sessions } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);

    // 子代理首次无输出 → Step failed（真实 childId 已记录）。
    const child = new FakeAgent('child-1');
    agents.register(child);

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-agent-fail', originalInput: 'do it', cwd: '/tmp' });
    await ended;
    expect(persistence.state.get(run.instanceId)?.status).toBe('failed');

    // 续跑前给子代理回填最终输出。
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'retry output' }]));

    const retried: Array<{ stepId: string; mode: string; name: string; loopIteration?: number[] }> = [];
    ctx.on('sandore/step-retried', (_info, stepId, mode, name, loopIteration) => retried.push({ stepId, mode, name, ...(loopIteration === undefined ? {} : { loopIteration }) }));

    await engine.retryStep(run.instanceId, 'step-agent', 'continue', 'please retry');

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    // 段模型：重试追加新段（attemptIndex 1），断言取最后活跃段。
    const step = lastSegmentOf(state?.executedSteps ?? [], 'step-agent');
    expect(step?.output).toEqual([{ type: 'text', text: 'retry output' }]);
    expect(step?.sessionMeta?.childId).toBe('child-1');
    expect(step?.retryHistory?.[0]?.mode).toBe('continue');
    expect(step?.retryHistory?.[0]?.result).toBe('completed');
    expect(subagents.followups.some(item => item.childId === 'child-1')).toBe(true);

    // sandore/step-retried 单发：Cordis 事件断言（Round 25 去污染：宿主会话不再承载）。
    expect(retried).toEqual([{ stepId: 'step-agent', mode: 'continue', name: 'step-agent' }]);
  });

  it('retries a failed middle agent step and runs all remaining steps to completed', async () => {
    const { ctx, engine, persistence, llm, shell, agents } = await harness();
    await putDefinition(persistence, 'wfl-multi-retry', multiStepRetryYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);

    const child = new FakeAgent('child-1');
    agents.register(child);

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-multi-retry', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    // 首跑：step-a 完成、step-b（agent 无输出）失败、step-c 未执行。
    let state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('failed');
    expect(state?.executedSteps.map(step => step.stepId)).toEqual(['step-a', 'step-b']);
    expect(state?.executedSteps[1]?.status).toBe('failed');

    // 续跑前给子代理回填最终输出。
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'retry output' }]));
    await engine.retryStep(run.instanceId, 'step-b', 'continue', 'please retry');

    state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    // 段模型：step-b 重试追加新段（attemptIndex 1），旧 failed 段保留定格快照。
    // 断言聚焦新段状态与输出（不假设 stepIds 顺序，旧 failed 段的存在单独验证）。
    const stepIds = state?.executedSteps.map(step => step.stepId) ?? [];
    expect(new Set(stepIds)).toEqual(new Set(['step-a', 'step-b', 'step-c']));
    expect(stepIds.filter(id => id === 'step-b').length).toBe(2);
    const retriedB = lastSegmentOf(state?.executedSteps ?? [], 'step-b');
    expect(retriedB?.status).toBe('completed');
    expect(retriedB?.output).toEqual([{ type: 'text', text: 'retry output' }]);
    expect(retriedB?.retryHistory?.[0]?.mode).toBe('continue');
    expect(retriedB?.retryHistory?.[0]?.result).toBe('completed');
    const failedB = state?.executedSteps.find(step => step.stepId === 'step-b' && step.status === 'failed');
    expect(failedB).toBeDefined();
  });

  it('preserves outputTo artifacts in the stage contract after retrying the producing step', async () => {
    const { ctx, engine, persistence, llm, shell, agents } = await harness();
    await putDefinition(persistence, 'wfl-multi-retry', multiStepRetryYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);

    const child = new FakeAgent('child-1');
    agents.register(child);

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-multi-retry', originalInput: 'do it', cwd: '/tmp' });
    await ended;
    expect(persistence.state.get(run.instanceId)?.status).toBe('failed');

    child.session.append(assistantMessageEvent([{ type: 'text', text: 'retry output' }]));
    await engine.retryStep(run.instanceId, 'step-b', 'continue', 'please retry');

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    // 重试 Step 的 outputTo 产物保留在 StageContract.artifacts（含已完成的 step-a）。
    const contract = state?.stageContracts['stg-1'];
    expect(contract?.status).toBe('completed');
    const artifacts = contract?.artifacts ?? [];
    expect(artifacts.map(item => item.outputToId)).toEqual(['opt-a', 'opt-b']);
    expect(artifacts.find(item => item.outputToId === 'opt-b')?.stepId).toBe('step-b');
  });

  it('retries a failed agent step with fork mode to a new childId and completes', async () => {
    const { ctx, engine, persistence, llm, agents, subagents, sessions } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);

    const child = new FakeAgent('child-1');
    agents.register(child);

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-agent-fail', originalInput: 'do it', cwd: '/tmp' });
    await ended;
    expect(persistence.state.get(run.instanceId)?.status).toBe('failed');

    // fork 源：child-1 在 sessions 表登记，其 assistant 输出作为 fork 的 seed 回放。
    const childSession = sessions.create('child-1');
    childSession.append('assistant/message', assistantMessageEvent([{ type: 'text', text: 'fork output' }]).data);

    await engine.retryStep(run.instanceId, 'step-agent', 'fork', 'fork it');

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    // 段模型：fork 新段（attemptIndex 1）承载新 childId/output/retryHistory。
    const step = lastSegmentOf(state?.executedSteps ?? [], 'step-agent');
    expect(step?.output).toEqual([{ type: 'text', text: 'fork output' }]);
    // 新 childId（合成 session id）续跑，parentSessionId 记旧值。
    expect(step?.sessionMeta?.childId).toMatch(UUID_RE);
    expect(step?.sessionMeta?.childId).not.toBe('child-1');
    expect(step?.parentSessionId).toBe('child-1');
    expect(step?.retryHistory?.[0]?.mode).toBe('fork');
    expect(step?.retryHistory?.[0]?.result).toBe('completed');
    expect(subagents.followups.some(item => item.childId === step?.sessionMeta?.childId)).toBe(true);
  });

  it('rebuilds a failed step from ITS OWN session only (no host main-agent text in the seed)', async () => {
    const { ctx, engine, persistence, llm, agents, sessions } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    const child = new FakeAgent('child-1');
    agents.register(child);

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-agent-fail', originalInput: 'do it', cwd: '/tmp' });
    await ended;
    expect(persistence.state.get(run.instanceId)?.status).toBe('failed');

    // 不动点：宿主主代理会话（= 实例 id）里塞满主代理的历史事件。
    const hostSession = sessions.get(run.instanceId);
    expect(hostSession).toBeDefined();
    hostSession!.append('user/message', {
      id: 'host-u1',
      content: [{ type: 'text', text: '## 用户指令 请调用 sandore_workflow_run' }],
      source: { kind: 'plugin', plugin: 'dsh-sandore', form: 'notice', summary: 'start' },
    });
    hostSession!.append('assistant/message', assistantMessageEvent([{ type: 'text', text: '工作流已启动。实例 ID：x 状态：running' }]).data);
    hostSession!.append('turn/end', { turn: 1, reason: { kind: 'completed' } });

    // fork 源 = step 段自己的会话（child-1）：塞入「该 step 的输出」。
    const childSession = sessions.create('child-1');
    childSession.append('assistant/message', assistantMessageEvent([{ type: 'text', text: 'step retry output' }]).data);
    childSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } });

    await engine.retryStep(run.instanceId, 'step-agent', 'fork', 'fork it');

    // 不变量（2026-09 真机缺陷）：重建执行子代理的 seed **只来自该 step 自己的会话**，
    // 绝不包含宿主主代理的历史文本（即使宿主会话有闭合 turn 可供 fork）。
    const seed = agents.createSeeds.at(-1) ?? [];
    expect(seed.length).toBeGreaterThan(0);
    const seedText = JSON.stringify(seed);
    expect(seedText).toContain('step retry output');
    expect(seedText).not.toContain('工作流已启动');
    expect(seedText).not.toContain('请调用 sandore_workflow_run');
    expect(persistence.state.get(run.instanceId)?.status).toBe('completed');
  });

  it('retries a failed agent step with revert mode to a new childId and completes', async () => {
    const { ctx, engine, persistence, llm, agents, subagents, sessions } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);

    const child = new FakeAgent('child-1');
    agents.register(child);

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-agent-fail', originalInput: 'do it', cwd: '/tmp' });
    await ended;
    expect(persistence.state.get(run.instanceId)?.status).toBe('failed');

    // revert 源：child-1 含闭合 turn（turn/start → assistant → turn/end）供安全边界计算。
    const childSession = sessions.create('child-1');
    childSession.append('turn/start', { turn: 0 });
    childSession.append('assistant/message', assistantMessageEvent([{ type: 'text', text: 'revert output' }]).data);
    childSession.append('turn/end', { turn: 0, reason: { kind: 'completed' } });

    await engine.retryStep(run.instanceId, 'step-agent', 'revert', 'rollback');

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    const step = lastSegmentOf(state?.executedSteps ?? [], 'step-agent');
    expect(step?.output).toEqual([{ type: 'text', text: 'revert output' }]);
    expect(step?.sessionMeta?.childId).toMatch(UUID_RE);
    expect(step?.parentSessionId).toBe('child-1');
    expect(step?.retryHistory?.[0]?.mode).toBe('revert');
    expect(step?.retryHistory?.[0]?.result).toBe('completed');
    expect(subagents.followups.some(item => item.childId === step?.sessionMeta?.childId)).toBe(true);

    // 上游适配：retry revert/fork 的 createAgent 包装注入与 forkStepSubagent 同型的
    // setup（delegation 策略 + applyChildComposition），消除 retry fork 子代理零工具
    // 缺陷——create 记录序 = [宿主主代理, retry 子代理, ...]。
    const retryCreateMeta = agents.createMetas[1];
    expect(retryCreateMeta).toMatchObject({ origin: 'subagent', parentSession: run.instanceId, isSeeded: true });
    // 顶层 inheritedEventCount = seed 长度（闭合 turn：turn/start + assistant + turn/end）。
    expect(agents.createInheritedEventCounts[1]).toBe(3);
    // setup 已在 create 时执行：preset 组合（parentCtx === 宿主主代理 ctx）+ delegation
    // 运行时上下文注册均生效（后续 finalize fork 同型 setup ≥1 次，故取最末记录断言）。
    expect(agents.createSetups[1]).toBeDefined();
    expect(agents.composeFromCalls.length).toBeGreaterThanOrEqual(1);
    expect(agents.composeFromCalls[0]?.parentCtx).toBe(agents.createdAgents[0]?.ctx);
    expect(agents.systemPromptContexts.length).toBeGreaterThanOrEqual(1);
    expect(agents.systemPromptContexts[0]?.declaration.name).toBe('subagent:delegation');
  });

  it('retries a failed agent step with revert mode to a user-selected earlier turn boundary', async () => {
    const { ctx, engine, persistence, llm, agents, subagents, sessions } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);

    const child = new FakeAgent('child-1');
    agents.register(child);

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-agent-fail', originalInput: 'do it', cwd: '/tmp' });
    await ended;
    expect(persistence.state.get(run.instanceId)?.status).toBe('failed');

    // revert 源：两个闭合 turn（seq 2 与 5）+ 一个未闭合尾部 turn（seq 6 turn/start，无 turn/end）。
    // 用户传 revertBoundary=2 选更早 turn（截断到 seq 2，丢弃 seq 3-6 的失败内容）。
    const childSession = sessions.create('child-1');
    childSession.append('turn/start', { turn: 0 });
    childSession.append('assistant/message', assistantMessageEvent([{ type: 'text', text: 'first answer' }]).data);
    childSession.append('turn/end', { turn: 0, reason: { kind: 'completed' } });
    childSession.append('turn/start', { turn: 1 });
    childSession.append('assistant/message', assistantMessageEvent([{ type: 'text', text: 'failed attempt' }]).data);
    childSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    childSession.append('turn/start', { turn: 2 });
    childSession.append('assistant/message', assistantMessageEvent([{ type: 'text', text: 'unmatched tail' }]).data);

    await engine.retryStep(run.instanceId, 'step-agent', 'revert', 'rollback', 2);

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    const step = lastSegmentOf(state?.executedSteps ?? [], 'step-agent');
    // seed 截断到 boundary=2（仅含 turn 0 的 first answer），后续 followup 续跑输出该文本。
    expect(step?.output).toEqual([{ type: 'text', text: 'first answer' }]);
    expect(step?.retryHistory?.[0]?.mode).toBe('revert');
    expect(step?.retryHistory?.[0]?.result).toBe('completed');
    expect(step?.parentSessionId).toBe('child-1');
    expect(subagents.followups.some(item => item.childId === step?.sessionMeta?.childId)).toBe(true);
  });

  it('lists the available closed-turn revert boundaries for a failed agent step', async () => {
    const { ctx: _ctx, engine, persistence, llm, agents, sessions } = await harness();
    void _ctx;
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);

    const child = new FakeAgent('child-1');
    agents.register(child);

    // 不实际跑实例：直接放一个 running→failed 的 step 快照 + child-1 会话事件。
    const now = new Date().toISOString();
    const state: WorkflowTaskState = {
      taskId: 'inst-list',
      workflowId: 'wfl-agent-fail',
      cwd: '/tmp',
      status: 'failed',
      originalInput: 'do it',
      currentStageId: 'stg-1',
      executedSteps: [{
        id: 'exec-1',
        stepId: 'step-agent',
        stageId: 'stg-1',
        name: 'step-agent',
        status: 'failed',
        command: { type: 'agent', value: { promptText: 'do' } },
        sessionMeta: { childId: 'child-1', synthetic: false, command: 'agent' },
        visitCount: 1,
        error: 'boom',
      }],
      stageInfos: [{ id: 'stg-1', name: 'stage', status: 'failed' }],
      pendingInteractions: [],
      pendingQueue: [],
      visitCounts: {},
      passThroughVars: {},
      activeLoopIterationStack: [],
      activeLoopNodeId: null,
      activeLoopStack: [],
      pausedChildIds: [],
      stageContracts: {},
      createdAt: now,
      updatedAt: now,
    };
    void persistence.state.put('inst-list', state);

    const childSession = sessions.create('child-1');
    childSession.append('turn/start', { turn: 0 });
    childSession.append('assistant/message', assistantMessageEvent([{ type: 'text', text: 'first' }]).data);
    childSession.append('turn/end', { turn: 0, reason: { kind: 'completed' } });
    childSession.append('turn/start', { turn: 1 });
    childSession.append('assistant/message', assistantMessageEvent([{ type: 'text', text: 'second' }]).data);
    childSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    childSession.append('turn/start', { turn: 2 });
    childSession.append('assistant/message', assistantMessageEvent([{ type: 'text', text: 'unmatched' }]).data);

    const boundaries = engine.listRevertBoundaries('inst-list', 'step-agent');
    // 仅两个闭合 turn 候选（seq 2、5）；未闭合尾部 turn 2（turn/start seq 6）不计入。
    expect(boundaries).toEqual([
      { seq: 2, turn: 0, preview: 'first' },
      { seq: 5, turn: 1, preview: 'second' },
    ]);
  });

  it('auto-reverts fork to the last closed turn/end when the source session has an unclosed tail', async () => {
    const { ctx, engine, persistence, llm, agents, subagents, sessions } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);

    const child = new FakeAgent('child-1');
    agents.register(child);

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-agent-fail', originalInput: 'do it', cwd: '/tmp' });
    await ended;
    expect(persistence.state.get(run.instanceId)?.status).toBe('failed');

    // fork 源：turn 0 闭合（seq 0-2），turn 1 未闭合（turn/start seq 3 + assistant seq 4，无 turn/end）。
    // FakeSessionStore.fork 忠实模拟 DSH：fork(undefined) 会抛 OPEN_TURN（末事件 4 落在未闭合 turn 1）。
    // recovery-manager fork 防御必须先算 boundary=2（最后一个闭合 turn/end）再 fork，避开 OPEN_TURN。
    const childSession = sessions.create('child-1');
    childSession.append('turn/start', { turn: 0 });
    childSession.append('assistant/message', assistantMessageEvent([{ type: 'text', text: 'fork output' }]).data);
    childSession.append('turn/end', { turn: 0, reason: { kind: 'completed' } });
    childSession.append('turn/start', { turn: 1 });
    childSession.append('assistant/message', assistantMessageEvent([{ type: 'text', text: 'unmatched tail' }]).data);

    await engine.retryStep(run.instanceId, 'step-agent', 'fork', 'fork it');

    const state = persistence.state.get(run.instanceId);
    // 防御生效：未抛 OPEN_TURN，实例完成（新 agent 续跑输出 fork output）。
    expect(state?.status).toBe('completed');
    const step = lastSegmentOf(state?.executedSteps ?? [], 'step-agent');
    expect(step?.output).toEqual([{ type: 'text', text: 'fork output' }]);
    expect(step?.sessionMeta?.childId).toMatch(UUID_RE);
    expect(step?.parentSessionId).toBe('child-1');
    expect(step?.retryHistory?.[0]?.mode).toBe('fork');
    expect(step?.retryHistory?.[0]?.result).toBe('completed');
    expect(subagents.followups.some(item => item.childId === step?.sessionMeta?.childId)).toBe(true);
  });

  it('truly re-runs an empty-executedSteps non-terminal snapshot to completed (no fake recovery)', async () => {
    const { ctx, engine, persistence, sessions } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);

    await persistence.state.put('inst-running', runningSnapshot('inst-running', 'wfl-shell-only'));
    sessions.create('inst-running');

    const ended = waitForEnd(ctx);
    const result = await engine.recoverInstance('inst-running');
    expect(result).toEqual({ instanceId: 'inst-running', status: 'running' });
    await ended;

    const state = persistence.state.get('inst-running');
    expect(state?.status).toBe('completed');
    expect(state?.executedSteps).toHaveLength(1);
    expect(state?.executedSteps[0]?.stepId).toBe('step-shell');
    expect(state?.executedSteps[0]?.status).toBe('completed');
  });

  it('resumes the host agent before following up the child subagent during recovery', async () => {
    const { ctx, engine, persistence, sessions, agents, subagents } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);

    await persistence.state.put('inst-run', stepSnapshot('inst-run', 'wfl-agent-fail', agentStepSnapshot('running'), 'running'));
    sessions.create('inst-run');
    // 子代理 child-1 已注册并携带输出（followup 后 resumeSubagent 收集其输出）。
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'recovered output' }]));
    agents.register(child);

    const ended = waitForEnd(ctx);
    const result = await engine.recoverInstance('inst-run');
    expect(result.status).toBe('running');
    await ended;

    // 宿主主代理经 agents.resume 冷恢复，且作为 followup 的 parent（先宿主后子代理）。
    expect(agents.setupCount).toBeGreaterThanOrEqual(1);
    expect(subagents.followups).toHaveLength(1);
    expect(subagents.followups[0]?.childId).toBe('child-1');
    expect(subagents.followups[0]?.parent.id).toBe('inst-run');

    const state = persistence.state.get('inst-run');
    expect(state?.status).toBe('completed');
    expect(state?.executedSteps[0]?.output).toEqual([{ type: 'text', text: 'recovered output' }]);
  });

  it('rebuilds the paused registry from pausedChildIds and stays paused without re-running', async () => {
    const { engine, persistence, sessions, subagents } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);

    await persistence.state.put('inst-paused', pausedSnapshot('inst-paused'));
    sessions.create('inst-paused');

    const result = await engine.recoverInstance('inst-paused');
    expect(result.status).toBe('paused');
    // 不自动 followup（等待手动 resume）。
    expect(subagents.followups).toHaveLength(0);

    // 登记表已从 pausedChildIds 重建：resumeStep 可反查并 followup 原 childId。
    await engine.resumeStep('inst-paused', 'step-agent', 'continue now');
    expect(subagents.followups).toHaveLength(1);
    expect(subagents.followups[0]?.childId).toBe('child-1');
  });

  it('marks an unrecoverable synthetic (shell) running step as failed during recovery', async () => {
    const { engine, persistence, sessions } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);

    await persistence.state.put('inst-shell', stepSnapshot('inst-shell', 'wfl-shell-only', shellStepSnapshot('running'), 'running'));
    sessions.create('inst-shell');

    const result = await engine.recoverInstance('inst-shell');
    expect(result.status).toBe('failed');

    const state = persistence.state.get('inst-shell');
    expect(state?.status).toBe('failed');
    expect(state?.executedSteps[0]?.status).toBe('failed');
    expect(state?.executedSteps[0]?.error).toContain('not recoverable');
  });

  it('recoverOrphanedInstances scans the state table, skips terminal, and recovers non-terminal', async () => {
    const { engine, persistence, sessions, agents } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);

    // 终态实例（跳过）。
    await persistence.state.put('inst-done', completedSnapshot('inst-done'));
    await persistence.state.put('inst-failed', { ...completedSnapshot('inst-failed'), status: 'failed' });
    await persistence.state.put('inst-aborted', { ...completedSnapshot('inst-aborted'), status: 'aborted' });

    // 非终态实例（恢复）：预建宿主 Session 供 agents.resume 后读回。
    await persistence.state.put('inst-paused', pausedSnapshot('inst-paused'));
    sessions.create('inst-paused');

    const result = await (engine as SandoreEngineRuntime).recoverOrphanedInstances();
    expect(result.recovered).toEqual(['inst-paused']);
    expect(result.errors).toHaveLength(0);
    // 宿主主代理经 agents.resume 冷恢复（setup 重跑）。
    expect(agents.setupCount).toBeGreaterThanOrEqual(1);
  });

  it('recoverOrphanedInstances aggregates a single failing instance without blocking others', async () => {
    const { engine, persistence, sessions } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);

    // 一个可恢复（定义存在 + 宿主 Session），一个定义缺失（失败进 errors）。
    await persistence.state.put('inst-ok', pausedSnapshot('inst-ok'));
    sessions.create('inst-ok');
    await persistence.state.put('inst-bad', pausedSnapshot('inst-bad', 'wfl-missing'));

    const result = await (engine as SandoreEngineRuntime).recoverOrphanedInstances();
    expect(result.recovered).toEqual(['inst-ok']);
    expect(result.errors.map(item => item.instanceId)).toEqual(['inst-bad']);
    expect(result.errors[0]?.error).toContain('not found');
  });

  it('aggregates host resume failure into errors without blocking', async () => {
    const { engine, persistence, sessions, agents } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);

    await persistence.state.put('inst-run', pausedSnapshot('inst-run'));
    sessions.create('inst-run');
    agents.setupError = new Error('resume boom');

    const result = await (engine as SandoreEngineRuntime).recoverOrphanedInstances();
    expect(result.recovered).toEqual([]);
    expect(result.errors.map(item => item.instanceId)).toEqual(['inst-run']);
    expect(result.errors[0]?.error).toContain('resume boom');
  });

  it('recovers orphaned instances automatically at Service.init (startup scan)', async () => {
    const ctx = new Context();
    const storageDomain = new MemoryStorageDomain();
    ctx.provide('storageDomain', storageDomain as unknown as DomainFacility);
    await ctx.plugin(SandorePersistence);
    const persistence = ctx.sandorePersistence;
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);
    await persistence.state.put('inst-init', pausedSnapshot('inst-init'));

    const sessions = new FakeSessionStore();
    sessions.create('inst-init');
    const agents = new FakeAgentRegistry(sessions);
    ctx.provide('sessions', sessions as unknown as SessionStore);
    ctx.provide('sessionPersistence', {});
    ctx.provide('agents', agents);
    ctx.provide('subagents', new FakeSubagents(ctx, (id) => agents.get(id)));
    ctx.provide('llm', new FakeLlm() as unknown as LlmRuntime);
    ctx.provide('shell', new FakeShell() as unknown as ShellExecutor);
    ctx.provide('subprocess', new FakeSubprocess());
    ctx.provide('userQuestions', new FakeUserQuestions());
    ctx.provide('sessionTitle', new FakeSessionTitle());
    ctx.provide('fs', {});

    await ctx.plugin(SandoreEngineRuntime, {});

    // 启动扫描自动冷恢复宿主主代理（agents.resume setup 重跑）+ 实例进内存。
    expect(agents.setupCount).toBeGreaterThanOrEqual(1);
    expect(ctx.sandoreEngine.getState('inst-init').status).toBe('paused');
  });

  it('clears stale pendingInteractions from the snapshot during recovery (defect 9 B / 27)', async () => {
    const { engine, persistence, sessions } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);

    await persistence.state.put('inst-stale', stalePendingSnapshot('inst-stale'));
    sessions.create('inst-stale');

    const result = await engine.recoverInstance('inst-stale');
    // paused-only 实例不重跑；恢复时 clearAll 清空快照 stale pendingInteractions。
    expect(result.status).toBe('paused');
    const state = persistence.state.get('inst-stale');
    expect(state?.pendingInteractions).toEqual([]);
    // 回复 stale requestId 抛 INVALID_OPERATION（InteractionManager Maps 已清空，无 ghost 条目）。
    await expect(engine.replyQuestion('inst-stale', 'req-stale', { answers: [{ id: 'q1', selected: ['A'] }] }))
      .rejects.toMatchObject({ code: 'INVALID_OPERATION' });
  });

  it('resumes a between-steps crash without re-running the completed step (defect 9 G)', async () => {
    const { ctx, engine, persistence, sessions, shell } = await harness();
    await putDefinition(persistence, 'wfl-linear-shell', linearShellYaml);
    shell.runHandler = async spec => successResult(spec, spec.command);

    await persistence.state.put('inst-between', betweenStepsSnapshot('inst-between'));
    sessions.create('inst-between');

    const ended = waitForEnd(ctx);
    const result = await engine.recoverInstance('inst-between');
    expect(result.status).toBe('running');
    await ended;

    const state = persistence.state.get('inst-between');
    expect(state?.status).toBe('completed');
    // step-a 不重跑：仅 'exec-a' 一段（无新增 step-a 段 → 非恰好一次语义成立）。
    const stepA = state?.executedSteps.filter(s => s.stepId === 'step-a') ?? [];
    expect(stepA).toHaveLength(1);
    expect(stepA[0]?.id).toBe('exec-a');
    expect(stepA[0]?.status).toBe('completed');
    // step-b 从 step-a 反推 DAG next 续跑一次完成。
    const stepB = state?.executedSteps.filter(s => s.stepId === 'step-b') ?? [];
    expect(stepB).toHaveLength(1);
    expect(stepB[0]?.status).toBe('completed');
  });

  it('marks the instance failed and clears memory when recover() followup throws (defect 11)', async () => {
    const { ctx, engine, persistence, sessions, subagents } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);

    await persistence.state.put('inst-run', stepSnapshot('inst-run', 'wfl-agent-fail', agentStepSnapshot('running'), 'running'));
    sessions.create('inst-run');
    // 注入 followup 故障：recover() 冷恢复 followup 抛错（缺陷 11 真实可抛场景收敛点）。
    subagents.followupError = new Error('cold resume boom');

    const ended = waitForEnd(ctx);
    const result = await engine.recoverInstance('inst-run');
    // catch 落 failed 终态（对齐 runAndCatch 语义）。
    expect(result.status).toBe('failed');
    await ended;

    const state = persistence.state.get('inst-run');
    expect(state?.status).toBe('failed');
    // 实例已从内存清除：二次 recoverInstance 读快照（failed 终态）抛 INVALID_OPERATION，
    // 不卡 running（修复前 followup 抛错传播出 recoverInstance → 实例残留内存 running +
    // 二次 recoverInstance no-op 永久卡 running）。
    await expect(engine.recoverInstance('inst-run')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
  });

  it('preserves extracted pass-through vars across crash recovery so the next step resolves them (defect 15)', async () => {
    const { ctx, engine, persistence, sessions, shell } = await harness();
    await putDefinition(persistence, 'wfl-recover-ptv', recoverPtvYaml);
    // shell 回显命令本身，便于断言经 replacePassThroughVars 替换后的实际命令。
    shell.runHandler = async spec => successResult(spec, spec.command);

    // 快照：running、无活跃段、无已完成 Step，但 passThroughVars 已含提取值
    // （模拟前置 Stage 已提取 projectName=sandore 后崩溃，恢复后续跑本 Stage）。
    // 当前执行段模型：persistState 全量持久化含 passThroughVars → recoverInstance
    // 全量读回 → StageExecutor.initState 播种提取值（合并顺序修复后 input 优先）→
    // step-use 的 shell 命令拿到提取值，传递链不断。
    await persistence.state.put('inst-ptv', extractedPtvSnapshot('inst-ptv'));
    sessions.create('inst-ptv');

    const ended = waitForEnd(ctx);
    const result = await engine.recoverInstance('inst-ptv');
    expect(result.status).toBe('running');
    await ended;

    const state = persistence.state.get('inst-ptv');
    expect(state?.status).toBe('completed');
    // 崩溃恢复保留：step-use 的 shell 命令拿到提取值 'sandore' 而非保留字面量 ${projectName}。
    expect(shell.specs.map(spec => spec.command)).toEqual(['echo sandore']);
    // 提取值原样保留在 state.passThroughVars（传递链不断）。
    expect(state?.passThroughVars['projectName']).toEqual({ value: 'sandore', description: '项目名' });
  });

  it('follows up all running subagent steps during multi-running crash recovery (defect 10 multi-path)', async () => {
    // 并发崩溃恢复：两个 running agent Step 同时存在快照中 → recover() 全部 followup。
    // 对齐基准恢复 E 步（遍历全部 running/interacting Step 逐一入队）。
    const multiAgentYaml = `id: wfl-multi-agent
name: multi-agent
version: "1.0.0"
stages:
  - id: stg-1
    name: 并行agent
    steps:
      - id: step-router
        branches:
          - next: step-a
          - next: step-b
      - id: step-a
        branches:
          - next: step-end
      - id: step-b
        branches:
          - next: step-end
      - id: step-end
steps:
  - id: step-router
  - id: step-a
    command:
      type: agent
      value:
        promptText: "do A"
  - id: step-b
    command:
      type: agent
      value:
        promptText: "do B"
  - id: step-end
    command:
      type: shell
      value:
        command: "echo end"
`;
    const { ctx, engine, persistence, sessions, subagents, agents, llm } = await harness();
    await putDefinition(persistence, 'wfl-multi-agent', multiAgentYaml);
    provideLlmDirectory(llm);

    // 快照：两个 running agent Step（step-a→child-1, step-b→child-2）同时存在。
    const createdAt = new Date().toISOString();
    const multiRunningSnapshot: WorkflowTaskState = {
      taskId: 'inst-multi-run',
      workflowId: 'wfl-multi-agent',
      cwd: '/tmp',
      status: 'running',
      originalInput: 'do parallel work',
      currentStageId: 'stg-1',
      executedSteps: [
        {
          id: 'exec-router',
          stepId: 'step-router',
          stageId: 'stg-1',
          name: 'step-router',
          status: 'completed',
          visitCount: 1,
          createdAt,
          attemptIndex: 0,
          loopIteration: [],
        },
        {
          id: 'exec-a',
          stepId: 'step-a',
          stageId: 'stg-1',
          name: 'step-a',
          status: 'running',
          command: { type: 'agent', value: { promptText: 'do A' } },
          sessionMeta: { childId: 'child-1', synthetic: false, command: 'agent' },
          visitCount: 1,
          createdAt,
          attemptIndex: 0,
        },
        {
          id: 'exec-b',
          stepId: 'step-b',
          stageId: 'stg-1',
          name: 'step-b',
          status: 'running',
          command: { type: 'agent', value: { promptText: 'do B' } },
          sessionMeta: { childId: 'child-2', synthetic: false, command: 'agent' },
          visitCount: 1,
          createdAt,
          attemptIndex: 0,
        },
      ],
      stageInfos: [{ id: 'stg-1', name: '并行agent', status: 'running' }],
      pendingInteractions: [],
      pendingQueue: ['step-end'],
      visitCounts: { 'step-router': 1, 'step-a': 1, 'step-b': 1 },
      passThroughVars: {},
      activeLoopIterationStack: [],
      activeLoopNodeId: null,
      activeLoopStack: [],
      pausedChildIds: [],
      stageContracts: {},
      createdAt,
      updatedAt: createdAt,
    };
    await persistence.state.put('inst-multi-run', multiRunningSnapshot);
    sessions.create('inst-multi-run');

    // 注册两个子代理（冷恢复 followup 后 whenIdle + finalAssistantOutput）。
    const child1 = new FakeAgent('child-1');
    child1.session.append(assistantMessageEvent([{ type: 'text', text: 'recovered A' }]));
    const child2 = new FakeAgent('child-2');
    child2.session.append(assistantMessageEvent([{ type: 'text', text: 'recovered B' }]));
    agents.register(child1);
    agents.register(child2);

    const ended = waitForEnd(ctx);
    const result = await engine.recoverInstance('inst-multi-run');
    expect(result.status).toBe('running');
    await ended;

    // 缺陷 10 多路恢复：两个 running agent Step 全部被 followup（不只是第一个）。
    const followups = subagents.followups.filter(f => f.parent.id === 'inst-multi-run' || f.childId === 'child-1' || f.childId === 'child-2');
    expect(followups.length).toBeGreaterThanOrEqual(2);
    const followedChildIds = new Set(followups.map(f => f.childId));
    expect(followedChildIds.has('child-1')).toBe(true);
    expect(followedChildIds.has('child-2')).toBe(true);

    // 恢复后实例完成（两个 agent 续跑 + step-end 执行）。
    const state = persistence.state.get('inst-multi-run');
    expect(state?.status).toBe('completed');
  });
});

/** 单 Stage 单 prompt Step（用于 sendStepMessage 测试：prompt 为真实可续接子代理）。 */
const promptOnlyYaml = `id: wfl-prompt-only
name: prompt-only
version: "1.0.0"
stages:
  - id: stg-1
    name: 提示
    steps:
      - id: step-prompt
steps:
  - id: step-prompt
    command:
      type: prompt
      value:
        promptText: "do it"
`;

/** 单 Stage 两个 prompt Step（P3：前一步 completed 而实例仍在 running 时的门槛断言）。 */
const twoPromptYaml = `id: wfl-two-prompt
name: two-prompt
version: "1.0.0"
stages:
  - id: stg-1
    name: 提示
    steps:
      - id: step-first
      - id: step-second
steps:
  - id: step-first
    command:
      type: prompt
      value:
        promptText: "first"
  - id: step-second
    command:
      type: prompt
      value:
        promptText: "second"
`;

describe('SandoreEngineRuntime sendStepMessage (缺陷 31: @mention 讨论消息封装端点)', () => {
  it('delivers a message to the running subagent + dual-emits sandore/step-message + does NOT write userMessages', async () => {
    const { ctx, engine, persistence, llm, agents, subagents, sessions } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);
    provideLlmDirectory(llm);

    // 注册挂起 agent：status='running' → 不自动 settle（collectSubagentOutput 挂起等待），
    // 保持 step-agent running 不进入终态，供 sendStepMessage 测试。
    const child = new FakeAgent('child-1');
    child.status = 'running';
    agents.register(child);

    const messageEvents: Array<{ info: unknown; stepId: string; childId: string; message: string; name: string }> = [];
    ctx.on('sandore/step-message', (info, stepId, childId, message, name) =>
      messageEvents.push({ info, stepId, childId, message, name }),
    );

    const stepStarted = waitForStepStart(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-agent-fail', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;
    // 等待 onChildStarted 把 sessionMeta 切为 synthetic=false + childId='child-1'。
    await vi.waitFor(() => {
      const step = persistence.state.get(run.instanceId)?.executedSteps.find(s => s.stepId === 'step-agent');
      expect(step?.sessionMeta?.synthetic).toBe(false);
      expect(step?.sessionMeta?.childId).toBe('child-1');
    });

    await engine.sendStepMessage(run.instanceId, 'step-agent', '请确认参数');

    // followup 收到消息：childId 指向运行中子代理，content 为用户消息文本。
    expect(subagents.followups).toHaveLength(1);
    expect(subagents.followups[0]?.childId).toBe('child-1');
    expect(subagents.followups[0]?.content).toEqual([{ type: 'text', text: '请确认参数' }]);
    expect(subagents.followups[0]?.options.source).toMatchObject({ kind: 'user' });

    // 新语义：**不写 state.userMessages**（讨论页只展示 step agent 消息与主代理消息；
    // 该消息本身已在子代理会话里，投递凭据是 sandore/step-message 事件）。
    const state = persistence.state.get(run.instanceId);
    const messages = state?.userMessages?.filter(m => m.kind === 'message') ?? [];
    expect(messages).toHaveLength(0);
    // 原始需求那条 kind:'input' 仍在（真实用户输入不受影响）。
    expect(state?.userMessages?.filter(m => m.kind === 'input')).toHaveLength(1);

    // 单发 sandore/step-message：Cordis emit（listener 触发；Round 25 去污染：宿主会话不再承载）。
    expect(messageEvents).toHaveLength(1);
    expect(messageEvents[0]?.stepId).toBe('step-agent');
    expect(messageEvents[0]?.childId).toBe('child-1');
    expect(messageEvents[0]?.message).toBe('请确认参数');
    expect(messageEvents[0]?.name).toBe('step-agent');

    // 清理：让挂起的 Step 正常完成（append assistant 输出 + settle completed），令 run 收敛。
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    subagents.settleChild('child-1', 'completed');
    await waitForEnd(ctx);
  });

  it('forwards a message to a running prompt subagent (决策 D3: prompt 为真实子代理, 缺陷 31)', async () => {
    const { ctx, engine, persistence, llm, agents, subagents, sessions } = await harness();
    await putDefinition(persistence, 'wfl-prompt-only', promptOnlyYaml);
    provideLlmDirectory(llm);
    // prompt Step 挂起：child status='running' 不自动 settle（collectSubagentOutput 等待），
    // 保持 step-prompt running，供 sendStepMessage 测试。
    const child = new FakeAgent('child-1');
    child.status = 'running';
    agents.register(child);

    const messageEvents: Array<{ info: unknown; stepId: string; childId: string; message: string; name: string }> = [];
    ctx.on('sandore/step-message', (info, stepId, childId, message, name) =>
      messageEvents.push({ info, stepId, childId, message, name }),
    );

    const stepStarted = waitForStepStart(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-prompt-only', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;
    // 等待 onChildStarted 把 sessionMeta 切为 synthetic=false + childId='child-1'。
    await vi.waitFor(() => {
      const step = persistence.state.get(run.instanceId)?.executedSteps.find(s => s.stepId === 'step-prompt');
      expect(step?.sessionMeta?.synthetic).toBe(false);
      expect(step?.sessionMeta?.childId).toBe('child-1');
    });

    await engine.sendStepMessage(run.instanceId, 'step-prompt', 'hi');

    // prompt 为真实子代理：投递收到消息（childId 指向运行中子代理）+ 单发
    // sandore/step-message；state.userMessages **不新增**（新语义）。
    expect(subagents.followups).toHaveLength(1);
    expect(subagents.followups[0]?.childId).toBe('child-1');
    expect(subagents.followups[0]?.content).toEqual([{ type: 'text', text: 'hi' }]);
    const state = persistence.state.get(run.instanceId);
    const messages = state?.userMessages?.filter(m => m.kind === 'message') ?? [];
    expect(messages).toHaveLength(0);
    expect(state?.userMessages?.filter(m => m.kind === 'input')).toHaveLength(1);
    expect(messageEvents).toHaveLength(1);

    // 清理：append 输出 + settle completed，令 run 收敛。
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    subagents.settleChild('child-1', 'completed');
    await waitForEnd(ctx);
  });

  it('P3: rejects a step whose latest segment is NOT running/interacting (paused) and suggests the next action', async () => {
    const { ctx, engine, persistence, llm, agents, subagents } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);
    provideLlmDirectory(llm);
    // shell 段（synthetic，非子代理）+ prompt 段（真实可续接子代理，挂起保持 running）。
    const promptChild = new FakeAgent('child-1');
    promptChild.status = 'running';
    agents.register(promptChild);

    const stepStarted = waitForStepStart(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;
    await vi.waitFor(() => {
      expect(
        persistence.state.get(run.instanceId)?.executedSteps.find(s => s.stepId === 'step-prompt')?.sessionMeta?.childId,
      ).toBe('child-1');
    });

    // ① 结构检查优先于状态门槛：已完成的 shell 段仍报「非子代理」（更精确的错因），
    //    不会被笼统报成「状态不可接收」。
    await expect(engine.sendStepMessage(run.instanceId, 'step-abc', 'hi'))
      .rejects.toThrow(/non-subagent step/);

    // ② running 的 prompt 段可收（门槛不误伤正常路径）。
    await engine.sendStepMessage(run.instanceId, 'step-prompt', 'hi');
    expect(subagents.followups).toHaveLength(1);

    // ③ 暂停后同一段不可收：错误含当前状态 + 可自纠的建议动作，且**没有**任何投递/落盘。
    await engine.pauseAllSteps(run.instanceId);
    await vi.waitFor(() => {
      expect(
        persistence.state.get(run.instanceId)?.executedSteps.find(s => s.stepId === 'step-prompt')?.status,
      ).toBe('paused');
    });
    const followupsBefore = subagents.followups.length;
    const kindMessageCount = (): number =>
      (persistence.state.get(run.instanceId)?.userMessages ?? []).filter(m => m.kind === 'message').length;
    // 新语义下 kind:'message' 恒为 0（投递不写 state），此处锁住「被拒的投递仍然不写」。
    expect(kindMessageCount()).toBe(0);
    await expect(engine.sendStepMessage(run.instanceId, 'step-prompt', 'again'))
      .rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    await expect(engine.sendStepMessage(run.instanceId, 'step-prompt', 'again'))
      .rejects.toThrow(/status 'paused'[\s\S]*sandore_workflow_control \{action:"continue"\}/);
    expect(subagents.followups).toHaveLength(followupsBefore);
    expect(kindMessageCount()).toBe(0);

    await engine.abortInstance(run.instanceId);
  });

  it('P3: rejects a COMPLETED step while the instance still runs (suggestion points at the completed state)', async () => {
    const { ctx, engine, persistence, llm, agents } = await harness();
    await putDefinition(persistence, 'wfl-two-prompt', twoPromptYaml);
    provideLlmDirectory(llm);
    // 第一步：idle + 已有输出 → 自动 settle completed；第二步：挂起 running。
    const first = new FakeAgent('child-1');
    first.session.append(assistantMessageEvent([{ type: 'text', text: 'first done' }]));
    agents.register(first);
    const second = new FakeAgent('child-2');
    second.status = 'running';
    agents.register(second);

    const stepStarted = waitForStepStart(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-two-prompt', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;
    await vi.waitFor(() => {
      const steps = persistence.state.get(run.instanceId)?.executedSteps ?? [];
      expect(steps.find(s => s.stepId === 'step-first')?.status).toBe('completed');
      expect(steps.find(s => s.stepId === 'step-second')?.status).toBe('running');
    });

    // 向**已完成**的 step 发消息：拒绝 + 说明已完成（不是静默投递到静止会话）。
    await expect(engine.sendStepMessage(run.instanceId, 'step-first', 'hi'))
      .rejects.toThrow(/status 'completed'[\s\S]*已完成，无需再发消息/);
    // 同时，running 的那一步仍然可收（门槛按「每个 stepId 的最新段」判定）。
    await engine.sendStepMessage(run.instanceId, 'step-second', 'hi');

    second.session.append(assistantMessageEvent([{ type: 'text', text: 'second done' }]));
    await engine.abortInstance(run.instanceId).catch(() => undefined);
  });

  it('resumeAllSteps（工具 continue scope=all）不新增 state.userMessages，指令仍投递到子代理', async () => {
    const { ctx, engine, persistence, llm, agents, subagents } = await harness();
    await putDefinition(persistence, 'wfl-prompt-only', promptOnlyYaml);
    provideLlmDirectory(llm);
    const child = new FakeAgent('child-1');
    child.status = 'running';
    agents.register(child);

    const stepStarted = waitForStepStart(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-prompt-only', originalInput: '原始需求 do it', cwd: '/tmp' });
    await stepStarted;
    await vi.waitFor(() => {
      expect(persistence.state.get(run.instanceId)?.executedSteps.find(s => s.stepId === 'step-prompt')?.status).toBe('running');
    });

    const userMessagesOf = () => persistence.state.get(run.instanceId)?.userMessages ?? [];
    // 起点：只有 makeInitialState 写的那条原始需求（真实用户输入，保留）。
    expect(userMessagesOf()).toHaveLength(1);
    expect(userMessagesOf()[0]?.kind).toBe('input');
    expect(userMessagesOf()[0]?.content).toBe('原始需求 do it');

    await engine.pauseAllSteps(run.instanceId);
    await vi.waitFor(() => {
      expect(persistence.state.get(run.instanceId)?.pausedChildIds).toContain('child-1');
    });
    const pausedSnapshot = userMessagesOf();
    await engine.resumeAllSteps(run.instanceId, '请继续完成当前任务');
    // 关键断言：实例状态一条都不新增（用户要求：discussion 页不出现这条用户消息）。
    expect(userMessagesOf()).toEqual(pausedSnapshot);
    expect(userMessagesOf()).toHaveLength(1);
    // 指令确实投递到了子代理（只是不再进实例状态）。
    expect(subagents.followups.at(-1)?.content).toEqual([{ type: 'text', text: '请继续完成当前任务' }]);

    await engine.abortInstance(run.instanceId);
  });

  it('resumeStep（工具 continue 定点）不新增 state.userMessages，指令仍投递到子代理', async () => {
    const { ctx, engine, persistence, llm, agents, subagents } = await harness();
    await putDefinition(persistence, 'wfl-prompt-only', promptOnlyYaml);
    provideLlmDirectory(llm);
    const child = new FakeAgent('child-1');
    child.status = 'running';
    agents.register(child);

    const stepStarted = waitForStepStart(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-prompt-only', originalInput: '原始需求 do it', cwd: '/tmp' });
    await stepStarted;
    await vi.waitFor(() => {
      expect(persistence.state.get(run.instanceId)?.executedSteps.find(s => s.stepId === 'step-prompt')?.status).toBe('running');
    });

    await engine.pauseStep(run.instanceId, 'step-prompt');
    await vi.waitFor(() => {
      expect(persistence.state.get(run.instanceId)?.pausedChildIds).toContain('child-1');
    });
    await engine.resumeStep(run.instanceId, 'step-prompt', '再来一次');

    const userMessages = persistence.state.get(run.instanceId)?.userMessages ?? [];
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.kind).toBe('input');
    expect(subagents.followups.at(-1)?.content).toEqual([{ type: 'text', text: '再来一次' }]);

    await engine.abortInstance(run.instanceId);
  });

  it('rejects a terminal instance with INVALID_OPERATION (缺陷 31)', async () => {
    const { ctx, engine, persistence, llm, shell, agents } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);
    shell.runHandler = async spec => successResult(spec, 'hello');
    provideLlmDirectory(llm);
    llm.streamHandler = () => textChunks('summary');
    // prompt Step 走可续接子代理：注册真实 childId 并回填最终输出。
    const promptChild = new FakeAgent('child-1');
    promptChild.session.append(assistantMessageEvent([{ type: 'text', text: 'summary' }]));
    agents.register(promptChild);

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp' });
    await ended;
    expect(persistence.state.get(run.instanceId)?.status).toBe('completed');

    await expect(engine.sendStepMessage(run.instanceId, 'step-abc', 'hi')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
  });

  it('throws NODE_NOT_FOUND for an unknown instance (缺陷 31)', async () => {
    const { engine } = await harness();
    await expect(engine.sendStepMessage('inst-none', 'step-agent', 'hi')).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
  });

  it('throws INVALID_OPERATION for an unknown stepId (缺陷 31)', async () => {
    const { ctx, engine, persistence, llm, agents, subagents } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);
    provideLlmDirectory(llm);

    const child = new FakeAgent('child-1');
    child.status = 'running';
    agents.register(child);

    const stepStarted = waitForStepStart(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-agent-fail', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;
    await vi.waitFor(() => {
      const step = persistence.state.get(run.instanceId)?.executedSteps.find(s => s.stepId === 'step-agent');
      expect(step?.sessionMeta?.childId).toBe('child-1');
    });

    await expect(engine.sendStepMessage(run.instanceId, 'step-missing', 'hi')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });

    // 清理：让挂起的 Step 正常完成（append 输出 + settle completed），令 run 收敛。
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    subagents.settleChild('child-1', 'completed');
    await waitForEnd(ctx);
  });
});

/** 配置 agent Step 可解析的 provider/model 目录（resolveProviderModel L3 兜底）。 */
function provideLlmDirectory(llm: FakeLlm): void {
  llm.providers.push({ id: 'p', name: 'Provider' });
  llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
}

describe('complex workflow e2e', () => {
  /**
   * 复杂工作流 e2e：代码审查与修复流程，覆盖 prompt 命令 + shell 命令 + 条件分支
   * （shouldExecute）+ 并行分支（无 condition 多 next）+ 循环（loop + breakCondition
   * shouldBreak + maxIterations）+ 收尾门禁（gates primary/secondary）+ 跨 Stage。
   *
   * mock llm.streamHandler 按首条消息文本分发：含 'shouldExecute' → 批量条件分支 JSON
   * （分支 id 数组）；含 'shouldBreak' → 循环跳出 JSON（首次 false 继续、二次 true 跳出）；含
   * 'hasAsk' → 收尾 assess JSON（提取 projectName=sandore）；其余 → secondary 门禁
   * JSON（primary 为纯代码产物校验、无 AI 提示词）。prompt Step（step-finalize）自身
   * 输出来自可续接子代理会话（决策 D3）。mock shell.runHandler 回显命令对应 stdout。
   */
  it('runs the review-fix flow across two stages with branches, parallel, loop, and gates to completed', async () => {
    const { ctx, engine, persistence, llm, shell, agents, subagents } = await harness();
    await putDefinition(persistence, 'wfl-complex', complexReviewFixYaml);
    provideLlmDirectory(llm);
    // shell.runHandler：按命令回显对应 stdout（便于产物/事件断言）。
    const stdoutByCommand: Record<string, string> = {
      'echo scan': 'scan-output',
      'echo fix': 'fix-output',
      'echo report': 'report-output',
      'echo merge': 'merge-output',
      'echo iter': 'iter-output',
      'echo stage1-done': 'stage1-done',
    };
    shell.runHandler = async spec => successResult(spec, stdoutByCommand[spec.command] ?? 'ok');
    // step-finalize 为 prompt Step，走可续接子代理（决策 D3）：注册真实 childId 并回填输出。
    const promptChild = new FakeAgent('child-1');
    promptChild.session.append(assistantMessageEvent([{ type: 'text', text: 'final-analysis' }]));
    agents.register(promptChild);
    // Phase C secondary 门禁经 startContinuable 建宿主可续接子代理（child-2，与 step
    // 执行子代理同机制）：预注册 FakeAgent 并回填门禁审查输出（gateStatus done）——
    // 门禁 AI 走子代理 agent loop，不消费 llm.stream。
    const gateChild = new FakeAgent('child-2');
    gateChild.session.append(assistantMessageEvent([{ type: 'text', text: '{"gateStatus":"done"}' }]));
    agents.register(gateChild);

    // 条件分支/循环跳出/收尾各走专用模板（其「## 返回格式」节含对应字段名），
    // mock 据首条消息文本含哪个字段名分发对应 JSON。循环跳出首次 false、二次 true
    // （演示 continue 与 break 两条 loopMeta 路由条目均回写）。prompt Step 自身输出
    // 来自子代理会话（不再消费 llm.stream）。primary 门禁为纯代码产物校验（零 AI），
    // 无对应 AI 提示词——secondary 门禁经 startContinuable 子代理 settle 审查
    // （gateStatus done），亦不消费 llm.stream；Phase B 收尾走降级 llm.stream
    // （compressedOutput 合并 JSON）。
    let breakCall = 0;
    llm.streamHandler = (options) => {
      const text = (options.messages[0]?.content[0] as TextBlock | undefined)?.text ?? '';
      if (text.includes('shouldExecute')) {
        // Round 20：批量模板——返回满足条件的分支 id 数组（branchId = branch.next）。
        return textChunks('{"shouldExecute": ["step-fix"]}');
      }
      if (text.includes('shouldBreak')) {
        breakCall += 1;
        return textChunks(breakCall === 1 ? '{"shouldBreak": false}' : '{"shouldBreak": true}');
      }
      if (text.includes('compressedOutput')) {
        // Phase B 收尾（降级 llm.stream）：透传变量提取 + 压缩摘要合并 JSON。
        return textChunks('{"passThroughVars":{"projectName":"sandore"},"compressedOutput":"finalize 摘要"}');
      }
      if (text.includes('hasAsk')) {
        return textChunks('{"hasAsk":false,"passThroughVars":{"projectName":"sandore"}}');
      }
      // 理论不可达（收尾真 fork 后无其他 llm.stream 消费方）；兜底返回门禁通过。
      return textChunks('{"gateStatus":"done"}');
    };

    const records = recordSandoreEvents(ctx);
    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-complex', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');

    const stepIds = state?.executedSteps.map(step => step.stepId) ?? [];

    // ── 顺序：Stage 1 首步 step-scan → 路由门 step-route（条件评估现场保留）。
    expect(stepIds[0]).toBe('step-scan');
    expect(stepIds[1]).toBe('step-route');
    const routeEntry = state?.executedSteps.find(step => step.stepId === 'step-route');
    expect(routeEntry?.branchMeta?.status).toBe('completed');
    expect(routeEntry?.branchMeta?.result).toBe('{"shouldExecute": ["step-fix"]}');

    // ── 并行分支（无 condition）+ 条件分支（shouldExecute=true）：step-fix 与 step-report
    //    均执行（并发，Promise.all）；两者顺序不假定（mock 同步但并发调度），以 Set 断言
    //    且确认二者均落在 step-route 之后、step-merge 之前。
    const parallelPair = new Set(stepIds.slice(2, 4));
    expect(parallelPair).toEqual(new Set(['step-fix', 'step-report']));
    expect(stepIds[4]).toBe('step-merge');
    // 汇合节点仅执行一次（nextBatch dedupe）。
    expect(stepIds.filter(id => id === 'step-merge')).toHaveLength(1);

    // ── 循环（loop + breakCondition shouldBreak + maxIterations）：循环门 step-loop 出现
    //    两次（continue 透传 loopMeta + break 透传 loopMeta，缺陷 23）；循环体 step-iter
    //    仅执行一次（首趟 continue 后跑一次，第二趟 break 直接跳出未再跑 body）。
    expect(stepIds[5]).toBe('step-loop');
    expect(stepIds[6]).toBe('step-iter');
    expect(stepIds[7]).toBe('step-loop');
    const loopEntries = state?.executedSteps.filter(step => step.stepId === 'step-loop') ?? [];
    expect(loopEntries).toHaveLength(2);
    // continue 与 break 两条路由条目均回写 loopMeta(completed) 且携带 shouldBreak 评估现场。
    expect(loopEntries.every(entry => entry.loopMeta?.status === 'completed')).toBe(true);
    expect(loopEntries[0]?.loopMeta?.result).toContain('shouldBreak');
    expect(loopEntries[1]?.loopMeta?.result).toContain('shouldBreak');
    // continue=false 现场（首趟）、break=true 现场（次趟）。
    expect(loopEntries[0]?.loopMeta?.result).toBe('{"shouldBreak": false}');
    expect(loopEntries[1]?.loopMeta?.result).toBe('{"shouldBreak": true}');
    const iterEntries = state?.executedSteps.filter(step => step.stepId === 'step-iter') ?? [];
    expect(iterEntries).toHaveLength(1);

    // ── 跨 Stage：Stage 1 收尾 step-exit → Stage 2 step-finalize。
    expect(stepIds[8]).toBe('step-exit');
    expect(stepIds[9]).toBe('step-finalize');
    // 两个 Stage 均完成，契约落盘（跨 Stage 推进由 tryAdvanceStage 承接）。
    expect(state?.stageInfos.map(info => info.status)).toEqual(['completed', 'completed']);
    expect(Object.keys(state?.stageContracts ?? {})).toHaveLength(2);

    // ── 收尾门禁（gates primary/secondary）：step-finalize 的 finalizeMeta 记录
    //    gateResult。primary 为纯代码产物校验（无 outputTo → 通过，零 AI），
    //    secondary 为 AI 门禁审查（显式 enabled:true）→ 两者均通过 → gatesPassed=true。
    const finalizeStep = state?.executedSteps.find(step => step.stepId === 'step-finalize');
    expect(finalizeStep?.status).toBe('completed');
    expect(finalizeStep?.finalizeMeta?.currentPhase).toBe('completed');
    expect(finalizeStep?.finalizeMeta?.gateResult?.gatesPassed).toBe(true);
    expect(finalizeStep?.finalizeMeta?.gateResult?.primaryPassed).toBe(true);
    expect(finalizeStep?.finalizeMeta?.gateResult?.secondaryPassed).toBe(true);

    // Phase C secondary 经 startContinuable 建宿主可续接子代理（与 step 执行子代理同
    // 机制：agent loop + 工具 + preset 系统提示词；prompt 携带门禁审查要求）；
    // primary 纯代码校验不建子代理。宿主主代理也经 agents.create 创建（startInstance）
    // → agents.create 记录仅含宿主主代理（门禁不再走 agents.create）。
    const gateStart = subagents.continuableStarts[subagents.continuableStarts.length - 1];
    expect(gateStart).toBeDefined();
    // 门禁子代理同样用全新 provider（`spawn`：不继承宿主主代理会话历史）。
    expect(gateStart?.provider).toBe('spawn');
    expect(gateStart?.request.parent.id).toBe(run.instanceId);
    const gatePrompt = (gateStart?.request.prompt[0] as { type: string; text: string } | undefined)?.text ?? '';
    expect(gatePrompt).toContain('gateStatus');
    // gateSessionId = startContinuable 返回的真实 childId（UI 可打开；settle 侧由 DSH
    // dispose，mock 中仍留在 registry）。
    const gateSessionId = finalizeStep?.finalizeMeta?.gateResult?.gateSessionId ?? '';
    expect(gateSessionId).toBe('child-2');
    expect(agents.get(gateSessionId)).toBeDefined();
    expect(agents.get(gateSessionId)?.session.events.some(event =>
      event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text.includes('gateStatus')),
    )).toBe(true);

    // ── 产物收集：step-finalize prompt 自身输出为 'final-analysis'（子代理会话输出）。
    expect(finalizeStep?.output).toEqual([{ type: 'text', text: 'final-analysis' }]);

    // ── 透传变量提取：assess 提取 projectName=sandore 并保留 Step 定义中的 description。
    expect(state?.passThroughVars['projectName']).toEqual({ value: 'sandore', description: '项目名' });

    // ── Stage 1 契约产物：step-scan 声明 outputTo(opt-scan)，契约 artifacts 含对应条目。
    const reviewContract = state?.stageContracts['stg-review'];
    expect(reviewContract?.status).toBe('completed');
    expect(reviewContract?.artifacts.find(item => item.outputToId === 'opt-scan')?.stepId).toBe('step-scan');

    // ── shell 命令覆盖：6 个 shell Step 各跑一次（step-finalize 为 prompt，不跑 shell）。
    //    并行分支(step-report)在条件分支(step-fix)之前纳入 nextNodeIds（resolveNextNodes
    //    先处理无 condition 的并行分支再评估条件分支），故 shell 调用序为 report → fix。
    expect(shell.specs.map(spec => spec.command)).toEqual([
      'echo scan',
      'echo report',
      'echo fix',
      'echo merge',
      'echo iter',
      'echo stage1-done',
    ]);

    // ── llm 调用覆盖：条件分支 1 + 循环跳出 2 + Phase A assess 1 + Phase B 重新
    //    assess 1（偏离 2：不复用 Phase A 结果）= 5 次（收尾真 fork 后 Phase B 降级
    //    走 llm.stream——child-1 无事件源；primary 纯代码校验零 AI；secondary 走宿主
    //    子代理驱动轮不消费 llm.stream；prompt Step 输出来自子代理会话）。
    expect(llm.calls).toHaveLength(5);

    // ── 事件序：start → 两 Stage 各 stage-start/step-*/stage-completed → end。
    expect(records[0]?.name).toBe('sandore/start');
    expect(records[records.length - 1]?.name).toBe('sandore/end');
    const stageStarts = records.filter(r => r.name === 'sandore/stage-start').map(r => r.args[1]);
    expect(stageStarts).toEqual(['stg-review', 'stg-gate']);
    const stageCompleted = records.filter(r => r.name === 'sandore/stage-completed').map(r => r.args[1]);
    expect(stageCompleted).toEqual(['stg-review', 'stg-gate']);
    // 终态 end 为 completed。
    expect((records[records.length - 1]?.args[1] as { status: string }).status).toBe('completed');
  });
});

/** 单 prompt Step（未解析透传变量）——Phase B 真 fork 的引擎级集成。 */
const forkBPhaseYaml = `id: wfl-fork-b
name: fork-b
version: "1.0.0"
stages:
  - id: stg-1
    name: 收尾真fork
    steps:
      - id: step-p
steps:
  - id: step-p
    command:
      type: prompt
      value:
        promptText: "do it"
    passThroughVars:
      - name: projectName
        value: "\${projectName}"
        description: "项目名"
`;

/** prompt Step → 虚拟条件路由节点（无透传变量/门禁）——Phase D 路由 fork 的 routingForkConfig
 * （hostAgentId + hostAgent 成对注入）引擎级集成。branchMeta 落在虚拟路由节点条目上。 */
const routingForkYaml = `id: wfl-routing-fork
name: routing-fork
version: "1.0.0"
stages:
  - id: stg-1
    name: 路由fork
    steps:
      - id: step-p
      - id: step-route
        branches:
          - condition:
              type: prompt
              value:
                promptText: "route"
            next: step-matched
      - id: step-matched
        branches: []
steps:
  - id: step-p
    command:
      type: prompt
      value:
        promptText: "do it"
  - id: step-route
  - id: step-matched
    command:
      type: shell
      value:
        command: "echo matched"
`;

describe('SandoreEngineRuntime 收尾真 fork（Phase B agents.create 重建宿主子代理）', () => {
  it('Phase B 真 fork：agents.create 收到 seed=完整事件 + meta.parentSession=宿主主代理 + origin=subagent；透传变量在 Phase B 回写', async () => {
    const { ctx, engine, persistence, llm, shell, sessions, agents } = await harness();
    await putDefinition(persistence, 'wfl-fork-b', forkBPhaseYaml);
    provideLlmDirectory(llm);
    shell.runHandler = async spec => successResult(spec, 'done');
    // prompt Step（step-p）走可续接子代理：注册真实 childId 并回填最终输出。
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'work output' }]));
    agents.register(child);
    // 源子代理完整事件（live store 仍可读）→ Phase B 真 fork 的 seed（闭合 turn：4 条事件）。
    const childSession = sessions.create('child-1');
    childSession.append('turn/start', { turn: 0 });
    childSession.append('user/message', { id: 'u1', content: [{ type: 'text', text: 'do it' }] });
    childSession.append('assistant/message', assistantMessageEvent([{ type: 'text', text: 'work output' }]).data);
    childSession.append('turn/end', { turn: 0, reason: { kind: 'completed' } });
    // Phase B 真 fork 的评估回复（一个 LLM 调用返回合并 JSON：passThroughVars + compressedOutput）。
    agents.createFollowupHandler = () => [{ type: 'text', text: '{"passThroughVars":{"projectName":"sandore"},"compressedOutput":"step 压缩摘要"}' }];

    // Phase A 评估临时会话 1 次（completed JSON）；Phase B 真 fork 走子代理不消费 llm.stream；
    // compressStepOutput 已移除（压缩摘要由 Phase B JSON 的 compressedOutput 承担）→ 无额外调用。
    llm.streamHandler = () => textChunks('{"hasAsk":false,"passThroughVars":{}}');

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-fork-b', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');

    // Phase B 真 fork：agents.create 收到 seed = 完整事件 + meta（parentSession=宿主主代理、
    // origin='subagent'、isSeeded=true、delegationDepth=1；上游适配：seedLength 已删，
    // 前缀长度移到顶层 inheritedEventCount=4）。create 记录序 = [宿主主代理, fork 子代理]。
    const forkMeta = agents.createMetas[agents.createMetas.length - 1];
    expect(agents.createSeeds[agents.createSeeds.length - 1]).toEqual(childSession.events);
    expect(forkMeta).toMatchObject({ cwd: '/tmp', parentSession: run.instanceId, isSeeded: true, origin: 'subagent', delegationDepth: 1 });
    expect(agents.createInheritedEventCounts[agents.createInheritedEventCounts.length - 1]).toBe(childSession.events.length);
    // 驱动一轮：followup 收到收尾处理提示词（含 compressedOutput 格式）、whenIdle 被 await。
    const forkedAgent = agents.createdAgents[agents.createdAgents.length - 1]!;
    expect(forkedAgent.followups).toHaveLength(1);
    const promptText = (forkedAgent.followups[0]?.content[0] as { type: string; text: string } | undefined)?.text ?? '';
    // 2026-08-25：fork 版不注入参考信息节（上下文在会话里）；降级才注入。
    expect(promptText).not.toContain('<ReferenceInfo>');
    expect(promptText).toContain('compressedOutput');
    expect(forkedAgent.whenIdleCount).toBe(1);

    // T2（真机缺陷修复）：引擎自建的评估 fork 会话必须带 DSH 子代理身份事件
    // （`subagent/descriptor`），否则子代理列表把它显示成「会话记录损坏」。
    const forkSession = sessions.get(forkedAgent.id);
    expect(forkSession, '评估 fork 会话应在 sessions 里').toBeDefined();
    const descriptor = forkSession!.snapshotEvents().find(event => event.type === 'subagent/descriptor');
    expect(descriptor, '评估 fork 会话应有 subagent/descriptor 身份事件').toBeDefined();
    expect((descriptor!.data as { version?: number }).version).toBe(3);
    expect((descriptor!.data as { mode?: string }).mode).toBe('one-shot');
    // 标题形态 = `finalize <名称> · <childId>`（childId 为引擎生成的纯 UUID，无前缀）。
    const assessLabel = (descriptor!.data as { label?: string }).label ?? '';
    expect(assessLabel).toMatch(/^finalize .+ · [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // label 尾段的 childId 必须是**真实 fork 会话 id**（否则标题里的 id 无法定位会话）。
    expect(assessLabel.endsWith(` · ${forkedAgent.id}`)).toBe(true);

    // 透传变量在 Phase B 回写（保留 description）。
    expect(state?.passThroughVars['projectName']).toEqual({ value: 'sandore', description: '项目名' });
    // finalizeMeta.assessResult.forkSessionId = fork 子代理 id（finalize-{stepId}-{random}），评估完 dispose。
    // Round 17：顶层 assessSessionId 已删除，sessionId 从 assessResult.forkSessionId 内读
    const step = state?.executedSteps.find(s => s.stepId === 'step-p');
    expect(step?.finalizeMeta?.assessResult?.forkSessionId).toMatch(UUID_RE);
    expect(agents.get(step?.finalizeMeta?.assessResult?.forkSessionId ?? '')).toBeUndefined();
    // 收尾阶段流转落盘：completed 终态（Phase B finalizing → Phase D routing → completed）。
    expect(step?.finalizeMeta?.currentPhase).toBe('completed');
    // llm.stream 覆盖：仅 Phase A 临时会话 assess 1 次。**Phase B 真 fork 子代理不消费
    // llm.stream**（模型调用走 followup 驱动轮）；compressStepOutput 已删除（Phase B JSON
    // 的 compressedOutput 即压缩摘要）→ 无 compress 调用。
    expect(llm.calls).toHaveLength(1);
  });
});

describe('SandoreEngineRuntime Phase D 路由 fork（routingForkConfig：hostAgentId + hostAgent 成对注入）', () => {
  it('routing fork 的 agents.create 同时收到 meta.parentSession（hostAgentId）与 setup（hostAgent → preset 组合）', async () => {
    const { ctx, engine, persistence, llm, shell, sessions, agents } = await harness();
    await putDefinition(persistence, 'wfl-routing-fork', routingForkYaml);
    provideLlmDirectory(llm);
    shell.runHandler = async spec => successResult(spec, 'done');
    // step-p（prompt）走可续接子代理：注册真实 childId 并回填最终输出。
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'work output' }]));
    agents.register(child);
    // 源子代理完整事件（live store 仍可读）→ Phase D 路由 fork 的 seed（闭合 turn：4 条事件）。
    const childSession = sessions.create('child-1');
    childSession.append('turn/start', { turn: 0 });
    childSession.append('user/message', { id: 'u1', content: [{ type: 'text', text: 'do it' }] });
    childSession.append('assistant/message', assistantMessageEvent([{ type: 'text', text: 'work output' }]).data);
    childSession.append('turn/end', { turn: 0, reason: { kind: 'completed' } });
    // 路由 fork 子代理的评估回复（shouldExecute 分支 id 数组，命中 step-matched）。
    agents.createFollowupHandler = () => [{ type: 'text', text: '{"shouldExecute": ["step-matched"]}' }];
    // 兜底（不应被消费）：路由判断走 fork 子代理 followup，不走 llm.stream 降级。
    llm.streamHandler = () => textChunks('{"shouldExecute": ["step-matched"]}');

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-routing-fork', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    // 条件命中 step-matched（路由 fork 子代理判定）：step-p → 虚拟路由节点 step-route → step-matched。
    expect(state?.executedSteps.map(step => step.stepId)).toEqual(['step-p', 'step-route', 'step-matched']);

    // routingForkConfig 成对注入的可观测面：路由 fork 的 agents.create（meta.origin='subagent'）
    // 同时携带 meta.parentSession = 宿主主代理 id（hostAgentId）与 setup（hostAgent →
    // `agentPresets.composeFrom` 组合，继承工具集 + prompt sections）。
    const forkIndex = agents.createMetas.findIndex(meta => meta?.origin === 'subagent');
    expect(forkIndex).toBeGreaterThanOrEqual(0);
    expect(agents.createMetas[forkIndex]).toMatchObject({ parentSession: run.instanceId, origin: 'subagent' });
    expect(typeof agents.createSetups[forkIndex]).toBe('function');
    // setup 在 create 时执行：composeFrom 被调恰 1 次（宿主主代理 setup 走闭包 presets、
    // 不经 agentCtx.get，不计入）。
    expect(agents.composeFromCalls).toHaveLength(1);
    // 路由判断不消费 llm.stream（fork 子代理 followup 驱动一轮）；branchMeta 保留在
    // 虚拟路由节点条目上（sessionId = 路由子代理 UUID）。
    expect(llm.calls).toHaveLength(0);
    const branchEntry = state?.executedSteps.find(step => step.stepId === 'step-route');
    expect(branchEntry?.branchMeta?.result).toBe('{"shouldExecute": ["step-matched"]}');
    expect(branchEntry?.branchMeta?.sessionId).toMatch(UUID_RE);
  });
});
