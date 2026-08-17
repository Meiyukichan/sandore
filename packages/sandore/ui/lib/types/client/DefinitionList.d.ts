import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { WorkflowDefinitionEntry } from '@deepseek-ai/dsh-sandore-workflow/remote';
/** DefinitionList 接收的普通业务 props。 */
export interface DefinitionListProps {
    /** 类型化的翻译函数（sandore 命名空间）。 */
    t: TranslateNS<'sandore'>;
    /** 客户端过滤关键词（匹配 name / id）。 */
    query: string;
    /** 拉取定义列表（RPC 已解包）。 */
    listDefinitions(): Promise<WorkflowDefinitionEntry[]>;
    /** 删除定义（RPC 已解包）。 */
    deleteDefinition(id: string): Promise<boolean>;
    /** 点击定义行下钻 DagEditor（传入 id 与原始 yaml）。 */
    onOpen(definitionId: string, initialYaml: string): void;
}
/** 渲染 DefinitionList。 */
export declare function DefinitionList({ t, query, listDefinitions, deleteDefinition, onOpen }: DefinitionListProps): import("react").JSX.Element;
//# sourceMappingURL=DefinitionList.d.ts.map