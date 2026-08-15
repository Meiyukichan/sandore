/**
 * schema.ts 三层 Zod Schema 的单元测试。
 * @module @deepseek-ai/dsh-sandore-workflow/src/schema.spec
 */
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { SandoreError, isFatalSandoreError } from './errors.ts'
import {
  CommandConfigSchema,
  JobRecordSchema,
  StepSessionMetaSchema,
  WorkflowDefinitionRecordSchema,
  WorkflowDefinitionSchema,
  WorkflowTaskStateSchema,
  sandoreDomainSpec,
} from './schema.ts'

describe('SandoreError', () => {
  it('extends HarnessError with fatal defaulting to true', () => {
    const error = new SandoreError('bad yaml', 'YAML_PARSE')
    expect(error).toBeInstanceOf(HarnessError)
    expect(error).toBeInstanceOf(SandoreError)
    expect(error.code).toBe('YAML_PARSE')
    expect(error.fatal).toBe(true)
  })

  it('supports non-fatal override', () => {
    const error = new SandoreError('persist retry', 'PERSISTENCE_FAILED', { fatal: false })
    expect(error.fatal).toBe(false)
  })

  it('isFatalSandoreError distinguishes fatal from non-fatal', () => {
    expect(isFatalSandoreError(new SandoreError('x', 'YAML_PARSE'))).toBe(true)
    expect(isFatalSandoreError(new SandoreError('x', 'PERSISTENCE_FAILED', { fatal: false }))).toBe(false)
    expect(isFatalSandoreError(new Error('x'))).toBe(false)
  })
})

describe('WorkflowDefinitionSchema', () => {
  const validDefinition = {
    id: 'wfl-test',
    name: 'demo',
    version: '1.0.0',
    description: 'shell -> prompt',
    stages: [
      { id: 'stg-1', name: '分析', steps: [{ id: 'step-1', next: 'step-2' }] },
      { id: 'stg-2', name: '推理', steps: [{ id: 'step-2' }] },
    ],
    steps: [
      { id: 'step-1', name: 'lint', command: { type: 'shell', value: { command: 'echo hi' } } },
      { id: 'step-2', name: '报告', command: { type: 'prompt', value: { promptText: '生成报告' } } },
    ],
  }

  it('parses a valid V2 object with default settings', () => {
    const parsed = WorkflowDefinitionSchema.parse(validDefinition)
    expect(parsed.id).toBe('wfl-test')
    expect(parsed.settings.defaultTimeout).toBe(120)
    expect(parsed.settings.maxConcurrentAgents).toBe(4)
  })

  it('fills partial settings defaults', () => {
    const parsed = WorkflowDefinitionSchema.parse({ ...validDefinition, settings: { defaultTimeout: 60 } })
    expect(parsed.settings.defaultTimeout).toBe(60)
    expect(parsed.settings.maxConcurrentAgents).toBe(4)
  })

  it('throws a ZodError mentioning stages when stages is missing', () => {
    const { stages, ...withoutStages } = validDefinition
    void stages
    expect(() => WorkflowDefinitionSchema.parse(withoutStages)).toThrow(z.ZodError)
    expect(() => WorkflowDefinitionSchema.parse(withoutStages)).toThrow(/stages/)
  })
})

describe('CommandConfigSchema', () => {
  it('parses the shell variant', () => {
    const parsed = CommandConfigSchema.parse({ type: 'shell', value: { command: 'echo hi' } })
    expect(parsed).toEqual({ type: 'shell', value: { command: 'echo hi' } })
  })

  it('parses all five variants', () => {
    expect(CommandConfigSchema.parse({ type: 'agent', value: { promptText: 'code-reviewer' } }).type).toBe('agent')
    expect(CommandConfigSchema.parse({ type: 'prompt', value: { promptText: 'p' } }).type).toBe('prompt')
    expect(CommandConfigSchema.parse({ type: 'skill', value: { promptText: 's' } }).type).toBe('skill')
    expect(CommandConfigSchema.parse({ type: 'mcp', value: { promptText: 'm' } }).type).toBe('mcp')
  })

  it('rejects an unknown type', () => {
    expect(() => CommandConfigSchema.parse({ type: 'docker', value: { command: 'x' } })).toThrow(z.ZodError)
  })
})

