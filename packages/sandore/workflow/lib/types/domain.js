/**
 * sandore 存储域声明（Node 侧）。
 *
 * `sandoreDomainSpec` 依赖 `@deepseek-ai/dsh-storage-domain`（Node 侧 cordis 插件），
 * 故从浏览器安全的 `schema.ts` 拆出至此，使定义层 schema 可作为 `./schema` 子路径
 * 在浏览器侧安全导入。定义/Job/状态三表的 value schema 仍来自 `./schema.ts`（纯 zod）。
 * @module @deepseek-ai/dsh-sandore-workflow/src/domain
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { JobRecordSchema, WorkflowDefinitionRecordSchema, WorkflowTaskStateSchema, } from "./schema.js";
/** sandore 存储域声明：三表 `definitions`/`jobs`/`state`，Zod 校验每一条记录。 */
export const sandoreDomainSpec = defineDomain({
    name: 'sandore',
    version: 1,
    tables: {
        definitions: domainTable(WorkflowDefinitionRecordSchema),
        jobs: domainTable(JobRecordSchema),
        state: domainTable(WorkflowTaskStateSchema),
    },
});
//# sourceMappingURL=domain.js.map