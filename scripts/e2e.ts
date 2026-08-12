/**
 * 真实端到端集成测试 —— 使用 @meiyukichan/claude-sdk（适配层）
 *
 * 验证四条核心链路（真实调用 Claude Code CLI，产生真实 LLM 调用）：
 *   1. 创建会话   —— create({ firstMessage }) 触发 init 捕获真实 session_id；
 *                    以及 create() 无 firstMessage 的惰性回填路径（首条 prompt 后回填）
 *   2. 事件系统   —— session.events() 消费 GlobalEvent（session.created / message.part.* / session.next.step.ended）
 *   3. 流式输出   —— message.part.delta 逐 token 增量文本
 *   4. 消息历史   —— session.messages() 读取会话全部消息（user/assistant）
 *
 * 运行：
 *   cd scripts
 *   npm install          # 若尚未安装依赖
 *   npm run e2e
 *   # 或：npx tsx e2e.ts
 *
 * 前置条件：本机已通过 claude 登录（真实 CLI 可用）。
 */
import { createClaudeClient } from "../packages/sdk/claude/src/client";
import type { GlobalEvent } from "../packages/sdk/claude/src/types";

/** 默认模型（ModelRef.id；缺省让 Claude 自行选择）。 */
const MODEL_ID = process.env.E2E_MODEL ?? "sonnet";

/** 首回合消息。 */
const FIRST_MESSAGE = "用一句话回答：1+1 等于几？不要多余内容。";

/** 第二回合消息（验证多轮对话 + 流式）。 */
const SECOND_MESSAGE = "现在用一句话回答：2+2 等于几？同样不要多余内容。";

// ---------------------------------------------------------------------------
// 事件消费工具
// ---------------------------------------------------------------------------

/** 事件计数统计。 */
interface EventCounters {
  created: number;
  delta: number;
  updated: number;
  stepEnded: number;
  error: number;
  other: number;
}

function newCounters(): EventCounters {
  return { created: 0, delta: 0, updated: 0, stepEnded: 0, error: 0, other: 0 };
}

