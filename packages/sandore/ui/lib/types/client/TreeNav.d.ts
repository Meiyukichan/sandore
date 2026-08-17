import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { RunTreeNode } from './run-view-model.ts';
/** 叶子节点点击载荷（预览目标）。 */
export interface TreeLeafSelection {
    /** 叶子节点 id（供高亮匹配）。 */
    readonly leafId: string;
    readonly kind: 'result' | 'artifact';
    readonly stepId: string;
    readonly name: string;
    readonly meta?: string | undefined;
    readonly text?: string | undefined;
}
/** TreeNav 接收的 props。 */
export interface TreeNavProps {
    /** 类型化的翻译函数（sandore 命名空间）。 */
    t: TranslateNS<'sandore'>;
    /** 树形导航数据（buildRunTree 派生）。 */
    tree: readonly RunTreeNode[];
    /** 当前预览叶子 id（高亮）。 */
    activePreviewId: string | null;
    /** 点击叶子 → 打开右栏预览。 */
    onSelectLeaf(selection: TreeLeafSelection): void;
    /** 跳子代理会话（Step 行 ↗）。 */
    onOpenChild(childId: string): void;
}
/** 渲染树形导航。 */
export declare function TreeNav({ t, tree, activePreviewId, onSelectLeaf, onOpenChild }: TreeNavProps): import("react").JSX.Element;
//# sourceMappingURL=TreeNav.d.ts.map