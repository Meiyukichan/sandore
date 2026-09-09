/**
 * 任务规则三级合并解析器（缺陷 7 修复）。
 *
 * 工作流定义在 schema 三级声明了 `rules` 字段（workflow 级 `Record<string,string>`
 * 键值对内容表 + stage/step 级 `string[]` 键引用数组），但运行时零消费。本模块提供
 * 纯函数 {@link resolveStepRules}，照抄基准 `workflow-engine-v2` 的 3 级合并语义
 * （就近原则），在 Step 执行前把「step.rules ∪ stage.rules 去重键」或「两者都空时
 * 继承 workflow.rules 全部键」解析为 `{ key: content }` 映射，供提示词注入。
 *
 * 合并规则：
 * 1. `step.rules ∪ stage.rules`——键去重（`Set` 保序去重），逐键查 `workflow.rules`
 *    取内容；未知键（不在 `workflow.rules` 中）忽略。
 * 2. `step.rules` 与 `stage.rules` 都空时——继承 `workflow.rules` 全部键。
 * 3. 内容为空字符串的键视为无内容，跳过（与基准 `if (workflowRules[key])` 一致）。
 *
 * 纯函数：无副作用、无 IO，可直接单测。
 * @module @meiyukichan/dsh-sandore/microflow/src/rules-resolver
 */
import type { WorkflowDefinition, WorkflowStage, WorkflowStep } from '../workflow/schema';

/**
 * 解析某 Step 的任务规则（3 级合并：step ∪ stage → workflow.rules 查内容）。
 *
 * @param workflowDef - 工作流定义（提供 `rules` 内容表 `Record<string,string>`）。
 * @param stageDef - Stage 定义（提供 `rules` 键引用数组，可选）。
 * @param step - Step 定义（提供 `rules` 键引用数组，可选）。
 * @returns 解析后的 `{ key: content }` 映射；无规则时返回空对象 `{}`。
 */
export function resolveStepRules(
  workflowDef: WorkflowDefinition,
  stageDef: WorkflowStage,
  step: WorkflowStep,
): Record<string, string> {
  const workflowRules = workflowDef.rules ?? {};
  const stepRules = step.rules ?? [];
  const stageRules = stageDef.rules ?? [];

  // 确定要查找的规则键集合：
  // - step.rules 与 stage.rules 都空 → 继承 workflow.rules 全部键
  // - 否则取 step.rules ∪ stage.rules 去重键（保序：先 step 后 stage）
  let keys: string[];
  if (stepRules.length === 0 && stageRules.length === 0) {
    keys = Object.keys(workflowRules);
  } else {
    keys = [...new Set([...stepRules, ...stageRules])];
  }

  // 逐键查 workflow.rules 取内容；未知键（undefined）与空字符串内容跳过
  // （对齐基准 `if (workflowRules[key])` 真值判定）。
  const result: Record<string, string> = {};
  for (const key of keys) {
    const content = workflowRules[key];
    if (content) {
      result[key] = content;
    }
  }
  return result;
}
