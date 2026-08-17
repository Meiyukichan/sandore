/**
 * 选取子代理最终 assistant 输出（与 DSH 源码规则一致，与 stop reason 无关）。
 *
 * 1. 取最后一条非空 `assistant/message` 的 `message.content`（后写覆盖）。
 * 2. 无候选时累积 `assistant/chunk` 中 `text-delta` 文本，非空则返回
 *    `[{ type: 'text', text }]`。
 * 3. 两者皆无返回 `undefined`。
 * @param events - 子代理事件日志（`agent.session.events`）。
 * @returns 选中的 `ContentBlock[]`，或无输出时为 `undefined`。
 */
export function finalAssistantOutput(events) {
    let message;
    const partial = [];
    for (const event of events) {
        if (event.type === 'assistant/message') {
            const content = event.data.message.content;
            if (content.length > 0)
                message = content;
        }
        else if (event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') {
            const text = event.data.chunk.text;
            if (text.length > 0)
                partial.push(text);
        }
    }
    if (message !== undefined)
        return message;
    const text = partial.join('');
    return text.length > 0 ? [{ type: 'text', text }] : undefined;
}
//# sourceMappingURL=subagents.js.map