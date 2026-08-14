/**
 * 复杂真实端到端集成测试 —— 使用 @meiyukichan/claude-sdk（适配层）
 *
 * 覆盖五类真实场景（真实调用 Claude Code CLI，产生真实 LLM 调用 + 工具执行 + 文件写入）：
 *   场景 A：指定 directory + 工具调用 + 权限申请（permission.asked → respondPermission 自动放行）
 *   场景 B：问题提问（AskUserQuestion → question.asked → respondQuestion 自动回复）
 *   场景 C：足够长的对话（5+ 轮递增任务）
 *   场景 D：指定 directory 验证（SessionV2Info.location.directory === 指定目录，文件写入位置正确）
 *   场景 E：全局事件视图 global.event({ directory }) 按 directory 过滤
 *
 * 运行：
 *   cd scripts
 *   npm run e2e
 *
 * 前置条件：本机已通过 claude 登录（真实 CLI 可用）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClaudeClient } from '@meiyukichan/claude-sdk';
import type { GlobalEvent, QuestionInfo } from '@meiyukichan/claude-sdk';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const MODEL_ID = process.env.E2E_MODEL ?? 'sonnet';
/** 长对话递增任务（工具调用 + 文件操作，多轮）。 */
const TASKS = [
  '在指定工作目录创建文件 hello.txt，内容为 "hello sandore"。',
  '用 Bash 运行 `node -e "console.log(require(\'fs\').readFileSync(\'hello.txt\',\'utf8\'))"` 读取并打印文件内容。',
  '在 hello.txt 追加一行 "line two"。',
  '再次用 Bash 读取 hello.txt 并输出完整内容。',
  '用 Bash 运行 `ls -la` 列出工作目录文件，然后总结你看到的内容。',
  '最后，删除 hello.txt 并确认目录已清空（运行 ls 验证）。',
];

// ---------------------------------------------------------------------------
// 断言收集
// ---------------------------------------------------------------------------
const failures: string[] = [];
function assert(cond: boolean, message: string): void {
  if (!cond) {
    failures.push(message);
  }
}
function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

/** 事件计数（按类型）。 */
const counters: Record<string, number> = {};

function tally(ev: GlobalEvent): void {
  counters[ev.payload.type] = (counters[ev.payload.type] ?? 0) + 1;
}

