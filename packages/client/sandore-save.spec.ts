/**
 * sandore-save.ts（save adapter 分发 + 错误归一化）的单元测试：
 * `createSandoreSave` 在 `id === undefined` 走 `createDefinition`、否则走
 * `updateYaml` 并返回保存后的 id；`describeSaveError` 把各类错误统一为
 * 含校验详情的 `SaveErrorInfo`（SandoreRemoteError 取 details / WorkflowYamlError
 * 取 code+cause / zod 取 issues 摘要 / 通用 Error 回落 message）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/sandore-save.spec
 */
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkflowDefinitionEntry } from 'dsh-sandore/remote'
import { WorkflowYamlError } from '../workflow/yaml-error'
import { describe, expect, it, vi } from 'vitest'

import { SandoreRemoteError } from './remote.ts'
import { createSandoreSave, describeSaveError, type SandoreSaveRemote } from './sandore-save.ts'

/** 构造一个合法的定义条目（用于 mock remote 的成功返回）。 */
function okEntry(id: string): WorkflowDefinitionEntry {
  return {
    id,
    yaml: 'id: x',
    name: 'n',
    version: '1.0.0',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/** 构造一个未发生调用的 `updateYaml` mock（供 createDefinition 分支断言）。 */
function mockUpdateYaml(): (id: string, yaml: string) => Promise<RemoteResult<WorkflowDefinitionEntry>> {
  return vi.fn(async (_id: string, _yaml: string): Promise<RemoteResult<WorkflowDefinitionEntry>> => ({
    ok: true,
    value: okEntry('wfl-unexpected'),
  }))
}

/** 构造一个未发生调用的 `createDefinition` mock（供 updateYaml 分支断言）。 */
function mockCreateDefinition(): (input: { yaml: string }) => Promise<RemoteResult<WorkflowDefinitionEntry>> {
  return vi.fn(async (_input: { yaml: string }): Promise<RemoteResult<WorkflowDefinitionEntry>> => ({
    ok: true,
    value: okEntry('wfl-unexpected'),
  }))
}

/** 一个携带 `issues` 数组的 Error 子类，模拟 zod 的 `ZodError` 结构（避免引入 zod 依赖）。 */
class ZodLikeError extends Error {
  readonly issues: readonly Record<string, unknown>[]

  constructor() {
    super('validation failed')
    this.issues = [{ path: ['stages', 0, 'name'], message: 'Required' }]
  }
}

describe('createSandoreSave', () => {
  it('dispatches to createDefinition when id is undefined and returns the new id', async () => {
    const createDefinition = vi.fn(async (input: { yaml: string }): Promise<RemoteResult<WorkflowDefinitionEntry>> => ({
      ok: true,
      value: okEntry('wfl-1'),
    }))
    const updateYaml = mockUpdateYaml()
    const remote: SandoreSaveRemote = { createDefinition, updateYaml }

    const savedId = await createSandoreSave(remote)(undefined, 'id: x')

    expect(savedId).toBe('wfl-1')
    expect(createDefinition).toHaveBeenCalledWith({ yaml: 'id: x' })
    expect(updateYaml).not.toHaveBeenCalled()
  })

  it('dispatches to updateYaml when id is defined and returns that id', async () => {
    const createDefinition = mockCreateDefinition()
    const updateYaml = vi.fn(async (id: string, yaml: string): Promise<RemoteResult<WorkflowDefinitionEntry>> => ({
      ok: true,
      value: okEntry(id),
    }))
    const remote: SandoreSaveRemote = { createDefinition, updateYaml }

    const savedId = await createSandoreSave(remote)('wfl-2', 'id: x')

    expect(savedId).toBe('wfl-2')
    expect(updateYaml).toHaveBeenCalledWith('wfl-2', 'id: x')
    expect(createDefinition).not.toHaveBeenCalled()
  })

  it('propagates a failed createDefinition as a SandoreRemoteError', async () => {
    const failure: RemoteFailure = { code: 'DEFINITION_INVALID', message: 'bad', details: { hint: 'x' } }
    const createDefinition = vi.fn(async (): Promise<RemoteResult<WorkflowDefinitionEntry>> => ({ ok: false, error: failure }))
    const remote: SandoreSaveRemote = { createDefinition, updateYaml: mockUpdateYaml() }

    await expect(createSandoreSave(remote)(undefined, 'id: x')).rejects.toBeInstanceOf(SandoreRemoteError)
  })
})

describe('describeSaveError', () => {
  it('normalizes a SandoreRemoteError by taking its details', () => {
    const error = new SandoreRemoteError({ code: 'YAML_PARSE', message: 'broken', details: { line: 3 } })

    const info = describeSaveError(error)

    expect(info.message).toBe('YAML_PARSE: broken')
    expect(info.details).toBe('{"line":3}')
  })

  it('normalizes a WorkflowYamlError with a zod cause into an issues summary', () => {
    const cause = new ZodLikeError()
    const error = new WorkflowYamlError('invalid workflow definition', 'DEFINITION_INVALID', { cause })

    const info = describeSaveError(error)

    expect(info.message).toBe('invalid workflow definition')
    expect(info.details).toBe('stages.0.name: Required')
  })

  it('normalizes a WorkflowYamlError without a cause to its code', () => {
    const error = new WorkflowYamlError('invalid YAML: BAD_INDENT at line 1', 'YAML_PARSE')

    const info = describeSaveError(error)

    expect(info.message).toBe('invalid YAML: BAD_INDENT at line 1')
    expect(info.details).toBe('YAML_PARSE')
  })

  it('normalizes a raw zod error into an issues summary', () => {
    const error = new ZodLikeError()

    const info = describeSaveError(error)

    expect(info.message).toBe('validation failed')
    expect(info.details).toBe('stages.0.name: Required')
  })

  it('normalizes a generic Error to its message with no details', () => {
    const info = describeSaveError(new Error('boom'))

    expect(info.message).toBe('boom')
    expect(info.details).toBeUndefined()
  })

  it('normalizes a non-Error thrown value to its string form', () => {
    const info = describeSaveError('nope')

    expect(info.message).toBe('nope')
    expect(info.details).toBeUndefined()
  })
})