describe('WorkflowTaskStateSchema', () => {
  const executedStep = (id: string, stageId: string, name: string) => ({
    type: 'default' as const,
    id,
    stageId,
    name,
    status: 'completed' as const,
    visitCount: 1,
    command: { type: 'shell' as const, value: { command: 'echo hi' } },
    sessionMeta: { childId: `step-${id}-abc12345`, synthetic: true, command: 'shell' as const },
    output: [{ type: 'text', text: 'hi' }],
  })

  const fullState = {
    taskId: '20250720-143000-abc',
    jobId: 'job-1',
    workflowId: 'wfl-1',
    cwd: '/tmp',
    status: 'completed' as const,
    originalInput: 'do the thing',
    currentStageId: 'stg-2',
    executedSteps: [executedStep('step-1', 'stg-1', 'lint'), executedStep('step-2', 'stg-2', 'report')],
    stageInfos: [
      { id: 'stg-1', name: '分析', status: 'completed' as const },
      { id: 'stg-2', name: '推理', status: 'completed' as const },
    ],
    pendingInteractions: [],
    pendingQueue: [],
    visitCounts: {},
    passThroughVars: {},
    activeLoopIterationStack: [],
    activeLoopNodeId: null,
    activeLoopStack: [],
    pausedStepIds: [],
    stageContracts: {},
    createdAt: '2025-07-20T14:30:00Z',
    updatedAt: '2025-07-20T14:31:00Z',
  }

  it('round-trips a full state with two executed steps', () => {
    const parsed = WorkflowTaskStateSchema.parse(fullState)
    expect(parsed.executedSteps).toHaveLength(2)
    const restored = WorkflowTaskStateSchema.parse(JSON.parse(JSON.stringify(parsed)))
    expect(restored).toEqual(parsed)
  })

  it('has no permissionMode / userChatMessages / defaultSessionMeta fields', () => {
    const parsed = WorkflowTaskStateSchema.parse({
      ...fullState,
      permissionMode: 'default',
      userChatMessages: [{ id: 'm', stageId: 'stg-1', message: 'hi' }],
      defaultSessionMeta: { sessionId: 's', instanceId: 'i' },
    })
    expect(parsed).not.toHaveProperty('permissionMode')
    expect(parsed).not.toHaveProperty('userChatMessages')
    expect(parsed).not.toHaveProperty('defaultSessionMeta')
    expect(Object.keys(WorkflowTaskStateSchema.shape)).not.toContain('permissionMode')
  })
})

describe('StepSessionMetaSchema', () => {
  it('validates the synthetic placeholder shape', () => {
    const meta = StepSessionMetaSchema.parse({ childId: 'step-step-1-abc12345', synthetic: true, command: 'shell' })
    expect(meta).toEqual({ childId: 'step-step-1-abc12345', synthetic: true, command: 'shell' })
  })
})

describe('storage layer', () => {
  it('defines a sandore domain with valid names', () => {
    expect(sandoreDomainSpec.name).toBe('sandore')
    expect(sandoreDomainSpec.version).toBe(1)
    expect(Object.keys(sandoreDomainSpec.tables)).toEqual(['definitions', 'jobs', 'state'])
    for (const name of [sandoreDomainSpec.name, ...Object.keys(sandoreDomainSpec.tables)]) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  it('rejects a WorkflowDefinitionRecord yaml over 65536 chars', () => {
    const record = {
      yaml: 'a'.repeat(65537),
      name: 'n',
      version: '1',
      createdAt: 't',
      updatedAt: 't',
    }
    expect(() => WorkflowDefinitionRecordSchema.parse(record)).toThrow(z.ZodError)
  })

  it('accepts a valid JobRecord', () => {
    const job = JobRecordSchema.parse({ name: 'j', workflowId: 'wfl-1', createdAt: 't', updatedAt: 't' })
    expect(job.workflowId).toBe('wfl-1')
  })
})
