/**
 * yaml-parser.ts 的 V1/V2 解析、序列化与类型化错误单元测试。
 * @module @deepseek-ai/dsh-sandore-workflow/src/yaml-parser.spec
 */
import { describe, expect, it } from 'vitest'

import { WorkflowYamlError } from './yaml-error.ts'
import { parseWorkflowYaml, serializeWorkflowYaml } from './yaml-parser.ts'

const v2Yaml = `id: wfl-a1b2c3d4-e5f6-7890-abcd-ef1234567890
name: 全字段代码审查工作流
version: "2.0.0"
description: 覆盖所有 V2 字段的示例工作流
engine: v2
skills:
  - code-review-skill
mcps:
  - filesystem-mcp
agents:
  - code-reviewer
settings:
  defaultTimeout: 60
  maxConcurrentAgents: 4
rules:
  chinese-output: "所有输出必须使用中文"
stages:
  - id: stg-1
    name: 代码分析
    steps:
      - id: step-1
        next: step-2
      - id: step-2
  - id: stg-2
    name: 通知
    steps:
      - id: step-3
steps:
  - id: step-1
    name: 静态分析
    command:
      type: shell
      value:
        command: "npm run lint 2>&1"
    outputTo:
      - id: opt-1
        path: "reports/lint.txt"
  - id: step-2
    name: 深度审查
    command:
      type: agent
      value:
        promptText: code-reviewer
        agentParamsTemplate: "审查重点"
  - id: step-3
    name: 生成报告
    command:
      type: prompt
      value:
        promptText: "生成报告"
`

/**
 * 附录 A.1 完整 V2 示例（docs/engine/dynamic-workflow-engine.md L5099-5295），
 * 覆盖 5 种 command 变体与 gates/rules/branches/loop/inputFrom/outputTo/
 * passThroughVars/timeout，用于锁定解析器的兼容性决策。
 */
