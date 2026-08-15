/**
 * yaml-parser.ts 的 V1/V2 解析、序列化与类型化错误单元测试。
 * @module @deepseek-ai/dsh-sandore-workflow/src/yaml-parser.spec
 */
import { describe, expect, it } from 'vitest'

import { SandoreError } from './errors.ts'
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

  it('throws SandoreError YAML_PARSE with line info on syntax error', () => {
    try {
      parseWorkflowYaml('stages: [ Unclosed')
      expect.unreachable('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(SandoreError)
      const sandoreError = error as SandoreError
      expect(sandoreError.code).toBe('YAML_PARSE')
      expect(sandoreError.message).toMatch(/line \d+/)
    }
  })

  it('throws DEFINITION_INVALID when a next target does not exist', () => {
    const badYaml = `id: wfl-x
name: demo
version: "1.0.0"
stages:
  - id: stg-1
    name: 分析
    steps:
      - id: step-1
        next: step-missing
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
      expect(error).toBeInstanceOf(SandoreError)
      const sandoreError = error as SandoreError
      expect(sandoreError.code).toBe('DEFINITION_INVALID')
      expect(sandoreError.message).toContain('step-missing')
    }
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
      expect(error).toBeInstanceOf(SandoreError)
      expect((error as SandoreError).code).toBe('DEFINITION_INVALID')
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
