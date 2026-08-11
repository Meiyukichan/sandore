/**
 * 交互式会话脚本 —— 基于 @anthropic-ai/claude-agent-sdk
 *
 * 三个核心动作：
 *   1. 创建 session —— query() 以流式输入模式启动一个持久会话（system/init 消息里带 session_id）
 *   2. 发送消息   —— 异步生成器 yield SDKUserMessage，stdin 输入入队后交给生成器
 *   3. 流式获取   —— includePartialMessages: true 后逐 token 消费 stream_event，回合结束收到 result
 *
 * 运行：
 *   cd scripts
 *   npm install
 *   npm run chat              # 直接进入交互
 *   npm run chat -- 你好      # 先自动发送一条消息，再进入交互
 *   npm run chat -- --resume <sessionId>   # 恢复历史会话继续对话
 *
 * 前置条件：本机已通过 claude 登录或设置了 ANTHROPIC_API_KEY。
 */
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

// ---------------------------------------------------------------------------
// 消息队列：stdin 读取与消息流消费是两个并行的异步任务，
// 通过队列解耦 —— 用户输入先入队，prompt 生成器从队列取出后 yield 给会话。
// ---------------------------------------------------------------------------
const pending: SDKUserMessage[] = [];
let wake: (() => void) | null = null;

function enqueueUserMessage(text: string): void {
  pending.push({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  });
  wake?.();
}

/** 流式输入模式的 prompt：无限异步生成器，队列里有消息才产出。 */
async function* chatStream(): AsyncGenerator<SDKUserMessage> {
  for (;;) {
    while (pending.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
    yield pending.shift()!;
  }
}

// ---------------------------------------------------------------------------
// 命令行参数解析：可选的首条消息，或 --resume <sessionId>
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const resumeIdx = args.indexOf("--resume");
const resumeSessionId = resumeIdx >= 0 ? args[resumeIdx + 1] : undefined;
const initialMessage = (resumeIdx >= 0 ? args.slice(resumeIdx + 2) : args).join(" ").trim();

async function main(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });

  let sessionId: string | undefined;
  let inTool = false; // 当前是否正在执行工具（用于决定文本是否直接流式打印）

  // 创建会话。prompt 传异步生成器 => 流式输入模式（多轮持久会话）。
  const q = query({
    prompt: chatStream(),
    options: {
      cwd: process.cwd(),
      resume: resumeSessionId, // 指定后恢复历史会话，而不是新开一个
      includePartialMessages: true, // 开启 token 级流式事件
      maxTurns: 20, // 单次问答的最大工具轮次，防止失控
      // 列出的工具自动放行（免去权限交互）。可按需增删，或改用 permissionMode/canUseTool。
      allowedTools: ["Read", "Glob", "Grep", "Bash", "Edit", "Write", "Task", "WebSearch", "WebFetch"],
    },
  });

  // ---- 任务 1：流式消费会话消息 ----
  const consume = (async () => {
    for await (const message of q) {
      switch (message.type) {
        // 会话初始化：拿到 session_id
        case "system":
          if (message.subtype === "init") {
            sessionId = message.session_id;
            console.log(
              `\n[会话${resumeSessionId ? "已恢复" : "已创建"}] sessionId=${sessionId}\n`
            );
          }
          break;

        // token 级流式事件（需要 includePartialMessages）
        case "stream_event": {
          const event = message.event;
          if (event.type === "message_start") {
            process.stdout.write("助手 > ");
          } else if (event.type === "content_block_start") {
            if (event.content_block.type === "tool_use") {
              process.stdout.write(`\n[工具] ${event.content_block.name} `);
              inTool = true;
            }
          } else if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta" && !inTool) {
              process.stdout.write(event.delta.text); // 逐 token 打印回复
            } else if (event.delta.type === "input_json_delta") {
              process.stdout.write(event.delta.partial_json); // 工具入参增量
            }
          } else if (event.type === "content_block_stop" && inTool) {
            console.log();
            inTool = false;
          }
          break;
        }

        // 完整助手消息：包含结构化的文本 / 工具调用块
        case "assistant":
          for (const block of message.message.content) {
            if (block.type === "tool_use") {
              console.log(`[工具调用] ${block.name}(${JSON.stringify(block.input)})`);
            }
          }
          break;

        // 一个回合结束
        case "result": {
          const ok = message.subtype === "success";
          console.log(
            `\n[${ok ? "完成" : "结束"}] subtype=${message.subtype} ` +
              `duration=${message.duration_ms}ms cost=$${message.total_cost_usd.toFixed(4)}\n`
          );
          break;
        }
      }
    }
  })();

  // ---- 任务 2：读取用户输入并入队 ----
  if (initialMessage) enqueueUserMessage(initialMessage);
  console.log("输入消息开始对话。命令：/exit 退出  /session 查看会话ID\n");

  for (;;) {
    const line = await rl.question("你 > ");
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "/exit" || trimmed === "/quit") break;
    if (trimmed === "/session") {
      console.log(`sessionId: ${sessionId ?? "（会话尚未初始化）"}`);
      continue;
    }
    enqueueUserMessage(trimmed);
  }

  // 结束会话：关闭查询并终止底层 CLI 进程
  q.close();
  rl.close();
  await consume;
}

main().catch((error) => {
  console.error("\n会话出错：", error instanceof Error ? error.message : error);
  console.error("若提示认证失败，请先 `claude` 登录或设置 ANTHROPIC_API_KEY。");
  process.exitCode = 1;
});