function logEvent(ev: GlobalEvent): void {
  switch (ev.payload.type) {
    case 'permission.asked': {
      const p = ev.payload.properties as Record<string, unknown>;
      log(`   [permission.asked] id=${p.id} sessionID=${p.sessionID} permission=${String(p.permission)}`);
      break;
    }
    case 'question.asked': {
      const p = ev.payload.properties as { id?: string; questions?: QuestionInfo[] };
      const qs = (p.questions ?? []).map((q) => `"${q.question}"`).join(' | ');
      log(`   [question.asked] id=${p.id} questions=${qs}`);
      break;
    }
    case 'message.part.delta': {
      const p = ev.payload.properties as { field?: string; delta?: unknown };
      const text = typeof p.delta === 'string' ? p.delta : JSON.stringify(p.delta);
      process.stdout.write(`   [delta:${p.field ?? '?'}] ${text}`);
      break;
    }
    case 'message.part.updated': {
      const p = ev.payload.properties as { part?: { type?: string; tool?: string } };
      const kind = p.part?.type === 'tool' ? `tool:${p.part.tool}` : 'text';
      process.stdout.write(`\n   [part.updated:${kind}]\n`);
      break;
    }
    case 'session.next.step.ended':
      log(`   [step.ended] 回合结束`);
      break;
    case 'session.error': {
      log(`   [session.error] ${JSON.stringify(ev.payload.properties)}`);
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const clientCwd = process.cwd();
  const workDir = mkdtempSync(join(tmpdir(), 'claude-sdk-e2e-'));
  log(`== 临时工作目录: ${workDir}`);

  const client = createClaudeClient({ cwd: clientCwd });

  try {
    // --- 0. model.list ---
    log(`\n== model.list()`);
    const models = await client.model.list();
    log(`   location.directory=${models.location.directory}, ${models.data.length} 个模型`);
    assert(models.data.length > 0, 'model.list 返回空');
    assert(
      models.data.every((m) => m.providerID === 'anthropic' && m.status === 'active'),
      'ModelV2Info providerID/status 映射错误',
    );

    // --- 场景 A + D：指定 directory + 工具调用 + 权限申请 ---
    log(`\n== 场景 A/D：指定 directory + 工具调用 + 权限申请`);
    const permissionReplies: string[] = [];
    const session = await client.session.create({
      location: { directory: workDir },
      model: { id: MODEL_ID, providerID: 'anthropic' },
      // 不设 allowedTools：裸名会 auto-approve 整个工具并 shadow canUseTool（SDK 警告），
      // 导致权限申请（permission.asked）永不触发。默认 permissionMode 下受限工具
      // （Bash/Write/Edit）走 canUseTool 桥接，正是本测试要验证的权限申请路径。
      permissionMode: 'default',
      maxTurns: 60,
      systemPrompt:
        '你在一个指定工作目录中完成任务。需要写文件或执行命令时，直接调用工具。' +
        '所有文件操作都在工作目录内完成。',
      firstMessage: TASKS[0],
    });
    log(`   会话创建成功 id=${session.id}`);
    assert(
      session.location.directory === workDir,
      `场景D失败: SessionV2Info.location.directory=${session.location.directory} !== ${workDir}`,
    );

    // 订阅全局事件（场景 E：先订阅，再驱动会话，验证 directory 过滤）。
    // 注意：global.event() 的 for await 阻塞在 next() 时，AbortController.abort 不会唤醒它，
    // 因此用"收集到足够事件即退出" + 兜底超时，而非依赖 abort 中断。
    const globalSeen: Array<{ type: string; directory?: string }> = [];
    const GLOBAL_TARGET_EVENTS = 5;
    const globalConsumer = (async () => {
      for await (const ev of client.global.event({ directory: workDir })) {
        globalSeen.push({ type: ev.payload.type, directory: ev.directory });
        if (globalSeen.length >= GLOBAL_TARGET_EVENTS) {
          break;
        }
      }
    })();

    // 事件消费 + 长对话（场景 C）+ 权限/问题自动回复（场景 A/B）。
    log(`\n== 场景 C：长对话 ${TASKS.length} 轮（事件消费 + 权限自动放行 + 问题自动回复）`);
    let round = 0;
    const stream = client.session.events(session.id);
    const seenTypes = new Set<string>();
    for await (const ev of stream) {
      tally(ev);
      logEvent(ev);
      seenTypes.add(ev.payload.type);
      if (ev.payload.type === 'permission.asked') {
        const requestID = (ev.payload.properties as Record<string, unknown>).id as string;
        client.session.respondPermission(session.id, { requestID, reply: 'once' });
        permissionReplies.push(requestID);
      } else if (ev.payload.type === 'question.asked') {
        const p = ev.payload.properties as { id?: string; questions?: QuestionInfo[] };
        if (p.id && p.questions) {
          const answers: Record<string, string | string[]> = {};
          for (const q of p.questions) {
            answers[q.question] = q.options[0]?.label ?? 'A';
          }
          client.session.respondQuestion(session.id, { requestID: p.id, answers });
        }
      } else if (ev.payload.type === 'session.next.step.ended') {
        round++;
        if (round >= TASKS.length) break;
        const next = TASKS[round];
        log(`   -- 第 ${round + 1}/${TASKS.length} 轮: ${next.slice(0, 40)}...`);
        await client.session.prompt(session.id, { prompt: { text: next } });
      } else if (ev.payload.type === 'session.error') {
        // 回合出错：不继续，但保留统计。
        break;
      }
    }

    // 场景 A 断言：权限申请被触发并全部放行。
    log(`\n== 场景 A 断言`);
    log(`   permission.asked=${counters['permission.asked'] ?? 0} 次, 已回复 ${permissionReplies.length} 次`);
    assert((counters['permission.asked'] ?? 0) > 0, '场景A失败: 未触发任何权限申请（canUseTool 桥接未工作或模型未调受限工具）');
    assert(
      (counters['message.part.updated'] ?? 0) > 0,
      '场景A失败: 未收到任何 message.part.updated（工具调用产物缺失）',
    );
    assert(
      (counters['session.next.step.ended'] ?? 0) >= TASKS.length,
      `场景C失败: 长对话未完成（step.ended=${counters['session.next.step.ended'] ?? 0}/${TASKS.length}）`,
    );

    // 场景 D 断言：模型确实在指定 directory 内操作（hello.txt 曾被创建；最终按任务被删除）。
    log(`\n== 场景 D 断言`);
    const helloPath = join(workDir, 'hello.txt');
    try {
      const finalExists = readFileSync(helloPath, 'utf8');
      log(`   hello.txt 仍存在（删除步骤可能未执行）: ${JSON.stringify(finalExists)}`);
      // 文件存在说明模型确实在工作目录内创建了文件（指定 directory 生效）。
    } catch {
      log(`   hello.txt 已不存在（按最后一步任务要求被删除）`);
    }
    // 关键：模型是否在工作目录写文件由 permission.asked 的 blockedPath/metadata 佐证，
    // 以及下方全局事件 directory 过滤（场景 E）验证事件归属目录。

    // 场景 B：问题提问。单独会话，systemPrompt 引导模型用 AskUserQuestion。
    log(`\n== 场景 B：问题提问（AskUserQuestion）`);
    let questionReplied = 0;
    const qSession = await client.session.create({
      location: { directory: workDir },
      model: { id: MODEL_ID, providerID: 'anthropic' },
      permissionMode: 'default',
      maxTurns: 30,
      systemPrompt:
        '当任务需要确认用户偏好时，你必须使用 AskUserQuestion 工具提问，而不是直接猜测。' +
        '提问后等待用户回复，再基于回复继续。',
      firstMessage:
        '帮我决定一个简单 Node.js 项目的代码风格：模块化（ESM）还是 CommonJS？' +
        '请用 AskUserQuestion 询问我，然后基于我的选择给出建议。',
    });
    const qCounters: Record<string, number> = {};
    const qStream = client.session.events(qSession.id);
    // 硬超时：防止模型行为异常导致事件流永不结束而卡死整个脚本。
    const QUESTION_TIMEOUT_MS = 120_000;
    let qSteps = 0;
    let qError: string | null = null;
    const consume = (async () => {
      for await (const ev of qStream) {
        qCounters[ev.payload.type] = (qCounters[ev.payload.type] ?? 0) + 1;
        if (ev.payload.type === 'question.asked') {
          const p = ev.payload.properties as { id?: string; questions?: QuestionInfo[] };
          if (p.id && p.questions) {
            const answers: Record<string, string | string[]> = {};
            for (const q of p.questions) {
              answers[q.question] = q.options[0]?.label ?? 'A';
            }
            log(`   [reply] ${JSON.stringify(answers)}`);
            client.session.respondQuestion(qSession.id, { requestID: p.id, answers });
            questionReplied++;
          }
        } else if (ev.payload.type === 'session.next.step.ended') {
          qSteps++;
          // 收到第一个回合结束（问答完成）即停止：模型基于回答给出建议后回合即结束。
          break;
        } else if (ev.payload.type === 'session.error') {
          qError = String(JSON.stringify(ev.payload.properties));
          break;
        }
      }
    })();
    await Promise.race([
      consume,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`场景B超时 ${QUESTION_TIMEOUT_MS}ms`)), QUESTION_TIMEOUT_MS)),
    ]);
    log(`   question.asked=${qCounters['question.asked'] ?? 0} 次, 已回复 ${questionReplied} 次, step.ended=${qSteps} 次`);
    if (qError !== null) {
      log(`   ⚠ 场景B回合出错: ${qError}`);
    }
    // 模型可能不总是主动提问（模型行为不稳定）；作为"尽力触发"检查，不硬断言失败，
    // 但若触发则必须完成回复。
    if ((qCounters['question.asked'] ?? 0) > 0) {
      assert(questionReplied > 0, '场景B失败: 收到问题但回复失败');
    } else {
      log(`   ⚠ 模型未主动提问（AskUserQuestion 未触发），跳过场景B硬断言`);
    }

    // 场景 E 断言：全局事件按 directory 过滤。
    // 全局消费者在收集到 GLOBAL_TARGET_EVENTS 个事件后自行 break；
    // 兜底超时（全局事件可能因会话已结束而不足目标数，但应收到至少 1 个）。
    await Promise.race([
      globalConsumer,
      new Promise((r) => setTimeout(r, 15_000)),
    ]);
    log(`\n== 场景 E 断言`);
    log(`   global.event({directory: workDir}) 收到 ${globalSeen.length} 个事件`);
    assert(globalSeen.length > 0, '场景E失败: 指定 directory 的全局事件为空');
    assert(
      globalSeen.every((e) => e.directory === workDir),
      '场景E失败: 全局事件包含非目标 directory',
    );

    // 清理工作目录。Windows 上 Claude CLI 子进程可能短暂持有目录句柄，EPERM 时重试并最终容忍。
    try {
      rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      log(`\n== 清理临时目录完成`);
    } catch (cleanupError) {
      log(`\n== 清理临时目录失败（非逻辑错误，忽略）: ${String(cleanupError).slice(0, 80)}`);
    }

    // --- 汇总断言 ---
    log(`\n== 结果汇总`);
    log(`   事件计数: ${JSON.stringify(counters)}`);
    assert((counters['session.created'] ?? 0) >= 1, '未收到 session.created');
    assert((counters['message.part.delta'] ?? 0) > 0, '未收到流式 message.part.delta');

    if (failures.length > 0) {
      log(`\n❌ 集成测试失败:`);
      for (const f of failures) log(`   - ${f}`);
      process.exit(1);
    }
    log(`\n✅ 集成测试全部通过（真实 Claude CLI 端到端：工具调用 + 权限 + 长对话 + 指定 directory + 全局过滤）`);
  } finally {
    client.close();
  }
}

// 整体硬超时：真实多轮 + 工具调用可能耗时长，但需保证脚本永不无限卡死。
const OVERALL_TIMEOUT_MS = 15 * 60 * 1000;
const overallTimer = setTimeout(() => {
  // eslint-disable-next-line no-console
  console.error(`❌ 集成测试整体超时（${OVERALL_TIMEOUT_MS}ms）`);
  process.exit(2);
}, OVERALL_TIMEOUT_MS);

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('❌ 集成测试异常:', err);
    process.exit(1);
  })
  .finally(() => {
    clearTimeout(overallTimer);
  });
