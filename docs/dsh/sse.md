## 是 SSE 吗？—— 是，SSE 是下行载体

DSH 的 Web 通信用的是「四象限 RPC」模型（`packages/host/apiproxy/src/api/rpc.ts` 开头就写明）：HTTP、WebSocket、进程内 SSE 都只是**物理载体**，逻辑消息与通道解耦。实际 Web GUI 走的是：

- **上行（浏览器 → host）**：普通 `HTTP POST /api/<method>`（如 `session.prompt`），JSON 信封
- **下行（host → 浏览器）**：**SSE** —— 一条常驻的 `GET /api/events.mux`（`content-type: text/event-stream`），每帧一行 `data: {json}\n\n`，载荷是 `server-request` 信封包着一个 `MuxFrame`（`session/event`、`approval/requested`、`question/requested`、`session/queue` 等）

有个细节：浏览器端**不是用 `EventSource`**，而是用 streaming `fetch` 读 SSE 响应（`packages/host/apiproxy/src/fetch/client.ts` 的 `readSse()`，注释明确写 "streaming fetch (not EventSource)"），自己按 `\n\n` 切帧、zod 校验。

## 数据从哪来？—— 五级链路

**① 上游 LLM provider（最源头）**
`packages/llm/llm-deepseek/src/adapter.ts` 的 `DeepSeekAdapter.request()`：向 `${baseURL}/chat/completions` 发 `POST`，带 `accept: text/event-stream`，然后 `yield* translate(parseSse(response.body, onComment))`。`sse.ts` 用 `eventsource-parser` 把上游字节流解析成 SSE 帧，`translate.ts` 把每个 `chat.completion.chunk` 翻译成 harness 的 `StreamChunk`（`text-delta` / reasoning / `tool-call` / `finish`）。

**② Agent 循环（消费流并落日志）**
`packages/core/agent-loop/src/agent.ts` 的 `step()`：
```ts
for await (const chunk of stream) {
  chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq)
  assembler.push(chunk)
}
```
每个 chunk 作为一条 `assistant/chunk` **session 事件**追加进会话日志（`packages/core/session/src/types.ts` 里的 `SessionEventMap`）。流结束后再 `append('assistant/message', ...)` 汇总成完整消息，并记录 `sourceEventSeqs` 关联 chunk。

**③ ApiProxy（事件 → MuxFrame 推流）**
`packages/host/apiproxy/src/api-proxy.ts` 监听 `ctx.on('session/event', ...)`，会话每落一条事件就 `queue.push(frame({ type: 'session/event', ... }))` 推给所有已连接的 `FrameQueue`（第 3412–3430 行）；审批/提问/队列等控制帧走 `broadcast()`（第 1243 行）。

**④ SSE 载体（出 HTTP）**
`packages/host/apiproxy/src/fetch/handler.ts` 的 `sseResponse()`：`GET /api/events.mux` 打开时先发一行 `: connected\n\n` 注释（防止空闲时零字节），然后每个帧编码成 `data: {json}\n\n` 逐个 `controller.enqueue()`。

**⑤ 浏览器（渲染）**
`client.ts` 的 `readSse()` 读到帧后按 `muxFrameSchema` 校验，交给 Web UI；UI 拿到 `session/event` 里的 `assistant/chunk`（text-delta）就增量渲染，所以你能看到逐字输出。

另外还有一条独立的 `GET /api/events.host` 流（会话增删、运行状态翻转），以及仅开发期用的 HMR SSE 通道 `/plugins/events`（`packages/client/hmr`）。架构上 rpc.ts 也预留了 WebSocket 载体，但当前 Web GUI 实际用的是「HTTP POST 上行 + SSE GET 下行」。