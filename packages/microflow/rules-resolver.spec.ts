/**
 * rules-resolver.ts（resolveStepRules）的单元测试：3 级合并语义（缺陷 7 修复）。
 *
 * 覆盖基准 `workflow-engine-v2` L392-415 的 4 个功能点：
 * - step.rules 优先（与 stage.rules 并集去重）
 * - step.rules 与 stage.rules 都空时继承 workflow.rules 全部键
 * - step.rules ∪ stage.rules 去重
 * - 未知键（不在 workflow.rules 中）忽略
 * @module dsh-sandore/microflow/src/rules-resolver.spec
 */
import { describe, expect, it } from 'vitest';

import type { WorkflowDefinition, WorkflowStage, WorkflowStep } from '../workflow/schema';
import { resolveStepRules } from './rules-resolver.ts';

/** 组装最小工作流定义（可选 workflow 级 rules）。 */
function workflowDef(rules?: Record<string, string>): WorkflowDefinition {
  return {
    id: 'wfl-1',
    name: 'wfl',
    version: '1',
    settings: {},
    stages: [],
    ...(rules === undefined ? {} : { rules }),
  };
}

/** 组装最小 Stage（可选 stage 级 rules）。 */
function stageDef(rules?: string[]): WorkflowStage {
  return {
    id: 'stg-1',
    name: 'Stage 1',
    steps: [{ id: 'step-1' }],
    ...(rules === undefined ? {} : { rules }),
  };
}

/** 组装最小 Step（可选 step 级 rules）。 */
function stepDef(rules?: string[]): WorkflowStep {
  return {
    id: 'step-1',
    command: { type: 'prompt', value: { promptText: 'do work' } },
    ...(rules === undefined ? {} : { rules }),
  };
}

describe('resolveStepRules — 3 级合并', () => {
  it('step.rules 与 stage.rules 都空时继承 workflow.rules 全部键', () => {
    const def = workflowDef({
      'chinese-output': '所有输出必须使用中文',
      'no-direct-commit': '禁止直接执行 git commit',
    });
    const resolved = resolveStepRules(def, stageDef(), stepDef());
    expect(resolved).toEqual({
      'chinese-output': '所有输出必须使用中文',
      'no-direct-commit': '禁止直接执行 git commit',
    });
  });

  it('step.rules 命中时仅取引用键的内容（不继承 workflow.rules 全部键）', () => {
    const def = workflowDef({
      'chinese-output': '所有输出必须使用中文',
      'no-direct-commit': '禁止直接执行 git commit',
    });
    // step 只引用 chinese-output → 不继承 no-direct-commit
    const resolved = resolveStepRules(def, stageDef(), stepDef(['chinese-output']));
    expect(resolved).toEqual({ 'chinese-output': '所有输出必须使用中文' });
    expect(resolved).not.toHaveProperty('no-direct-commit');
  });

  it('step.rules 与 stage.rules 并集去重（同一键不重复）', () => {
    const def = workflowDef({
      'chinese-output': '所有输出必须使用中文',
      'no-direct-commit': '禁止直接执行 git commit',
    });
    // step 与 stage 都引用 chinese-output → 去重后只取一次
    const resolved = resolveStepRules(
      def,
      stageDef(['chinese-output', 'no-direct-commit']),
      stepDef(['chinese-output']),
    );
    expect(resolved).toEqual({
      'chinese-output': '所有输出必须使用中文',
      'no-direct-commit': '禁止直接执行 git commit',
    });
    // 确保对象中每个键只出现一次（Object.keys 去重）
    expect(Object.keys(resolved)).toEqual(['chinese-output', 'no-direct-commit']);
  });

  it('step.rules 与 stage.rules 都非空时合并双方引用键', () => {
    const def = workflowDef({
      'chinese-output': '所有输出必须使用中文',
      'no-direct-commit': '禁止直接执行 git commit',
      'security-scan': '必须执行安全扫描',
    });
    const resolved = resolveStepRules(
      def,
      stageDef(['no-direct-commit']),
      stepDef(['chinese-output', 'security-scan']),
    );
    expect(resolved).toEqual({
      'chinese-output': '所有输出必须使用中文',
      'security-scan': '必须执行安全扫描',
      'no-direct-commit': '禁止直接执行 git commit',
    });
  });

  it('未知键（不在 workflow.rules 中）忽略', () => {
    const def = workflowDef({ 'chinese-output': '所有输出必须使用中文' });
    // step 引用了不存在于 workflow.rules 的键 'unknown-rule'
    const resolved = resolveStepRules(def, stageDef(), stepDef(['chinese-output', 'unknown-rule']));
    expect(resolved).toEqual({ 'chinese-output': '所有输出必须使用中文' });
    expect(resolved).not.toHaveProperty('unknown-rule');
  });

  it('stage.rules 引用但 step.rules 为空时取 stage 引用键', () => {
    const def = workflowDef({
      'chinese-output': '所有输出必须使用中文',
      'no-direct-commit': '禁止直接执行 git commit',
    });
    // step.rules 缺省（undefined → 视为空），stage.rules 引用 → 走并集分支（非继承全键）
    const resolved = resolveStepRules(def, stageDef(['chinese-output']), stepDef());
    expect(resolved).toEqual({ 'chinese-output': '所有输出必须使用中文' });
    expect(resolved).not.toHaveProperty('no-direct-commit');
  });

  it('workflow.rules 缺省时返回空对象（无规则可查）', () => {
    const resolved = resolveStepRules(workflowDef(), stageDef(), stepDef(['chinese-output']));
    expect(resolved).toEqual({});
  });

  it('内容为空字符串的键视为无内容跳过（对齐基准 if (workflowRules[key]) 真值判定）', () => {
    const def = workflowDef({
      'chinese-output': '所有输出必须使用中文',
      'empty-rule': '',
    });
    // step 与 stage 都空 → 继承全部键，但 empty-rule 内容为空 → 跳过
    const resolved = resolveStepRules(def, stageDef(), stepDef());
    expect(resolved).toEqual({ 'chinese-output': '所有输出必须使用中文' });
    expect(resolved).not.toHaveProperty('empty-rule');
  });

  it('无任何 rules（workflow/stage/step 全缺省）时返回空对象', () => {
    const resolved = resolveStepRules(workflowDef(), stageDef(), stepDef());
    expect(resolved).toEqual({});
  });
});
