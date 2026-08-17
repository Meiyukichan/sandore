import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { TimelineItem } from './run-view-model.ts';
/** 渲染统一时间线。 */
export declare function UnifiedTimeline({ t, items, openSession }: {
    /** 类型化翻译函数。 */
    t: TranslateNS<'sandore'>;
    /** 时间线条目（buildTimeline 派生）。 */
    items: readonly TimelineItem[];
    /** 跳子会话/宿主会话。 */
    openSession: (id: string) => void;
}): import("react").JSX.Element;
//# sourceMappingURL=UnifiedTimeline.d.ts.map