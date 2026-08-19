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
/**
 * 从子代理会话事件归一化消息行（§3.8A：`executedSteps[].sessionMessages` 数据源）。
 *
 * 采集规则（对齐 DSH `core/session/src/types.ts` 事件形状）：
 * - `user/message` → `{type:'text', text}`（取全部 text 块拼接）
 * - `assistant/message` → 逐块归一：text → `{type:'text'}`；reasoning →
 *   `{type:'reasoning'}`；tool-call → `{type:'tool', tool:name, args}`
 * - `tool/result` → `{type:'tool', output}`（取 message.content 的 text 拼接）
 * `assistant/chunk` 与其余事件类型忽略（chunk 已由 message 汇总，避免重复）。
 * @param events - 子代理事件日志（`agent.session.events`）。
 * @returns 归一化后的消息行（无任何可采集行时为 `[]`）。
 */
export function collectSessionMessages(events) {
    const messages = [];
    const pushText = (type, text) => {
        if (text === '')
            return;
        messages.push({ type, text });
    };
    for (const event of events) {
        if (event.type === 'user/message') {
            const text = blocksToText(event.data.content);
            pushText('text', text);
        }
        else if (event.type === 'assistant/message') {
            for (const block of event.data.message.content) {
                if (block.type === 'text') {
                    pushText('text', block.text);
                }
                else if (block.type === 'reasoning') {
                    pushText('reasoning', block.text);
                }
                else if (block.type === 'tool-call') {
                    messages.push({ type: 'tool', tool: block.name, args: block.arguments });
                }
            }
        }
        else if (event.type === 'tool/result') {
            const text = blocksToText(event.data.message.content);
            if (text !== '') {
                messages.push({ type: 'tool', output: text });
            }
        }
    }
    return messages;
}
/** 把 ContentBlock[] 的 text 块拼接为纯文本（空文本块跳过）。 */
function blocksToText(blocks) {
    const parts = [];
    for (const block of blocks) {
        if (block.type === 'text' && block.text !== '') {
            parts.push(block.text);
        }
    }
    return parts.join('\n');
}
//# sourceMappingURL=subagents.js.map