const appendixA1V2Yaml = `# ── WorkflowDefinition 顶层字段 ──
id: wfl-a1b2c3d4-e5f6-7890-abcd-ef1234567890
name: 全字段代码审查工作流
version: "2.0.0"
description: 覆盖所有 V2 字段的示例工作流
engine: v2                              # 引擎标识
skills:                                  # 工作流级技能列表
  - code-review-skill
  - security-scan-skill
mcps:                                    # 工作流级 MCP 工具列表
  - filesystem-mcp
  - git-mcp
agents:                                  # 工作流级 Agent 列表
  - code-reviewer
  - code-fixer
settings:
  defaultTimeout: 60                    # 默认超时（分钟）
  maxConcurrentAgents: 4                # 最大并发 Agent 数
rules:                                   # 工作流级规则定义（键值对）
  chinese-output: "所有输出必须使用中文"
  no-direct-commit: "禁止直接执行 git commit"
gates:                                   # 工作流级门控配置
  maxRetries: 3
  maxTokens: 100000
  primary:
    enabled: true                        # 产物检查门禁
  secondary:
    enabled: true                        # 门禁审查门禁
    prompt: "检查代码是否遵循项目编码规范"
  need_confirm: false

# ── stages[]: Stage 级流控 + Stage 级 rules/gates ──
stages:
  - id: stg-11111111-1111-1111-1111-111111111111
    name: 代码分析
    rules:                               # Stage 级规则引用（覆盖 workflow.rules）
      - chinese-output
    gates:                               # Stage 级门控覆盖（field-level deep merge）
      primary:
        enabled: false
      secondary:
        enabled: false
    defaultExpectation: "需要修复"        # Stage 级默认分支期望
    branches:                            # Stage 级分支（next/condition/loop 三并列字段）
      - condition:                       # 条件分支
          type: prompt
          value:
            promptText: "判断代码质量是否需要修复"
            providerId: provider-xxx
            modelId: model-yyy
        next: step-33333333-3333-3333-3333-333333333333
        label: "修复分支"
      - next: step-55555555-5555-5555-5555-555555555555  # 无 condition = 并行分支
        label: "并行兜底"
    steps:                               # Stage 内 Step（仅 ID + 流控字段）
      - id: step-11111111-1111-1111-1111-111111111111
        branches:
          - next: step-22222222-2222-2222-2222-222222222222
      - id: step-22222222-2222-2222-2222-222222222222
        defaultExpectation: "需要修复"
        branches:
          - condition:
              type: prompt
              value:
                promptText: "判断代码质量是否需要修复"
            next: step-33333333-3333-3333-3333-333333333333
            label: "修复分支"
          - next: step-55555555-5555-5555-5555-555555555555  # 并行分支
          - next: step-11111111-1111-1111-1111-111111111111  # 循环回边分支
            loop:
              breakCondition:
                type: prompt
                value:
                  promptText: "所有严重问题是否已修复"
              breakExpectation: "已修复"
              maxIterations: 3
              exitTo: step-55555555-5555-5555-5555-555555555555
      - id: step-33333333-3333-3333-3333-333333333333
        branches:
          - next: step-44444444-4444-4444-4444-444444444444
      - id: step-44444444-4444-4444-4444-444444444444
        branches:
          - next: step-22222222-2222-2222-2222-222222222222   # 自循环（loop pattern）
            loop:
              maxIterations: 3
              next: step-22222222-2222-2222-2222-222222222222
              exitTo: step-55555555-5555-5555-5555-555555555555
      - id: step-55555555-5555-5555-5555-555555555555

  - id: stg-22222222-2222-2222-2222-222222222222
    name: 通知
    steps:
      - id: step-66666666-6666-6666-6666-666666666666

# ── steps[]: 顶层 Step 定义（与 stages[].steps[] 通过 ID 交叉引用）──
steps:
  # shell 类型 — 覆盖 command + inputFrom(path+regex) + outputTo(path+regex) + passThroughVars + timeout + rules + gates
  - id: step-11111111-1111-1111-1111-111111111111
    name: 静态分析
    command:
      type: shell
      value:
        command: "npm run lint 2>&1"
    inputFrom:
      - id: ipt-11111111-1111-1111-1111-111111111111
        path: stg-11111111-1111-1111-1111-111111111111.step-11111111-1111-1111-1111-111111111111.opt-11111111-1111-1111-1111-111111111111
      - id: ipt-22222222-2222-2222-2222-222222222222
        regex: ".*\\\\.test\\\\.ts$"        # regex 模式匹配
    outputTo:
      - id: opt-11111111-1111-1111-1111-111111111111
        path: "reports/lint.txt"
      - id: opt-22222222-2222-2222-2222-222222222222
        regex: "reports/.*\\\\.json$"     # regex 模式匹配
    passThroughVars:
      - name: lintErrorCount
        value: ""                        # 初始为空，由 finalize 填充
        description: "lint 错误数量"
        refresh: true                   # V2.4.2: 每次执行前自动清空，强制重新提取
    timeout: 30                         # Step 级超时覆盖
    rules: [chinese-output]             # Step 级规则引用
    gates:                              # Step 级门控覆盖
      primary:
        enabled: true
      secondary:
        enabled: false

  # agent 类型 — 覆盖 promptText + agentParamsTemplate + providerId + modelId
  - id: step-22222222-2222-2222-2222-222222222222
    name: 深度审查
    command:
      type: agent
      value:
        promptText: code-reviewer       # Agent 名称（必须在 agents 数组中）
        agentParamsTemplate: "审查重点：\${lintErrorCount} 个 lint 错误"
        providerId: provider-xxx
        modelId: model-yyy
    inputFrom:
      - id: ipt-33333333-3333-3333-3333-333333333333
        path: stg-11111111-1111-1111-1111-111111111111.step-11111111-1111-1111-1111-111111111111
    outputTo:
      - id: opt-33333333-3333-3333-3333-333333333333
        path: "reports/review.md"
    passThroughVars:
      - name: vulnerabilityCount
        value: ""
        description: "发现的安全漏洞数量"
        refresh: false                  # V2.4.2: false（默认）= 不自动清空，保留上次提取值
    timeout: 60

  # skill 类型 — promptText 存储 Skill 名称
  - id: step-33333333-3333-3333-3333-333333333333
    name: 自动修复
    command:
      type: skill
      value:
        promptText: code-review-skill   # Skill 名称（必须在 skills 数组中）
        providerId: provider-xxx

  # mcp 类型 — promptText 存储 MCP 名称
  - id: step-44444444-4444-4444-4444-444444444444
    name: MCP 工具检查
    command:
      type: mcp
      value:
        promptText: filesystem-mcp      # MCP 名称（必须在 mcps 数组中）

  # prompt 类型 — 纯提示词
  - id: step-55555555-5555-5555-5555-555555555555
    name: 生成报告
    command:
      type: prompt
      value:
        promptText: "根据以上审查结果，生成最终的代码审查报告"
        providerId: provider-xxx
        modelId: model-yyy

  # shell 类型 — 简单命令
  - id: step-66666666-6666-6666-6666-666666666666
    name: 发送通知
    command:
      type: shell
      value:
        command: "echo 'Review completed' | mail -s 'Code Review' team@example.com"
`

