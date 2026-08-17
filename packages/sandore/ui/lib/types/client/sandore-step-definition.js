/** 由 stepId + 循环迭代路径派生稳定节点 id（`step-xxx` 或 `step-xxx#1.2`）。 */
export function nodeIdOf(stepId, loopIteration) {
    return loopIteration === undefined || loopIteration.length === 0
        ? stepId
        : `${stepId}#${loopIteration.join('.')}`;
}
/** 循环迭代路径 → 展示标签（`#1.2`），非循环返回 undefined。 */
export function loopLabelOf(loopIteration) {
    return loopIteration === undefined || loopIteration.length === 0
        ? undefined
        : `#${loopIteration.join('.')}`;
}
/** 单个 Step 的讨论节点状态机（sandore 6 个 step-* 事件折叠）。 */
export const sandoreStepDefinition = {
    kind: 'sandore-step',
    target: 'chat',
    match: (event) => {
        if (event.type === 'sandore/step-start') {
            return { id: nodeIdOf(event.data.stepId, event.data.loopIteration), role: 'start' };
        }
        if (event.type === 'sandore/step-completed'
            || event.type === 'sandore/step-failed'
            || event.type === 'sandore/step-paused'
            || event.type === 'sandore/step-resumed'
            || event.type === 'sandore/step-retried') {
            return { id: nodeIdOf(event.data.stepId, event.data.loopIteration), role: 'update' };
        }
        return null;
    },
    start: (_context, match) => {
        if (match.event.type !== 'sandore/step-start') {
            throw new Error('sandore-step start requires sandore/step-start');
        }
        const { stepId, childId, name, loopIteration } = match.event.data;
        return {
            stepId,
            // brand 仅编译期标记，运行时就是同一字符串。
            childId: childId,
            name,
            status: 'running',
            ...(loopIteration === undefined ? {} : { loopIteration }),
        };
    },
    update: (context, match) => {
        switch (match.event.type) {
            case 'sandore/step-completed': {
                const output = [];
                for (const block of match.event.data.output) {
                    if (block.type === 'text')
                        output.push({ type: 'text', text: block.text });
                }
                return { ...context.state, status: 'completed', output };
            }
            case 'sandore/step-failed':
                return { ...context.state, status: 'failed', error: match.event.data.error };
            case 'sandore/step-paused':
                return { ...context.state, status: 'paused' };
            case 'sandore/step-resumed':
            case 'sandore/step-retried':
                return { ...context.state, status: 'running' };
            /* v8 ignore next -- update 仅对 match 命中的 5 个 step-* 事件派发。 */
            default:
                return context.state;
        }
    },
    buildViewNode: (context) => {
        if (context.start === undefined || context.state === undefined)
            return null;
        const state = context.state;
        return {
            key: context.key,
            kind: 'sandore-step',
            id: context.id,
            target: 'chat',
            anchorSeq: context.start.event.seq,
            location: context.start.location,
            visibility: 'visible',
            data: {
                stepId: state.stepId,
                childId: state.childId,
                name: state.name,
                status: state.status,
                ...(state.loopIteration === undefined ? {} : { loopLabel: loopLabelOf(state.loopIteration) }),
                ...(state.output === undefined ? {} : { output: state.output }),
                ...(state.error === undefined ? {} : { error: state.error }),
            },
        };
    },
};
//# sourceMappingURL=sandore-step-definition.js.map