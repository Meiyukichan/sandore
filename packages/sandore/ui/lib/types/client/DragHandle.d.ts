/**
 * 为元素挂接拖拽监听（约 40 行，同 AppFrame.makeDragHandle 语义）。
 * @param el - 分隔条元素。
 * @param onDrag - 位移回调（px，正值向右）。
 * @returns 移除监听的 disposer。
 */
export declare function attachDragHandle(el: HTMLElement, onDrag: (dx: number) => void): () => void;
/** React 拖拽分隔条组件：渲染 7px 分隔条并挂接拖拽。 */
export declare function DragHandle({ onDrag, side, className }: {
    /** 拖拽位移回调（px）。 */
    onDrag(dx: number): void;
    /** 语义标记（data-side，供样式/测试区分）。 */
    side: string;
    /** 附加 class。 */
    className?: string | undefined;
}): import("react").JSX.Element;
//# sourceMappingURL=DragHandle.d.ts.map