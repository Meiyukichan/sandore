/**
 * workflow-engine.ts（SandoreEngineRuntime）的集成测试：线性执行到 completed、
 * 事件序、双发可观测、childId/sessionMeta、失败/中止终态与持久化快照。
 * @module @deepseek-ai/dsh-sandore-workflow/src/workflow-engine.spec
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
import type { SandoreConfig, SandoreEngine, WorkflowTaskState } from './index.ts';
import { SandorePersistence } from './persistence.ts';
import type { ShellExecutor } from './shell.ts';
import { parseWorkflowYaml } from './yaml-parser.ts';

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
 * secondary)，assess 提取 projectName、primary/secondary 门禁判定产物合格。
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
async function harness(config: SandoreConfig = {}): Promise<{
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
  ctx.provide('llm', llm as unknown as LlmRuntime);
  ctx.provide('shell', shell as unknown as ShellExecutor);
  ctx.provide('sessions', sessions as unknown as SessionStore);
  ctx.provide('sessionPersistence', {});
  ctx.provide('subagents', subagents);
  ctx.provide('agents', agents);
  ctx.provide('subprocess', subprocess);
  ctx.provide('userQuestions', userQuestions);
  ctx.provide('sessionTitle', sessionTitle);
  ctx.provide('fs', {});

  await ctx.plugin(SandoreEngineRuntime, config);
  const engine = ctx.sandoreEngine;
  return { ctx, engine, persistence, llm, shell, sessions, subagents, agents, userQuestions, sessionTitle };
}

/** 注册全部 sandore/* 监听器并记录事件（名称 + 参数）。 */
function recordSandoreEvents(ctx: Context): Array<{ name: string; args: unknown[] }> {
  const records: Array<{ name: string; args: unknown[] }> = [];
  ctx.on('sandore/start', info => records.push({ name: 'sandore/start', args: [info] }));
  ctx.on('sandore/stage-start', (info, stageId) => records.push({ name: 'sandore/stage-start', args: [info, stageId] }));
  ctx.on('sandore/stage-completed', (info, stageId, contract) => records.push({ name: 'sandore/stage-completed', args: [info, stageId, contract] }));
  ctx.on('sandore/step-start', (info, stepId, childId, name, loopIteration) => records.push({ name: 'sandore/step-start', args: [info, stepId, childId, name, loopIteration] }));
  ctx.on('sandore/step-completed', (info, stepId, childId, output, name, loopIteration) => records.push({ name: 'sandore/step-completed', args: [info, stepId, childId, output, name, loopIteration] }));
  ctx.on('sandore/step-failed', (info, stepId, childId, error, name, loopIteration) => records.push({ name: 'sandore/step-failed', args: [info, stepId, childId, error, name, loopIteration] }));
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
 * 命中引擎 ctx 注册的冻结监听器（与真实 DSH 在 agent scope 分发、事件沿 scope 链
 * 冒泡到引擎 ctx 等价）。返回最外层监听器（引擎冻结监听器）的决策；`next` 为内建
 * 行为替身（记录是否被调用——被调用意味着步骤未被 veto）。
 */
async function dispatchPreStep(ctx: Context, agentId: string, next: PreStepNext): Promise<PreStepDecision> {
  const thisArg = { [Context.filter]: () => true };
  const payload: PreStepPayload = {
    agent: { id: agentId },
    messages: [],
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

    const run = await engine.startInstance({ workflowId: 'wfl-linear', originalInput: 'hello world', cwd: '/tmp' });
    expect(run.status).toBe('running');

    const state = engine.getState(run.instanceId);
    expect(state.originalInput).toBe('hello world');
    expect(['pending', 'running']).toContain(state.status);
  });

  it('creates a host agent via agents.create with meta.cwd and holds it idle (no auto prompt)', async () => {
    const { engine, persistence, agents } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);

    const run = await engine.startInstance({ workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/srv/app' });

    expect(agents.createCwds).toEqual(['/srv/app']);
    expect(agents.setupCount).toBe(1);
    const hostAgent = agents.get(run.instanceId);
    expect(hostAgent).toBeDefined();
    expect(hostAgent?.status).toBe('idle');
    expect(hostAgent?.inbox.hasPending).toBe(false);
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

    const run = await engine.startInstance({ workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp' });

    expect(sessionTitle.calls).toHaveLength(1);
    // 新建宿主会话标题 = 用户输入的需求（originalInput），非实例 id。
    expect(sessionTitle.calls[0]?.title).toBe('do it');
    // rename 传入的是经 ctx.sessions.get 读回的 live 宿主 Session（同一引用）。
    expect(sessionTitle.calls[0]?.session).toBe(sessions.get(run.instanceId));
  });

  it('reuses the caller-provided host agent session when hostSessionId is given (no create, freeze applies)', async () => {
    const { ctx, engine, persistence, shell, agents, sessions } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    // 预置已存在的宿主主代理会话（模拟调用方传入复用）。
    const existingHost = new FakeAgent('host-1');
    agents.register(existingHost);
    sessions.create('host-1');
    hangingShell(shell); // 保持实例 running

    const run = await engine.startInstance({ workflowId: 'wfl-shell-only', originalInput: 'do it', cwd: '/tmp', hostSessionId: 'host-1' });
    expect(run.status).toBe('running');

    // 未新建 hostAgent（复用 host-1）：无 agents.create、无 setup 重跑。
    expect(agents.createCwds).toHaveLength(0);
    expect(agents.setupCount).toBe(0);
    expect(agents.get('host-1')).toBe(existingHost);

    // 复用的 hostAgent 同样冻结：pre-step 被 reject、下游 next 不被调用（冻结登记按
    // hostAgent.id = hostSessionId 登记，复用与新建等价）。
    const next = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] }));
    const decision = await dispatchPreStep(ctx, 'host-1', next);
    expect(decision).toEqual({ kind: 'reject' });
    expect(next).not.toHaveBeenCalled();

    // abort 清表：复用的 hostAgent 随实例生命周期结束放行（清表分支移除冻结登记）。
    const aborted = waitForAborted(ctx);
    await engine.abortInstance(run.instanceId);
    await aborted;
    const afterAbortNext = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] }));
    const afterAbort = await dispatchPreStep(ctx, 'host-1', afterAbortNext);
    expect(afterAbort).toEqual({ kind: 'enter', messages: [] });
    expect(afterAbortNext).toHaveBeenCalledTimes(1);
  });

  it('thaws the reused host agent after the workflow completes', async () => {
    const { ctx, engine, persistence, shell, agents, sessions } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    const existingHost = new FakeAgent('host-1');
    agents.register(existingHost);
    sessions.create('host-1');
    shell.runHandler = async spec => successResult(spec, 'hi');

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-shell-only', originalInput: 'do it', cwd: '/tmp', hostSessionId: 'host-1' });
    await ended;
    expect(persistence.state.get(run.instanceId)?.status).toBe('completed');

    // completed 后复用的 hostAgent 解冻：pre-step 放行（唯一解冻点同样作用于复用场景）。
    const next = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] }));
    const decision = await dispatchPreStep(ctx, 'host-1', next);
    expect(decision).toEqual({ kind: 'enter', messages: [] });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects startInstance when hostSessionId does not resolve to a live agent', async () => {
    const { engine, persistence } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);

    await expect(
      engine.startInstance({ workflowId: 'wfl-shell-only', originalInput: 'do it', cwd: '/tmp', hostSessionId: 'ghost-host' }),
    ).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
    expect(persistence.state.size).toBe(0);
  });

  it('does not fail startInstance when sessionTitle.rename throws and still executes to completion', async () => {
    const { ctx, engine, persistence, sessionTitle } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    sessionTitle.renameError = new Error('title boom');

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-shell-only', originalInput: 'do it', cwd: '/tmp' });

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

  it('seeds global default pass-through vars at start so a forward reference resolves (defect 15)', async () => {
    const { ctx, engine, persistence, shell } = await harness();
    await putDefinition(persistence, 'wfl-forward-ref', forwardRefYaml);
    // shell 回显命令本身，便于断言经 replacePassThroughVars 替换后的实际命令。
    shell.runHandler = async spec => successResult(spec, spec.command);

    const ended = waitForEnd(ctx);
    await engine.startInstance({ workflowId: 'wfl-forward-ref', originalInput: 'do it', cwd: '/tmp' });
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
    const run = await engine.startInstance({ workflowId: 'wfl-shell-only', originalInput: 'do it', cwd: '/ws/project' });
    await ended;

    // 新建分支 attach：hostAgent.id = instanceId 挂到 cwd 命中的 workspace 成员账。
    expect(workspace.attached).toEqual([run.instanceId]);
    expect(persistence.state.get(run.instanceId)?.status).toBe('completed');
  });

  it('throws INVALID_OPERATION when cwd does not resolve to a registered workspace', async () => {
    const { ctx, engine, persistence } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    const registry = new FakeWorkspaceRegistry([new FakeWorkspace('/ws/project')]);
    ctx.provide('workspaceRegistry', registry);

    // cwd 未命中任何已登记 workspace：attach 前抛 INVALID_OPERATION（提示选 web workspace 目录）。
    await expect(
      engine.startInstance({ workflowId: 'wfl-shell-only', originalInput: 'do it', cwd: '/other/dir' }),
    ).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    // 未创建实例：state 表保持为空（attach 在 persistState 之前）。
    expect(persistence.state.size).toBe(0);
  });

  it('silently skips attach when no workspaceRegistry is provided (test/headless degradation)', async () => {
    const { ctx, engine, persistence } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);

    // 默认 harness 不 provide workspaceRegistry：attach 静默跳过（测试/headless 退化），
    // 实例正常启动；cwd 仍按必填透传进状态快照。
    const run = await engine.startInstance({ workflowId: 'wfl-shell-only', originalInput: 'do it', cwd: '/tmp' });
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

    const run = await engine.startInstance({ workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp' });
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

    // 事件双发：宿主 Session 记录同序事件。
    const session = sessions.get(run.instanceId);
    expect(session?.events.map(event => event.type)).toEqual([
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
    const run = await engine.startInstance({ workflowId: 'wfl-multi', originalInput: 'do it', cwd: '/tmp' });
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
    const run = await engine.startInstance({ workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp' });
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
    const run = await engine.startInstance({ workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    // shell 合成会话：childId 为合成占位、synthetic:true。
    expect(state?.executedSteps[0]?.sessionMeta?.childId).toMatch(/^step-step-abc-[0-9a-f]{8}$/);
    expect(state?.executedSteps[0]?.sessionMeta?.synthetic).toBe(true);
    expect(state?.executedSteps[0]?.sessionMeta?.command).toBe('shell');
    // prompt 走真实子代理（决策 D3）：childId 为真实会话 id、synthetic:false、command 保留 'prompt'。
    expect(state?.executedSteps[1]?.sessionMeta?.childId).toBe('child-1');
    expect(state?.executedSteps[1]?.sessionMeta?.synthetic).toBe(false);
    expect(state?.executedSteps[1]?.sessionMeta?.command).toBe('prompt');
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
    const run = await engine.startInstance({ workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp' });
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
    const run = await engine.startInstance({ workflowId: 'wfl-two-shell', originalInput: 'do it', cwd: '/tmp' });
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
    const run = await engine.startInstance({ workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp' });
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

    const run = await engine.startInstance({ workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp' });
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
    const run = await engine.startInstance({ workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    await expect(engine.abortInstance(run.instanceId)).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
  });
});

describe('SandoreEngineRuntime hostAgent freeze', () => {
  it('rejects hostAgent pre-step while the workflow is running and passes child pre-steps through', async () => {
    const { ctx, engine, persistence, shell } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    hangingShell(shell);
    const run = await engine.startInstance({ workflowId: 'wfl-shell-only', originalInput: 'do it', cwd: '/tmp' });

    // 执行中（running）：宿主主代理 pre-step 被 reject——DSH 将 turn 以 blocked 关闭、
    // 不发 user/message、不产生任何模型调用（reject 即 veto，下游 next 不被调用，
    // 消息不会进入 step）。
    const hostNext = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] }));
    const hostDecision = await dispatchPreStep(ctx, run.instanceId, hostNext);
    expect(hostDecision).toEqual({ kind: 'reject' });
    expect(hostNext).not.toHaveBeenCalled();

    // 子代理（childId 不在 instances 表）：放行——next 被调用、决策为下游 enter
    // （冻结只作用于宿主主代理，不冻结 Step 子代理）。
    const childNext = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] }));
    const childDecision = await dispatchPreStep(ctx, 'child-1', childNext);
    expect(childDecision).toEqual({ kind: 'enter', messages: [] });
    expect(childNext).toHaveBeenCalledTimes(1);

    await engine.abortInstance(run.instanceId);
  });

  it('passes hostAgent pre-step through after the workflow completes (thawed)', async () => {
    const { ctx, engine, persistence, shell } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    shell.runHandler = async spec => successResult(spec, 'hi');
    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-shell-only', originalInput: 'do it', cwd: '/tmp' });
    await ended;
    expect(persistence.state.get(run.instanceId)?.status).toBe('completed');

    // **唯一解冻点**：completed 后 hostAgent pre-step 放行（引擎不 dispose hostAgent、
    // ActiveInstance 仍留 instances 表，冻结登记已移除 → 监听器委托 next）。
    const next = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] }));
    const decision = await dispatchPreStep(ctx, run.instanceId, next);
    expect(decision).toEqual({ kind: 'enter', messages: [] });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('still rejects hostAgent pre-step after the workflow fails (stays frozen)', async () => {
    const { ctx, engine, persistence, shell } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    shell.runHandler = async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 0,
      stdout: { text: '', truncated: false },
      stderr: { text: 'boom', truncated: false },
    });
    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-shell-only', originalInput: 'do it', cwd: '/tmp' });
    await ended;
    expect(persistence.state.get(run.instanceId)?.status).toBe('failed');

    // **仅 completed 解冻**：failed 终态保持冻结——pre-step 仍被 reject、下游 next 不被调用
    // （工作流未成功完成，hostAgent 不恢复活跃）。
    const next = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] }));
    const decision = await dispatchPreStep(ctx, run.instanceId, next);
    expect(decision).toEqual({ kind: 'reject' });
    expect(next).not.toHaveBeenCalled();
  });

  it('passes hostAgent pre-step through after abort (instance cleared from memory → auto thaw)', async () => {
    const { ctx, engine, persistence, shell } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    hangingShell(shell);
    const stepStarted = waitForStepStart(ctx);
    const aborted = waitForAborted(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-shell-only', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;
    await engine.abortInstance(run.instanceId);
    await aborted;
    expect(persistence.state.get(run.instanceId)?.status).toBe('aborted');

    // 清表分支：aborted 后实例清出 instances 表，冻结登记同步移除 → pre-step 放行
    // （hostAgent 恢复普通响应；与 failed 留表保持冻结区分）。
    const next = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] }));
    const decision = await dispatchPreStep(ctx, run.instanceId, next);
    expect(decision).toEqual({ kind: 'enter', messages: [] });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('freezes the recovered hostAgent again after recoverInstance resumes the instance', async () => {
    const { ctx, engine, persistence, sessions, shell } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    // 空 executedSteps 的 running 快照：recoverInstance 冷恢复宿主主代理（agents.resume）
    // 后重跑 runInstance；挂起 shell 保持续跑实例 running，便于断言恢复后重新冻结。
    await persistence.state.put('inst-rec', runningSnapshot('inst-rec', 'wfl-shell-only'));
    sessions.create('inst-rec');
    hangingShell(shell);

    const result = await engine.recoverInstance('inst-rec');
    expect(result.status).toBe('running');

    // 恢复重建的 hostAgent 重新冻结（recoverInstance 把实例 id 重新加入冻结登记）：
    // pre-step 被 reject、下游 next 不被调用。
    const next = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] }));
    const decision = await dispatchPreStep(ctx, 'inst-rec', next);
    expect(decision).toEqual({ kind: 'reject' });
    expect(next).not.toHaveBeenCalled();

    await engine.abortInstance('inst-rec');
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

    const run = await engine.startInstance({ workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp', permission: 'read-only' });
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
    const run = await engine.startInstance({ workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp', permission: 'read-only' });
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

    const run = await engine.startInstance({ workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp', permission: 'read-only' });
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

    // 条件分支评估（shouldExecute JSON true）→ agent 执行 → prompt 执行（子代理）→
    // 收尾 assess → 门禁（按序供给 chunk 流；prompt Step 自身输出来自子代理会话）。
    const responses = [
      '{"shouldExecute": true}',
      '{"completionType":"completed","passThroughVars":{"projectName":"sandore"}}',
      '{"taskStatus":"done"}',
    ];
    let callIndex = 0;
    llm.streamHandler = () => textChunks(responses[callIndex++ % responses.length] ?? '');

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
    const run = await engine.startInstance({ workflowId: 'wfl-dag', originalInput: 'do it', cwd: '/tmp' });
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

    // 分支决策点保留 branchMeta 评估现场（shouldExecute JSON 判定输出）。
    const branchEntry = state?.executedSteps.find(step => step.stepId === 'step-branch');
    expect(branchEntry?.branchMeta?.status).toBe('completed');
    expect(branchEntry?.branchMeta?.result).toBe('{"shouldExecute": true}');

    // agent Step：真实 childId（synthetic:false）+ 子代理最终输出。
    const agentStep = state?.executedSteps.find(step => step.stepId === 'step-agent');
    expect(agentStep?.sessionMeta).toEqual({ childId: 'child-1', synthetic: false, command: 'agent' });
    expect(agentStep?.output).toEqual([{ type: 'text', text: 'agent output' }]);

    // hostAgent 注入：agent Step 的子代理 parent 即宿主主代理（id = instanceId）。
    expect(subagents.continuableStarts[0]?.request.parent.id).toBe(run.instanceId);

    // 循环：2 次扁平迭代（路由门 body 跑 maxIter-1 次），loopIteration 嵌套路径；
    // 段 id 为纯 UUID（§3.3），4 位 hex 后缀在 sessionMeta.childId（loopManager 合成占位）。
    const iterations = state?.executedSteps.filter(step => step.stepId === 'step-iter') ?? [];
    expect(iterations.map(step => step.loopIteration)).toEqual([[1], [2]]);
    expect(iterations[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(iterations[0]?.sessionMeta?.childId).toMatch(/^step-iter-[0-9a-f]{4}$/);
    expect(iterations[1]?.visitCount).toBe(2);

    // 透传变量回写：finalize 提取 projectName 并保留 description。
    expect(state?.passThroughVars['projectName']).toEqual({ value: 'sandore', description: '项目名' });

    // 门禁通过：finalizeMeta 记录 gateResult + currentPhase='completed'。
    const finalizeStep = state?.executedSteps.find(step => step.stepId === 'step-finalize');
    expect(finalizeStep?.finalizeMeta?.gateResult?.gatesPassed).toBe(true);
    expect(finalizeStep?.finalizeMeta?.currentPhase).toBe('completed');

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
    llm.streamHandler = () => textChunks('{"shouldExecute": false}');

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-branch-fallback', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    const stepIds = state?.executedSteps.map(step => step.stepId);
    expect(stepIds).toEqual(['step-branch', 'step-fallback', 'step-matched']);

    // branchMeta 保留原始评估结果（shouldExecute=false 证明条件分支未命中）。
    const branchEntry = state?.executedSteps.find(step => step.stepId === 'step-branch');
    expect(branchEntry?.branchMeta?.status).toBe('completed');
    expect(branchEntry?.branchMeta?.result).toBe('{"shouldExecute": false}');
  });

  it('retries an AI condition branch when the first output is unparseable then passes on the retry', async () => {
    const { ctx, engine, persistence, llm, shell } = await harness();
    await putDefinition(persistence, 'wfl-branch-fallback', branchFallbackYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    // 首轮返回乱码（不可解析 shouldExecute）→ evaluateCondition 触发 follow-up 重试 → 第二轮返回合法 JSON。
    const responses = ['I cannot decide', '{"shouldExecute": true}'];
    let callIndex = 0;
    llm.streamHandler = () => textChunks(responses[callIndex++] ?? '');

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-branch-fallback', originalInput: 'do it', cwd: '/tmp' });
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
    expect(branchEntry?.branchMeta?.result).toBe('{"shouldExecute": true}');
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
    const run = await engine.startInstance({ workflowId: 'wfl-branch-fallback', originalInput: 'do it', cwd: '/tmp' });
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
    const run = await engine.startInstance({ workflowId: 'wfl-nested-loop', originalInput: 'do it', cwd: '/tmp' });
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
    const run = await engine.startInstance({ workflowId: 'wfl-loop-break', originalInput: 'do it', cwd: '/tmp' });
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
    const run = await engine.startInstance({ workflowId: 'wfl-loop-command-gate', originalInput: 'do it', cwd: '/tmp' });
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
      const run = await engine.startInstance({ workflowId: wfId, originalInput: 'do it', cwd: '/tmp' });
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
    const run = await engine.startInstance({ workflowId: 'wfl-loop-break-no-break', originalInput: 'do it', cwd: '/tmp' });
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
    const run = await engine.startInstance({ workflowId: 'wfl-loop-break', originalInput: 'do it', cwd: '/tmp' });
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
    // 条件分支恒不命中（shouldExecute=false）→ 循环跑到 maxIterations 硬上限。
    llm.streamHandler = () => textChunks('{"shouldExecute": false}');

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-loop-mixed-gate', originalInput: 'do it', cwd: '/tmp' });
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

    // step-extract（prompt）执行 → finalize assess 提取 projectName=sandore；
    // Stage 2 step-use 声明同名默认值 "unknown"（非 \${} 引用 → 不触发 assess）。
    const responses = [
      '{"completionType":"completed","passThroughVars":{"projectName":"sandore"}}',
    ];
    let callIndex = 0;
    llm.streamHandler = () => textChunks(responses[callIndex++ % responses.length] ?? '');

    const ended = waitForEnd(ctx);
    await engine.startInstance({ workflowId: 'wfl-cross-stage-ptv', originalInput: 'do it', cwd: '/tmp' });
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
    // Stage 条件评估（StageContract-based，非 fork）：shouldExecute=true → 取 stg-b。
    llm.streamHandler = () => textChunks('{"shouldExecute": true}');

    const records = recordSandoreEvents(ctx);
    const ended = waitForEnd(ctx);
    await engine.startInstance({ workflowId: 'wfl-stage-branch', originalInput: 'do it', cwd: '/tmp' });
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
    // Stage 条件评估：shouldExecute=false → 跳过 stg-b，走无 condition 的默认分支 stg-default。
    llm.streamHandler = () => textChunks('{"shouldExecute": false}');

    const records = recordSandoreEvents(ctx);
    const ended = waitForEnd(ctx);
    await engine.startInstance({ workflowId: 'wfl-stage-branch', originalInput: 'do it', cwd: '/tmp' });
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
    // 条件 A shouldExecute=true → 取 stg-a（首个条件命中，循环 break，condB 不评估）。
    llm.streamHandler = () => textChunks('{"shouldExecute": true}');

    const records = recordSandoreEvents(ctx);
    const ended = waitForEnd(ctx);
    await engine.startInstance({ workflowId: 'wfl-stage-multi', originalInput: 'do it', cwd: '/tmp' });
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
    // 条件 A false → 跳过；条件 B true → 取 stg-b（第二条件命中）。
    let call = 0;
    llm.streamHandler = () => textChunks(call++ === 0 ? '{"shouldExecute": false}' : '{"shouldExecute": true}');

    const records = recordSandoreEvents(ctx);
    const ended = waitForEnd(ctx);
    await engine.startInstance({ workflowId: 'wfl-stage-multi', originalInput: 'do it', cwd: '/tmp' });
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
    const { ctx, engine, persistence, llm, agents, userQuestions } = await harness();
    await putDefinition(persistence, 'wfl-ask', askYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
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
    const run = await engine.startInstance({ workflowId: 'wfl-ask', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    // ask 以 hostAgent（id = instanceId）身份发起。
    expect(userQuestions.calls).toHaveLength(1);
    expect(userQuestions.calls[0]?.agent?.id).toBe(run.instanceId);

    // sandore/question 事件：pending 条目（kind/status/payload）。
    expect(firedQuestions).toHaveLength(1);
    const fired = firedQuestions[0] as { question: { kind: string; status: string; payload: { questions: Array<{ id: string }> } } };
    expect(fired.question.kind).toBe('question');
    expect(fired.question.status).toBe('pending');
    expect(fired.question.payload.questions[0]?.id).toBe('q1');

    // 回复后恢复：Step completed + 实例 completed + 条目不再持久化（pending 已清，
    // 回答写入 userMessages kind:'answer'——交互管理器只持久化 pending，§3.6A）。
    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    expect(state?.executedSteps.find(step => step.stepId === 'step-ask')?.status).toBe('completed');
    expect(state?.pendingInteractions).toEqual([]);
    const answers = state?.userMessages?.filter(message => message.kind === 'answer');
    expect(answers).toHaveLength(1);
    expect(answers?.[0]?.target).toBe('step-ask');
    expect(answers?.[0]?.content).toBe('A');
  });

  it('supports the replyQuestion compat path when the card channel is unavailable', async () => {
    const { ctx, engine, persistence, llm, agents } = await harness();
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
    const run = await engine.startInstance({ workflowId: 'wfl-ask', originalInput: 'do it', cwd: '/tmp' });
    const fired = await question;
    const requestId = (fired.question as { requestId: string }).requestId;

    // 兼容路径回复：resolve ask 的 await 并恢复执行。
    await engine.replyQuestion(run.instanceId, requestId, { answers: [{ id: 'q1', selected: ['B'] }] });
    await waitForEnd(ctx);

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    // 回答后 pending 已清（只持久化 pending），回答进 userMessages kind:'answer'。
    expect(state?.pendingInteractions).toEqual([]);
    const answers = state?.userMessages?.filter(message => message.kind === 'answer');
    expect(answers).toHaveLength(1);
    expect(answers?.[0]?.content).toBe('B');
  });

  it('resumes the remaining steps and re-runs the gate after a mid-stage ask', async () => {
    const { ctx, engine, persistence, llm, shell, agents, userQuestions } = await harness();
    await putDefinition(persistence, 'wfl-ask-mid', askMidYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    shell.runHandler = async spec => successResult(spec, 'done');
    // prompt Step（step-ask）走可续接子代理：注册真实 childId 并回填最终输出。
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'work done' }]));
    agents.register(child);

    // assess ①（ask JSON）→ 回答注回 → 重新评估 ②（completed JSON）→ 门禁（taskStatus done）。
    const responses = [
      '{"completionType":"ask","passThroughVars":{"projectName":"sandore"},"askQuestion":{"questions":[{"id":"q1","question":"Which?","options":[{"label":"A"},{"label":"B"}]}]}}',
      '{"completionType":"completed","passThroughVars":{}}',
      '{"taskStatus":"done"}',
    ];
    let callIndex = 0;
    llm.streamHandler = () => textChunks(responses[callIndex++ % responses.length] ?? '');

    userQuestions.resolveNext = async () => ({ answers: [{ id: 'q1', selected: ['A'] }] });

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-ask-mid', originalInput: 'do it', cwd: '/tmp' });
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
    const run = await engine.startInstance({ workflowId: 'wfl-ask', originalInput: 'do it', cwd: '/tmp' });
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
    const { ctx, engine, persistence, llm, agents } = await harness();
    await putDefinition(persistence, 'wfl-ask', askYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
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
    const run = await engine.startInstance({ workflowId: 'wfl-ask', originalInput: 'do it', cwd: '/tmp' });
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
    const { ctx, engine, persistence, llm, agents, userQuestions } = await harness();
    await putDefinition(persistence, 'wfl-ask', askYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'work done' }]));
    agents.register(child);
    // 恒返回 hasAsk=true + askQuestion（评估永不判定完成）→ 引擎 ask 闭环反复触发。
    llm.streamHandler = () => textChunks(
      '{"hasAsk":true,"passThroughVars":{},"askQuestion":{"questions":[{"id":"q1","question":"Which?","options":[{"label":"A"},{"label":"B"}]}]}}',
    );
    userQuestions.resolveNext = async () => ({ answers: [{ id: 'q1', selected: ['A'] }] });

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-ask', originalInput: 'do it', cwd: '/tmp' });
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
    const run = await engine.startInstance({ workflowId: 'wfl-delegated', originalInput: 'do it', cwd: '/tmp' });
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
    const run = await engine.startInstance({ workflowId: 'wfl-delegated', originalInput: 'do it', cwd: '/tmp' });
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
    const { ctx, engine, persistence, llm, agents, userQuestions } = await harness();
    await putDefinition(persistence, 'wfl-ask', askYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'work done' }]));
    agents.register(child);
    llm.streamHandler = () => textChunks('{"hasAsk":false,"passThroughVars":{}}');

    // 等待实例跑完（Step 段已写入 executedSteps，sessionMeta.childId = child-1）。
    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-ask', originalInput: 'do it', cwd: '/tmp' });
    await ended;
    // 真实 DSH：子代理 session.header.parentSession = 宿主主代理会话 id（childSessionMeta）；
    // mock 手动补写（hostAgent.id = instanceId）。
    child.session.header = { parentSession: run.instanceId };

    const firedQuestions: unknown[] = [];
    ctx.on('sandore/question', (info, question) => firedQuestions.push({ info, question }));
    userQuestions.resolveNext = async request => {
      expect(request.questions).toEqual([{ id: 'q1', question: 'Which?' }]);
      return { answers: [{ id: 'q1', selected: ['A'] }] };
    };
    const answer = await engine.askFromSubagent(child, [{ id: 'q1', question: 'Which?' }]);

    expect(answer).toEqual({ answers: [{ id: 'q1', selected: ['A'] }] });
    // 以宿主主代理（id = instanceId）身份发起（非子代理自身——避免 DELEGATED_CALLER）。
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
    const run = await engine.startInstance({ workflowId: 'wfl-ask', originalInput: 'do it', cwd: '/tmp' });
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
    const run = await engine.startInstance({ workflowId: 'wfl-ask', originalInput: 'do it', cwd: '/tmp' });
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

describe('SandoreEngineRuntime registerContinuableSetup gate（4.3：仅当前非终态 sandore 实例的子代理）', () => {
  it('registers a contribution and installs the child-scope ask tool only for non-terminal sandore instances', async () => {
    const { ctx, engine, subagents, persistence, llm, agents } = await harness();
    await putDefinition(persistence, 'wfl-prompt-only', promptOnlyYaml);
    provideLlmDirectory(llm);
    // prompt Step 挂起：child status='running' 不自动 settle → 实例保持 running（非终态）。
    const child = new FakeAgent('child-1');
    child.status = 'running';
    agents.register(child);

    const stepStarted = waitForStepStart(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-prompt-only', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;

    // 引擎启动时注册了 1 个贡献（Service.init → registerSandoreAskToolSetup）。
    expect(subagents.continuableSetups).toHaveLength(1);
    const contribution = subagents.continuableSetups[0]!;

    // gate 未命中（parent 非任何 sandore 实例的宿主主代理）：不注册工具。
    const toolsA = { register: vi.fn(() => () => {}) };
    const disposeA = contribution({
      tools: toolsA,
      agent: { session: { header: { parentSession: 'some-other-session' } } },
    } as unknown as Context);
    expect(toolsA.register).not.toHaveBeenCalled();
    disposeA();

    // gate 命中（parent = 当前非终态 sandore 实例的宿主主代理会话 = instanceId）：
    // 注册 child-scope ask_user_question。
    const toolsB = { register: vi.fn(() => () => {}) };
    const disposeB = contribution({
      tools: toolsB,
      agent: { session: { header: { parentSession: run.instanceId } } },
    } as unknown as Context);
    expect(toolsB.register).toHaveBeenCalledTimes(1);
    expect(toolsB.register).toHaveBeenCalledWith(expect.objectContaining({ name: 'ask_user_question' }));
    disposeB();

    // 实例终态（completed）后：同一宿主主代理的后续子代理不再注入（避免误注入）。
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    subagents.settleChild('child-1', 'completed');
    await waitForEnd(ctx);
    const toolsC = { register: vi.fn(() => () => {}) };
    const disposeC = contribution({
      tools: toolsC,
      agent: { session: { header: { parentSession: run.instanceId } } },
    } as unknown as Context);
    expect(toolsC.register).not.toHaveBeenCalled();
    disposeC();
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
    const run = await engine.startInstance({ workflowId: 'wfl-agent-fail', originalInput: 'do it', cwd: '/tmp' });
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

    // sandore/step-retried 双发：Cordis emit + Session append 同发。
    expect(retried).toEqual([{ stepId: 'step-agent', mode: 'continue', name: 'step-agent' }]);
    expect(sessions.get(run.instanceId)?.events.some(event => event.type === 'sandore/step-retried')).toBe(true);
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
    const run = await engine.startInstance({ workflowId: 'wfl-multi-retry', originalInput: 'do it', cwd: '/tmp' });
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
    const run = await engine.startInstance({ workflowId: 'wfl-multi-retry', originalInput: 'do it', cwd: '/tmp' });
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
    const run = await engine.startInstance({ workflowId: 'wfl-agent-fail', originalInput: 'do it', cwd: '/tmp' });
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
    expect(step?.sessionMeta?.childId).toMatch(/^step-step-agent-[0-9a-f]{8}$/);
    expect(step?.sessionMeta?.childId).not.toBe('child-1');
    expect(step?.parentSessionId).toBe('child-1');
    expect(step?.retryHistory?.[0]?.mode).toBe('fork');
    expect(step?.retryHistory?.[0]?.result).toBe('completed');
    expect(subagents.followups.some(item => item.childId === step?.sessionMeta?.childId)).toBe(true);
  });

  it('retries a failed agent step with revert mode to a new childId and completes', async () => {
    const { ctx, engine, persistence, llm, agents, subagents, sessions } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);

    const child = new FakeAgent('child-1');
    agents.register(child);

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-agent-fail', originalInput: 'do it', cwd: '/tmp' });
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
    expect(step?.sessionMeta?.childId).toMatch(/^step-step-agent-[0-9a-f]{8}$/);
    expect(step?.parentSessionId).toBe('child-1');
    expect(step?.retryHistory?.[0]?.mode).toBe('revert');
    expect(step?.retryHistory?.[0]?.result).toBe('completed');
    expect(subagents.followups.some(item => item.childId === step?.sessionMeta?.childId)).toBe(true);
  });

  it('retries a failed agent step with revert mode to a user-selected earlier turn boundary', async () => {
    const { ctx, engine, persistence, llm, agents, subagents, sessions } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);

    const child = new FakeAgent('child-1');
    agents.register(child);

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-agent-fail', originalInput: 'do it', cwd: '/tmp' });
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
    const run = await engine.startInstance({ workflowId: 'wfl-agent-fail', originalInput: 'do it', cwd: '/tmp' });
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
    expect(step?.sessionMeta?.childId).toMatch(/^step-step-agent-[0-9a-f]{8}$/);
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

describe('SandoreEngineRuntime sendStepMessage (缺陷 31: @mention 讨论消息封装端点)', () => {
  it('forwards the message to subagents.followup + persists userMessages kind:message + dual-emits sandore/step-message', async () => {
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
    const run = await engine.startInstance({ workflowId: 'wfl-agent-fail', originalInput: 'do it', cwd: '/tmp' });
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

    // userMessages 落盘 kind:'message'（非 'input'，避免污染 originalInput 语义）。
    const state = persistence.state.get(run.instanceId);
    const messages = state?.userMessages?.filter(m => m.kind === 'message') ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.target).toBe('step-agent');
    expect(messages[0]?.content).toBe('请确认参数');

    // 双发 sandore/step-message：Cordis emit（listener 触发）+ Session append。
    expect(messageEvents).toHaveLength(1);
    expect(messageEvents[0]?.stepId).toBe('step-agent');
    expect(messageEvents[0]?.childId).toBe('child-1');
    expect(messageEvents[0]?.message).toBe('请确认参数');
    expect(messageEvents[0]?.name).toBe('step-agent');
    expect(sessions.get(run.instanceId)?.events.some(e => e.type === 'sandore/step-message')).toBe(true);

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
    const run = await engine.startInstance({ workflowId: 'wfl-prompt-only', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;
    // 等待 onChildStarted 把 sessionMeta 切为 synthetic=false + childId='child-1'。
    await vi.waitFor(() => {
      const step = persistence.state.get(run.instanceId)?.executedSteps.find(s => s.stepId === 'step-prompt');
      expect(step?.sessionMeta?.synthetic).toBe(false);
      expect(step?.sessionMeta?.childId).toBe('child-1');
    });

    await engine.sendStepMessage(run.instanceId, 'step-prompt', 'hi');

    // prompt 为真实子代理：followup 收到消息（childId 指向运行中子代理）+ userMessages
    // kind:message 落盘 + 双发 sandore/step-message。
    expect(subagents.followups).toHaveLength(1);
    expect(subagents.followups[0]?.childId).toBe('child-1');
    expect(subagents.followups[0]?.content).toEqual([{ type: 'text', text: 'hi' }]);
    const state = persistence.state.get(run.instanceId);
    const messages = state?.userMessages?.filter(m => m.kind === 'message') ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.target).toBe('step-prompt');
    expect(messages[0]?.content).toBe('hi');
    expect(messageEvents).toHaveLength(1);
    expect(sessions.get(run.instanceId)?.events.some(e => e.type === 'sandore/step-message')).toBe(true);

    // 清理：append 输出 + settle completed，令 run 收敛。
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    subagents.settleChild('child-1', 'completed');
    await waitForEnd(ctx);
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
    const run = await engine.startInstance({ workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/tmp' });
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
    const run = await engine.startInstance({ workflowId: 'wfl-agent-fail', originalInput: 'do it', cwd: '/tmp' });
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
   * mock llm.streamHandler 按首条消息文本分发：含 'shouldExecute' → 条件分支 JSON；
   * 含 'shouldBreak' → 循环跳出 JSON（首次 false 继续、二次 true 跳出）；含
   * 'hasAsk' → 收尾 assess JSON（提取 projectName=sandore）；含 'taskStatus'
   * → primary 门禁 JSON；其余 → secondary 门禁 JSON。prompt Step（step-finalize）自身
   * 输出来自可续接子代理会话（决策 D3）。mock shell.runHandler 回显命令对应 stdout。
   */
  it('runs the review-fix flow across two stages with branches, parallel, loop, and gates to completed', async () => {
    const { ctx, engine, persistence, llm, shell, agents } = await harness();
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

    // 条件分支/循环跳出/收尾门禁各走专用模板（其「## 返回格式」节含对应字段名），
    // mock 据首条消息文本含哪个字段名分发对应 JSON。循环跳出首次 false、二次 true
    // （演示 continue 与 break 两条 loopMeta 路由条目均回写）。prompt Step 自身输出
    // 来自子代理会话（不再消费 llm.stream）。
    let breakCall = 0;
    llm.streamHandler = (options) => {
      const text = (options.messages[0]?.content[0] as TextBlock | undefined)?.text ?? '';
      if (text.includes('shouldExecute')) {
        return textChunks('{"shouldExecute": true}');
      }
      if (text.includes('shouldBreak')) {
        breakCall += 1;
        return textChunks(breakCall === 1 ? '{"shouldBreak": false}' : '{"shouldBreak": true}');
      }
      if (text.includes('hasAsk')) {
        return textChunks('{"hasAsk":false,"passThroughVars":{"projectName":"sandore"}}');
      }
      if (text.includes('taskStatus')) {
        return textChunks('{"taskStatus":"done"}');
      }
      // secondary 门禁（无其他字段命中时）。
      return textChunks('{"gateStatus":"done"}');
    };

    const records = recordSandoreEvents(ctx);
    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-complex', originalInput: 'do it', cwd: '/tmp' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');

    const stepIds = state?.executedSteps.map(step => step.stepId) ?? [];

    // ── 顺序：Stage 1 首步 step-scan → 路由门 step-route（条件评估现场保留）。
    expect(stepIds[0]).toBe('step-scan');
    expect(stepIds[1]).toBe('step-route');
    const routeEntry = state?.executedSteps.find(step => step.stepId === 'step-route');
    expect(routeEntry?.branchMeta?.status).toBe('completed');
    expect(routeEntry?.branchMeta?.result).toBe('{"shouldExecute": true}');

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
    //    gateResult（primaryPassed + secondaryPassed 均为 true → gatesPassed=true）。
    const finalizeStep = state?.executedSteps.find(step => step.stepId === 'step-finalize');
    expect(finalizeStep?.status).toBe('completed');
    expect(finalizeStep?.finalizeMeta?.currentPhase).toBe('completed');
    expect(finalizeStep?.finalizeMeta?.gateResult?.gatesPassed).toBe(true);
    expect(finalizeStep?.finalizeMeta?.gateResult?.primaryPassed).toBe(true);
    expect(finalizeStep?.finalizeMeta?.gateResult?.secondaryPassed).toBe(true);

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

    // ── llm 调用覆盖：条件分支 1 + 循环跳出 2 + assess 1 + primary 1 + secondary 1
    //    = 6 次（按字段名分发；prompt Step 输出来自子代理会话，不消费 llm.stream）。
    expect(llm.calls).toHaveLength(6);

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