/** 统计单个 GlobalEvent，并打印关键信息。 */
function tally(ev: GlobalEvent, counters: EventCounters): void {
  switch (ev.payload.type) {
    case "session.created":
      counters.created++;
      // eslint-disable-next-line no-console
      console.log(`  [session.created] sessionID=${(ev.payload.properties as { sessionID?: string }).sessionID}`);
      break;
    case "message.part.delta":
      counters.delta++;
      {
        const p = ev.payload.properties as { field?: string; delta?: unknown };
        const text = typeof p.delta === "string" ? p.delta : JSON.stringify(p.delta);
        process.stdout.write(`  [delta:${p.field ?? "?"}] ${text}`);
      }
      break;
    case "message.part.updated":
      counters.updated++;
      {
        const p = ev.payload.properties as { part?: { type?: string } };
        process.stdout.write(`\n  [part.updated:${p.part?.type ?? "?"}]`);
      }
      break;
    case "session.next.step.ended":
      counters.stepEnded++;
      // eslint-disable-next-line no-console
      console.log(`\n  [step.ended] 回合结束`);
      break;
    case "session.error":
      counters.error++;
      // eslint-disable-next-line no-console
      console.log(`\n  [session.error] ${JSON.stringify(ev.payload.properties)}`);
      break;
    default:
      counters.other++;
      break;
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cwd = process.cwd();
  // eslint-disable-next-line no-console
  console.log(`== 创建客户端 cwd=${cwd}`);
  const client = createClaudeClient({ cwd });

  try {
    // --- 0. 获取模型（可选，验证 model.list） ---
    // eslint-disable-next-line no-console
    console.log(`\n== model.list()`);
    const models = await client.model.list();
    // eslint-disable-next-line no-console
    console.log(`   location.directory=${models.location.directory}, 共 ${models.data.length} 个模型`);
    for (const m of models.data.slice(0, 5)) {
      // eslint-disable-next-line no-console
      console.log(`   - ${m.id}  (provider=${m.providerID}, name=${m.name}, status=${m.status})`);
    }

    // --- 1. 创建会话（firstMessage 路径：init 触发，捕获真实 session_id） ---
    // eslint-disable-next-line no-console
    console.log(`\n== session.create({ model: '${MODEL_ID}', firstMessage })`);
    const session = await client.session.create({
      model: { id: MODEL_ID, providerID: "anthropic" },
      firstMessage: FIRST_MESSAGE,
    });
    // eslint-disable-next-line no-console
    console.log(`   创建成功 session.id=${session.id}`);
    // eslint-disable-next-line no-console
    console.log(`   location.directory=${session.location.directory}`);

    // --- 2. 订阅事件流 + 流式输出（首回合） ---
    const counters = newCounters();
    // eslint-disable-next-line no-console
    console.log(`\n== 消费事件流（首回合：${FIRST_MESSAGE}）`);
    // eslint-disable-next-line no-console
    console.log(`   流式输出:`);

    const stream = client.session.events(session.id);
    let firstRoundDone = false;
    for await (const ev of stream) {
      tally(ev, counters);
      if (ev.payload.type === "session.next.step.ended" && !firstRoundDone) {
        firstRoundDone = true;
        // --- 3. 发送第二条消息（多轮对话） ---
        // eslint-disable-next-line no-console
        console.log(`\n== 发送第二条消息: ${SECOND_MESSAGE}`);
        await client.session.prompt(session.id, { prompt: { text: SECOND_MESSAGE } });
        // eslint-disable-next-line no-console
        console.log(`   流式输出（第二回合）:`);
      } else if (ev.payload.type === "session.next.step.ended" && firstRoundDone) {
        // 第二回合结束，退出事件消费
        break;
      }
    }

    // --- 4. 等待会话空闲（验证 wait） ---
    // eslint-disable-next-line no-console
    console.log(`\n== session.wait(session.id, { timeout: 120000 })`);
    await client.session.wait(session.id, { timeout: 120_000 });
    // eslint-disable-next-line no-console
    console.log(`   会话已空闲`);

    // --- 5. 读取消息历史（验证 messages） ---
    // eslint-disable-next-line no-console
    console.log(`\n== session.messages(session.id)`);
    const history = await client.session.messages(session.id);
    // eslint-disable-next-line no-console
    console.log(`   data=${history.data.length} 条消息`);
    for (const msg of history.data) {
      const body =
        "text" in msg && typeof msg.text === "string"
          ? msg.text.slice(0, 80)
          : "content" in msg && Array.isArray((msg as { content?: unknown }).content)
            ? JSON.stringify((msg as { content: unknown }).content).slice(0, 80)
            : JSON.stringify(msg).slice(0, 80);
      // eslint-disable-next-line no-console
      console.log(`   [${msg.type}] ${body}`);
    }

    // --- 6. 惰性回填路径：create() 无 firstMessage，首条 prompt 后回填真实 session_id ---
    // eslint-disable-next-line no-console
    console.log(`\n== 惰性回填：session.create({ model })（无 firstMessage）`);
    const placeholder = await client.session.create({ model: { id: MODEL_ID, providerID: "anthropic" } });
    // eslint-disable-next-line no-console
    console.log(`   占位 id=${placeholder.id}（应为 ses_ 前缀）`);
    // eslint-disable-next-line no-console
    console.log(`   发送首条消息（触发 init 回填）...`);
    const admitted = await client.session.prompt(placeholder.id, { prompt: { text: "一句话回答：3+3 等于几？" } });
    // eslint-disable-next-line no-console
    console.log(`   回填后 sessionID=${admitted.sessionID}（应为真实 session_id）`);
    // eslint-disable-next-line no-console
    console.log(`   SessionInputAdmitted.id=${admitted.id}（msg_ 前缀）、delivery=${admitted.delivery}`);
    await client.session.wait(admitted.sessionID, { timeout: 120_000 });

    // 惰性回填会话的消息历史（占位 id → 真实 id 归一化）
    const lazyHistory = await client.session.messages(placeholder.id);
    // eslint-disable-next-line no-console
    console.log(`   惰性会话 messages 读取成功：${lazyHistory.data.length} 条`);

    // --- 汇总 ---
    // eslint-disable-next-line no-console
    console.log(`\n== 结果汇总`);
    // eslint-disable-next-line no-console
    console.log(`   首会话事件计数: created=${counters.created}, delta=${counters.delta}, updated=${counters.updated}, stepEnded=${counters.stepEnded}, error=${counters.error}, other=${counters.other}`);

    // --- 断言 ---
    const failures: string[] = [];
    if (counters.created < 1) failures.push("未收到 session.created 事件");
    if (counters.delta < 1) failures.push("未收到 message.part.delta 流式增量");
    if (counters.updated < 1) failures.push("未收到 message.part.updated");
    if (counters.stepEnded < 2) failures.push(`回合结束事件数不足（期望 2，实际 ${counters.stepEnded}）`);
    if (counters.error > 0) failures.push(`收到 session.error 事件 ×${counters.error}`);
    if (!session.id || session.id.length === 0) failures.push("首会话 id 为空");
    // design.md D7：真实 session_id 保留 Claude 原始 UUID 格式（不做 ses- 前缀转换）。
    // 惰性回填成功 = 返回的真实 session_id 与占位 id 不同。
    if (admitted.sessionID === placeholder.id) {
      failures.push("惰性回填未返回真实 session_id（仍为占位 id）");
    }
    if (failures.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`\n❌ 集成测试失败:`);
      for (const f of failures) console.error(`   - ${f}`);
      process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.log(`\n✅ 集成测试全部通过（真实 Claude CLI 端到端）`);
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error("❌ 集成测试异常:", err);
  process.exit(1);
});
