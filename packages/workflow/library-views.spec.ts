/**
 * `library-views.ts` 的单元测试：库条目引用扫描（含坏记录跳过、三边同 id 口径）与
 * 摘要组装。全 mock，无宿主依赖（对齐 remote.spec / persistence.spec 风格）。
 * @module @meiyukichan/dsh-sandore/workflow/src/library-views.spec
 */
import { describe, expect, it } from 'vitest';

import { collectLibraryReferences, toLibrarySummary } from './library-views.ts';
import type { DefinitionsView } from './library-views.ts';
import type { WorkflowDefinitionRecord } from './schema.ts';

/** 最小合法定义 yaml（单 Stage 单 Step）。 */
function definitionYaml(workflowId: string, stageId: string, stepId: string): string {
  return `id: ${workflowId}
name: Flow-${workflowId}
version: '1'
stages:
  - id: ${stageId}
    name: Stage
    steps:
      - id: ${stepId}
steps:
  - id: ${stepId}
    name: Step
    command:
      type: shell
      value:
        command: echo hi
`;
}

/** 构造 definitions 表视图（Map 背书）。 */
function makeDefinitionsView(rows: Array<[string, string]>): DefinitionsView {
  const map = new Map<string, WorkflowDefinitionRecord>();
  for (const [id, yaml] of rows) {
    map.set(id, { yaml, name: `n-${id}`, version: '1', createdAt: 't0', updatedAt: 't1' });
  }
  return { entries: () => map.entries() };
}

describe('collectLibraryReferences', () => {
  it('collects stage ids into microflowRefs and step ids into stepRefs across workflows', () => {
    const view = makeDefinitionsView([
      ['wfl-a', definitionYaml('wfl-a', 'stg-1', 'step-1')],
      ['wfl-b', definitionYaml('wfl-b', 'stg-2', 'step-1')],
    ]);
    const refs = collectLibraryReferences(view);
    expect([...refs.microflowRefs.get('stg-1')]).toEqual(['wfl-a']);
    expect([...refs.microflowRefs.get('stg-2')]).toEqual(['wfl-b']);
    // 同一 step id 被多个 workflow 引用：集合聚合。
    expect([...refs.stepRefs.get('step-1')].sort()).toEqual(['wfl-a', 'wfl-b']);
  });

  it('skips broken yaml records without failing the scan', () => {
    const view = makeDefinitionsView([
      ['wfl-bad', 'stages: [oops'],
      ['wfl-ok', definitionYaml('wfl-ok', 'stg-1', 'step-1')],
    ]);
    const refs = collectLibraryReferences(view);
    expect(refs.microflowRefs.has('stg-1')).toBe(true);
    expect(refs.stepRefs.has('step-1')).toBe(true);
    expect(refs.microflowRefs.size).toBe(1);
  });

  it('counts top-level step definitions as step references too', () => {
    const yaml = `id: wfl-c
name: Flow
version: '1'
stages:
  - id: stg-1
    name: Stage
    steps:
      - id: step-a
steps:
  - id: step-a
    name: A
  - id: step-orphan
    name: Orphan
`;
    const refs = collectLibraryReferences(makeDefinitionsView([['wfl-c', yaml]]));
    expect([...refs.stepRefs.get('step-orphan')]).toEqual(['wfl-c']);
  });
});

describe('toLibrarySummary', () => {
  it('builds the library list row with referencedBy count', () => {
    const refs = new Map<string, Set<string>>([['step-1', new Set(['wfl-a', 'wfl-b'])]]);
    const summary = toLibrarySummary('step-1', { name: '构建', version: '2', updatedAt: 't9' }, refs);
    expect(summary).toEqual({ id: 'step-1', name: '构建', version: '2', referencedBy: 2, updatedAt: 't9' });
  });

  it('defaults referencedBy to 0 and omits version when absent', () => {
    const summary = toLibrarySummary('step-2', { name: '无版本', updatedAt: 't0' }, new Map());
    expect(summary).toEqual({ id: 'step-2', name: '无版本', referencedBy: 0, updatedAt: 't0' });
    expect('version' in summary).toBe(false);
  });
});
