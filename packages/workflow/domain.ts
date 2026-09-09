/**
 * sandore 存储域声明（Node 侧）。
 *
 * `sandoreDomainSpec` 依赖 `@deepseek-ai/dsh-storage-domain`（Node 侧 cordis 插件），
 * 故从浏览器安全的 `schema.ts` 拆出至此，使定义层 schema 可作为 `./schema` 子路径
 * 在浏览器侧安全导入。定义/Job/状态三表的 value schema 仍来自 `./schema.ts`（纯 zod）。
 *
 * 三级分离（definition-library-plan）：新增 `steps`/`microflows` 两库表。
 * `version` 保持 1——存储后端对 version 不匹配的介质**拒开**（spec.d.ts「a medium
 * stamped with a different version rejects at open」），新增空表无需迁移旧记录，
 * bump version 反而会让旧实例域打不开；表布局由当前 spec 的 `tables` 声明驱动。
 * @module @meiyukichan/dsh-sandore/workflow/src/domain
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

import {
  MicroflowRecordSchema,
  StepRecordSchema,
  WorkflowDefinitionRecordSchema,
  WorkflowTaskStateSchema,
  type MicroflowRecord,
  type StepRecord,
  type WorkflowDefinitionRecord,
  type WorkflowTaskState,
} from './schema.ts'

/**
 * sandore 存储域声明：四表 `definitions`/`state`/`steps`/`microflows`，Zod 校验每一条
 * 记录（去 job 概念）。库表 key：`steps` = `step-{uuid}`，`microflows` = `stg-{uuid}`，
 * 与 workflow yaml 内 id / 运行时引用三边同字符串。
 */
export const sandoreDomainSpec = defineDomain({
  name: 'sandore',
  version: 1,
  tables: {
    definitions: domainTable<string, WorkflowDefinitionRecord>(WorkflowDefinitionRecordSchema),
    state: domainTable<string, WorkflowTaskState>(WorkflowTaskStateSchema),
    steps: domainTable<string, StepRecord>(StepRecordSchema),
    microflows: domainTable<string, MicroflowRecord>(MicroflowRecordSchema),
  },
})