/** 断言解析抛 `DEFINITION_INVALID` 且 message 含指定片段。 */
function expectDefinitionInvalid(text: string, fragment: string): void {
  try {
    parseWorkflowYaml(text)
    expect.unreachable('expected a throw')
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowYamlError)
    const yamlError = error as WorkflowYamlError
    expect(yamlError.code).toBe('DEFINITION_INVALID')
    expect(yamlError.message).toContain(fragment)
  }
}

describe('parseWorkflowYaml', () => {
  it('parses a V2 definition with stages and command variants', () => {
    const definition = parseWorkflowYaml(v2Yaml)
    expect(definition.id).toBe('wfl-a1b2c3d4-e5f6-7890-abcd-ef1234567890')
    expect(definition.stages).toHaveLength(2)
    expect(definition.steps).toHaveLength(3)
    expect(definition.settings.defaultTimeout).toBe(60)
    expect(definition.skills).toEqual(['code-review-skill'])
    const shell = definition.steps?.find(step => step.id === 'step-1')
    expect(shell?.command).toEqual({ type: 'shell', value: { command: 'npm run lint 2>&1' } })
  })

  it('parses the full appendix A.1 example and discriminates agent/skill/mcp variants', () => {
    const definition = parseWorkflowYaml(appendixA1V2Yaml)
    expect(definition.id).toBe('wfl-a1b2c3d4-e5f6-7890-abcd-ef1234567890')
    expect(definition.stages).toHaveLength(2)
    expect(definition.steps).toHaveLength(6)
    expect(definition.gates?.maxRetries).toBe(3)
    expect(definition.stages[0]?.branches).toHaveLength(2)
    expect(definition.stages[0]?.branches?.[1]?.loop?.maxIterations).toBeUndefined()
    expect(definition.stages[0]?.branches?.[0]?.condition?.type).toBe('prompt')

    const agent = definition.steps?.find(step => step.id === 'step-22222222-2222-2222-2222-222222222222')
    expect(agent?.command).toEqual({
      type: 'agent',
      value: {
        promptText: 'code-reviewer',
        agentParamsTemplate: '审查重点：${lintErrorCount} 个 lint 错误',
        providerId: 'provider-xxx',
        modelId: 'model-yyy',
      },
    })

    const skill = definition.steps?.find(step => step.id === 'step-33333333-3333-3333-3333-333333333333')
    expect(skill?.command).toEqual({
      type: 'skill',
      value: { promptText: 'code-review-skill', providerId: 'provider-xxx' },
    })

    const mcp = definition.steps?.find(step => step.id === 'step-44444444-4444-4444-4444-444444444444')
    expect(mcp?.command).toEqual({ type: 'mcp', value: { promptText: 'filesystem-mcp' } })
  })

  it('throws WorkflowYamlError YAML_PARSE with line info on syntax error', () => {
    try {
      parseWorkflowYaml('stages: [ Unclosed')
      expect.unreachable('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowYamlError)
      const yamlError = error as WorkflowYamlError
      expect(yamlError.code).toBe('YAML_PARSE')
      expect(yamlError.message).toMatch(/line \d+/)
    }
  })

  it('throws DEFINITION_INVALID when a branch.next target does not exist', () => {
    const badYaml = `id: wfl-x
name: demo
version: "1.0.0"
stages:
  - id: stg-1
    name: 分析
    steps:
      - id: step-1
        branches:
          - next: step-missing
steps:
  - id: step-1
    name: lint
    command:
      type: shell
      value:
        command: "echo hi"
`
    try {
      parseWorkflowYaml(badYaml)
      expect.unreachable('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowYamlError)
      const yamlError = error as WorkflowYamlError
      expect(yamlError.code).toBe('DEFINITION_INVALID')
      expect(yamlError.message).toContain('step-missing')
    }
  })

  it('throws DEFINITION_INVALID when a branch.next references a missing node', () => {
    expectDefinitionInvalid(`id: wfl-x
name: demo
version: "1.0.0"
stages:
  - id: stg-1
    name: 分析
    branches:
      - next: step-missing
    steps:
      - id: step-1
steps:
  - id: step-1
    name: lint
    command:
      type: shell
      value:
        command: "echo hi"
`, 'step-missing')
  })

  it('throws DEFINITION_INVALID when loop.next references a missing node', () => {
    expectDefinitionInvalid(`id: wfl-x
name: demo
version: "1.0.0"
stages:
  - id: stg-1
    name: 分析
    branches:
      - next: step-1
        loop:
          maxIterations: 3
          next: step-missing
    steps:
      - id: step-1
steps:
  - id: step-1
    name: lint
    command:
      type: shell
      value:
        command: "echo hi"
`, 'step-missing')
  })

  it('throws DEFINITION_INVALID when loop.exitTo references a missing node', () => {
    expectDefinitionInvalid(`id: wfl-x
name: demo
version: "1.0.0"
stages:
  - id: stg-1
    name: 分析
    branches:
      - next: step-1
        loop:
          maxIterations: 3
          exitTo: step-missing
    steps:
      - id: step-1
steps:
  - id: step-1
    name: lint
    command:
      type: shell
      value:
        command: "echo hi"
`, 'step-missing')
  })

  it('throws DEFINITION_INVALID when inputFrom[].path references a missing stage', () => {
    expectDefinitionInvalid(`id: wfl-x
name: demo
version: "1.0.0"
stages:
  - id: stg-1
    name: 分析
    steps:
      - id: step-1
steps:
  - id: step-1
    name: lint
    command:
      type: shell
      value:
        command: "echo hi"
    inputFrom:
      - id: ipt-1
        path: stg-missing.step-1
`, "missing stage 'stg-missing'")
  })

  it('throws DEFINITION_INVALID when inputFrom[].path references a missing step', () => {
    expectDefinitionInvalid(`id: wfl-x
name: demo
version: "1.0.0"
stages:
  - id: stg-1
    name: 分析
    steps:
      - id: step-1
steps:
  - id: step-1
    name: lint
    command:
      type: shell
      value:
        command: "echo hi"
    inputFrom:
      - id: ipt-1
        path: stg-1.step-missing
`, "missing step 'step-missing'")
  })

  it('throws DEFINITION_INVALID on duplicate stage ids', () => {
    expectDefinitionInvalid(`id: wfl-x
name: demo
version: "1.0.0"
stages:
  - id: stg-1
    name: 分析
    steps:
      - id: step-1
  - id: stg-1
    name: 通知
    steps:
      - id: step-2
`, "duplicate stage id 'stg-1'")
  })

  it('throws DEFINITION_INVALID on duplicate step ids within stage positions', () => {
    expectDefinitionInvalid(`id: wfl-x
name: demo
version: "1.0.0"
stages:
  - id: stg-1
    name: 分析
    steps:
      - id: step-1
      - id: step-1
`, "duplicate step id 'step-1'")
  })

  it('throws DEFINITION_INVALID on duplicate step ids in the top-level steps table', () => {
    expectDefinitionInvalid(`id: wfl-x
name: demo
version: "1.0.0"
stages:
  - id: stg-1
    name: 分析
    steps:
      - id: step-1
steps:
  - id: step-1
    name: lint
    command:
      type: shell
      value:
        command: "echo hi"
  - id: step-1
    name: dup
    command:
      type: shell
      value:
        command: "echo dup"
`, "duplicate step id 'step-1'")
  })

  it('converts a V1 three-level definition to V2 two-level', () => {
    const v1Yaml = `id: code-review-workflow
name: 代码审查工作流
version: "1.0.0"
settings:
  defaultTimeout: 60
stages:
  - id: stg-analyze
    name: 代码分析
    scenarios:
      - id: sce-static-analysis
        name: 静态分析
        tasks:
          - id: tsk-lint
            name: 代码规范检查
            prompt:
              type: Bash
              value:
                command: "npm run lint 2>&1"
            outputTo:
              - id: opt-lint-report
                path: "reports/lint.txt"
`
    const definition = parseWorkflowYaml(v1Yaml)
    expect(definition.stages[0]).not.toHaveProperty('scenarios')
    expect(definition.stages[0]?.steps).toHaveLength(1)
    const step = definition.stages[0]?.steps[0]
    expect(step?.id).toBe('tsk-lint')
    expect(step?.command).toEqual({ type: 'shell', value: { command: 'npm run lint 2>&1' } })
  })

  it('chains adjacent tasks within a scenario and links the last task to the next scenario', () => {
    const v1MultiYaml = `id: v1-multi
name: 多任务
version: "1.0.0"
stages:
  - id: stg-1
    name: 分析
    scenarios:
      - id: sce-1
        name: 静态分析
        tasks:
          - id: tsk-a
            name: A
            prompt:
              type: Bash
              value:
                command: "echo a"
          - id: tsk-b
            name: B
            prompt:
              type: Bash
              value:
                command: "echo b"
          - id: tsk-c
            name: C
            prompt:
              type: Bash
              value:
                command: "echo c"
        next: sce-2
      - id: sce-2
        name: 动态分析
        tasks:
          - id: tsk-d
            name: D
            prompt:
              type: Bash
              value:
                command: "echo d"
`
    const definition = parseWorkflowYaml(v1MultiYaml)
    const steps = definition.stages[0]?.steps
    expect(steps?.map(step => step.id)).toEqual(['tsk-a', 'tsk-b', 'tsk-c', 'tsk-d'])
    expect(steps?.[0]?.branches?.[0]?.next).toBe('tsk-b')
    expect(steps?.[1]?.branches?.[0]?.next).toBe('tsk-c')
    expect(steps?.[2]?.branches?.[0]?.next).toBe('tsk-d')
    expect(steps?.[3]?.branches).toBeUndefined()
  })

  it('rejects a stage that mixes steps and scenarios', () => {
    const mixedYaml = `id: wfl-mixed
name: demo
version: "1.0.0"
stages:
  - id: stg-1
    name: 分析
    steps:
      - id: step-1
    scenarios:
      - id: sce-1
        name: 静态分析
        tasks:
          - id: tsk-1
            name: lint
            prompt:
              type: Bash
              value:
                command: "echo hi"
`
    try {
      parseWorkflowYaml(mixedYaml)
      expect.unreachable('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowYamlError)
      expect((error as WorkflowYamlError).code).toBe('DEFINITION_INVALID')
    }
  })
})

describe('serializeWorkflowYaml', () => {
  it('round-trips a parsed definition', () => {
    const definition = parseWorkflowYaml(v2Yaml)
    const roundTripped = parseWorkflowYaml(serializeWorkflowYaml(definition))
    expect(roundTripped).toEqual(definition)
  })
})
