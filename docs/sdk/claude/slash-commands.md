> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# SDK 中的 slash commands

> 学习如何通过 SDK 使用 slash commands 来控制 Claude Code 会话

Slash commands 提供了一种方式来控制 Claude Code 会话，使用以 `/` 开头的特殊命令。这些命令可以通过 SDK 发送，以执行诸如压缩上下文、列出上下文使用情况或调用自定义命令等操作。只有在不需要交互式终端的情况下工作的命令才能通过 SDK 分派；`system/init` 消息列出了在您的会话中可用的命令。

<h2 id="discovering-available-slash-commands">
  发现可用的 Slash Commands
</h2>

Claude Agent SDK 在系统初始化消息中提供有关可用 slash commands 的信息。在您的会话开始时访问此信息：

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  for await (const message of query({
    prompt: "Hello Claude",
    options: { maxTurns: 1 }
  })) {
    if (message.type === "system" && message.subtype === "init") {
      console.log("Available slash commands:", message.slash_commands);
      // 包括内置命令加上捆绑的 skills，例如：
      // ["clear", "compact", "context", "usage", "code-review", "verify", ...]
    }
  }
  ```

  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions, SystemMessage


  async def main():
      async for message in query(prompt="Hello Claude", options=ClaudeAgentOptions(max_turns=1)):
          if isinstance(message, SystemMessage) and message.subtype == "init":
              print("Available slash commands:", message.data["slash_commands"])
              # 包括内置命令加上捆绑的 skills，例如：
              # ["clear", "compact", "context", "usage", "code-review", "verify", ...]


  asyncio.run(main())
  ```
</CodeGroup>

<h2 id="sending-slash-commands">
  发送 Slash Commands
</h2>

通过在您的提示字符串中包含 slash commands 来发送它们，就像常规文本一样。作用于对话历史的命令，例如 `/compact`，需要先前的消息来处理，因此下面的示例首先提出一个问题，然后将命令作为后续发送到同一对话：

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  // Build up conversation history first
  try {
    for await (const message of query({
      prompt: "What does the README in this directory cover?",
      options: { maxTurns: 2 }
    })) {
      if (message.type === "result" && message.subtype === "success") {
        console.log(message.result);
      }
    }
  } catch (error) {
    // A single-shot query() throws after yielding an error result,
    // so the follow-up query below still runs.
    console.error(`Session ended with an error: ${error}`);
  }

  // Send a slash command as a follow-up to the same conversation
  for await (const message of query({
    prompt: "/compact",
    options: { continue: true, maxTurns: 1 }
  })) {
    if (message.type === "result") {
      console.log("Command executed, result subtype:", message.subtype);
      // Example output: Command executed, result subtype: success
    }
  }
  ```

  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions, ResultMessage


  async def main():
      # Build up conversation history first
      try:
          async for message in query(
              prompt="What does the README in this directory cover?",
              options=ClaudeAgentOptions(max_turns=2),
          ):
              if isinstance(message, ResultMessage) and message.subtype == "success":
                  print(message.result)
      except Exception as error:
          # A single-shot query() raises after yielding an error result,
          # so the follow-up query below still runs.
          print(f"Session ended with an error: {error}")

      # Send a slash command as a follow-up to the same conversation
      async for message in query(
          prompt="/compact",
          options=ClaudeAgentOptions(continue_conversation=True, max_turns=1),
      ):
          if isinstance(message, ResultMessage):
              print("Command executed, result subtype:", message.subtype)
              # Example output: Command executed, result subtype: success


  asyncio.run(main())
  ```
</CodeGroup>

<Note>
  查询可能以错误结果结束，例如当 `maxTurns` / `max_turns` 限制在工作完成前被达到时。最终结果消息随后具有 `is_error: true` 和错误子类型（例如 `error_max_turns`）而不是 `success`。

  在产生该最终结果消息后，SDK 会抛出错误，因为 CLI 进程以非零代码退出。

  如果您的命令可能达到限制，请在 TypeScript 中将循环包装在 `try`/`catch` 中或在 Python 中使用 `try`/`except`，如 [Single Message Input](/docs/zh-CN/agent-sdk/streaming-vs-single-mode#single-message-input) 中所示，或设置 `maxTurns` 足够高以完成工作。在 Python 中，捕获 `Exception`：SDK 将错误结果作为普通 `Exception` 呈现。
</Note>

<h2 id="common-slash-commands">
  常见的 Slash Commands
</h2>

<h3 id="/compact-compact-conversation-history">
  `/compact` - 压缩对话历史
</h3>

`/compact` 命令通过总结较早的消息同时保留重要上下文来减少您的对话历史的大小。压缩需要至少有两次先前交互的现有对话来进行总结。此示例首先进行对话，然后压缩它并读取报告结果的 `compact_boundary` 系统消息：

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  // Compaction needs existing history, so have a conversation first
  try {
    for await (const message of query({
      prompt: "Explain what this project does",
      options: { maxTurns: 2 }
    })) {
      if (message.type === "result" && message.subtype === "success") {
        console.log(message.result);
      }
    }
  } catch (error) {
    // A single-shot query() throws after yielding an error result,
    // so the follow-up query below still runs.
    console.error(`Session ended with an error: ${error}`);
  }

  // Compact the same conversation
  for await (const message of query({
    prompt: "/compact",
    options: { continue: true, maxTurns: 1 }
  })) {
    if (message.type === "system" && message.subtype === "compact_boundary") {
      console.log("Compaction completed");
      console.log("Pre-compaction tokens:", message.compact_metadata.pre_tokens);
      console.log("Trigger:", message.compact_metadata.trigger);
      // Example output:
      // Compaction completed
      // Pre-compaction tokens: 1842
      // Trigger: manual
    }
  }
  ```

  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions, ResultMessage, SystemMessage


  async def main():
      # Compaction needs existing history, so have a conversation first
      try:
          async for message in query(
              prompt="Explain what this project does",
              options=ClaudeAgentOptions(max_turns=2),
          ):
              if isinstance(message, ResultMessage) and message.subtype == "success":
                  print(message.result)
      except Exception as error:
          # A single-shot query() raises after yielding an error result,
          # so the follow-up query below still runs.
          print(f"Session ended with an error: {error}")

      # Compact the same conversation
      async for message in query(
          prompt="/compact",
          options=ClaudeAgentOptions(continue_conversation=True, max_turns=1),
      ):
          if isinstance(message, SystemMessage) and message.subtype == "compact_boundary":
              print("Compaction completed")
              print("Pre-compaction tokens:", message.data["compact_metadata"]["pre_tokens"])
              print("Trigger:", message.data["compact_metadata"]["trigger"])
              # Example output:
              # Compaction completed
              # Pre-compaction tokens: 1842
              # Trigger: manual


  asyncio.run(main())
  ```
</CodeGroup>

<Note>
  `compact_boundary` 消息仅在压缩运行时到达。如果没有要总结的内容，`/compact` 会报告原因而不是抛出异常：运行仍然以 `success` 结果结束，不会发出 `compact_boundary` 消息，结果文本会携带消息，例如在单次简短交互后显示 `Not enough messages to compact.`。全新的一次性 `query()` 调用以空上下文开始，因此请在具有先前轮次的会话中使用此模式，例如在[流式输入模式](/docs/zh-CN/agent-sdk/streaming-vs-single-mode)中或恢复会话时。
</Note>

<h3 id="/clear-reset-conversation-context">
  `/clear` - 重置对话上下文
</h3>

`/clear` 命令将对话重置为空上下文，因此后续提示将从没有先前对话历史的状态开始。之前的对话保留在磁盘上，可以通过将其会话 ID 传递给 [`resume` 选项](/docs/zh-CN/agent-sdk/sessions#resume-by-id) 来返回。

这在[流式输入模式](/docs/zh-CN/agent-sdk/streaming-vs-single-mode)中很有用，在该模式下您通过单个连接发送多个提示。对于一次性 `query()` 调用，每个调用已经以空上下文开始，因此发送 `/clear` 没有实际效果；请改为启动一个新的 `query()`。

<Note>
  SDK 中的 `/clear` 需要 Claude Code v2.1.117 或更高版本。在早期版本中，它从 `slash_commands` 中被省略。
</Note>

<h2 id="creating-custom-slash-commands">
  创建自定义 Slash Commands
</h2>

除了使用内置 slash commands 外，您还可以创建自己的自定义命令，这些命令可通过 SDK 使用。自定义命令定义为特定目录中的 markdown 文件，类似于 subagents 的配置方式。

<Note>
  `.claude/commands/` 目录是旧版格式。推荐的格式是 `.claude/skills/<name>/SKILL.md`，它支持相同的 slash command 调用（`/name`）加上 Claude 的自主调用。有关当前格式，请参阅 [Skills](/docs/zh-CN/agent-sdk/skills)。CLI 继续支持两种格式，下面的示例对于 `.claude/commands/` 仍然准确。
</Note>

<h3 id="file-locations">
  文件位置
</h3>

自定义 slash commands 根据其范围存储在指定的目录中：

* **项目命令**：`.claude/commands/` - 仅在当前项目中可用（旧版；优先使用 `.claude/skills/`）
* **个人命令**：`~/.claude/commands/` - 在您的所有项目中可用（旧版；优先使用 `~/.claude/skills/`）

<h3 id="file-format">
  文件格式
</h3>

每个自定义命令都是一个 markdown 文件，其中：

* 文件名（不带 `.md` 扩展名）成为命令名称
* 文件内容定义命令的功能
* 可选的 YAML frontmatter 提供配置

<h4 id="basic-example">
  基本示例
</h4>

在您的项目中创建 `.claude/commands` 目录（如果不存在），然后创建 `.claude/commands/refactor.md`：

```markdown theme={null}
Refactor the selected code to improve readability and maintainability.
Focus on clean code principles and best practices.
```

这创建了 `/refactor` 命令，您可以通过 SDK 使用它。

<h4 id="with-frontmatter">
  带有 Frontmatter
</h4>

创建 `.claude/commands/security-check.md`：

```markdown theme={null}
---
allowed-tools: Read, Grep, Glob
description: Run security vulnerability scan
model: claude-opus-4-8
---

Analyze the codebase for security vulnerabilities including:
- SQL injection risks
- XSS vulnerabilities
- Exposed credentials
- Insecure configurations
```

<h3 id="using-custom-commands-in-the-sdk">
  在 SDK 中使用自定义命令
</h3>

一旦在文件系统中定义，自定义命令就会自动通过 SDK 可用：

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  // Use a custom command
  try {
    for await (const message of query({
      prompt: "/refactor src/auth/login.ts",
      options: { maxTurns: 3 }
    })) {
      if (message.type === "assistant") {
        console.log("Refactoring suggestions:", message.message);
      }
    }
  } catch (error) {
    // A single-shot query() throws after yielding an error result,
    // so the second query below still runs.
    console.error(`Session ended with an error: ${error}`);
  }

  // Custom commands appear in the slash_commands list
  for await (const message of query({
    prompt: "Hello",
    options: { maxTurns: 1 }
  })) {
    if (message.type === "system" && message.subtype === "init") {
      console.log("Available commands:", message.slash_commands);
      // Includes built-in commands plus bundled skills and your custom commands, for example:
      // ["clear", "compact", "context", "usage", "code-review", "verify", "refactor", "security-check", ...]
    }
  }
  ```

  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions, AssistantMessage, SystemMessage


  async def main():
      # Use a custom command
      try:
          async for message in query(
              prompt="/refactor src/auth/login.py", options=ClaudeAgentOptions(max_turns=3)
          ):
              if isinstance(message, AssistantMessage):
                  for block in message.content:
                      if hasattr(block, "text"):
                          print("Refactoring suggestions:", block.text)
      except Exception as error:
          # A single-shot query() raises after yielding an error result,
          # so the second query below still runs.
          print(f"Session ended with an error: {error}")

      # Custom commands appear in the slash_commands list
      async for message in query(prompt="Hello", options=ClaudeAgentOptions(max_turns=1)):
          if isinstance(message, SystemMessage) and message.subtype == "init":
              print("Available commands:", message.data["slash_commands"])
              # Includes built-in commands plus bundled skills and your custom commands, for example:
              # ["clear", "compact", "context", "usage", "code-review", "verify", "refactor", "security-check", ...]


  asyncio.run(main())
  ```
</CodeGroup>

<h3 id="advanced-features">
  高级功能
</h3>

<h4 id="arguments-and-placeholders">
  参数和占位符
</h4>

自定义命令支持使用占位符的动态参数：

创建 `.claude/commands/fix-issue.md`：

```markdown theme={null}
---
argument-hint: [issue-number] [priority]
description: Fix a GitHub issue
---

Fix issue #$0 with priority $1.
Check the issue description and implement the necessary changes.
```

在 SDK 中使用：

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  // Pass arguments to custom command
  for await (const message of query({
    prompt: "/fix-issue 123 high",
    options: { maxTurns: 5 }
  })) {
    // Command will process with $0="123" and $1="high"
    if (message.type === "result" && message.subtype === "success") {
      console.log("Issue fixed:", message.result);
    }
  }
  ```

  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions, ResultMessage


  async def main():
      # Pass arguments to custom command
      async for message in query(prompt="/fix-issue 123 high", options=ClaudeAgentOptions(max_turns=5)):
          # Command will process with $0="123" and $1="high"
          if isinstance(message, ResultMessage):
              print("Issue fixed:", message.result)


  asyncio.run(main())
  ```
</CodeGroup>

<h4 id="bash-command-execution">
  Bash 命令执行
</h4>

自定义命令可以执行 bash 命令并包含其输出：

创建 `.claude/commands/git-commit.md`：

```markdown theme={null}
---
allowed-tools: Bash(git add *), Bash(git status *), Bash(git commit *)
description: Create a git commit
---

## Context

- Current status: !`git status`
- Current diff: !`git diff HEAD`

## Task

Create a git commit with appropriate message based on the changes.
```

<h4 id="file-references">
  文件引用
</h4>

使用 `@` 前缀包含文件内容：

创建 `.claude/commands/review-config.md`：

```markdown theme={null}
---
description: Review configuration files
---

Review the following configuration files for issues:
- Package config: @package.json
- TypeScript config: @tsconfig.json
- Environment config: @.env

Check for security issues, outdated dependencies, and misconfigurations.
```

<h3 id="organization-with-namespacing">
  使用命名空间进行组织
</h3>

在子目录中组织命令以获得更好的结构：

```bash theme={null}
.claude/commands/
├── frontend/
│   ├── component.md      # Creates /component (project:frontend)
│   └── style-check.md     # Creates /style-check (project:frontend)
├── backend/
│   ├── api-test.md        # Creates /api-test (project:backend)
│   └── db-migrate.md      # Creates /db-migrate (project:backend)
└── review.md              # Creates /review (project)
```

子目录出现在命令描述中，但不影响命令名称本身。

<h3 id="practical-examples">
  实际示例
</h3>

<h4 id="pull-request-review-command">
  Pull Request 审查命令
</h4>

创建 `.claude/commands/review-pr.md`：

```markdown theme={null}
---
allowed-tools: Read, Grep, Glob, Bash(git diff *)
description: Comprehensive code review
---

## Changed Files
!`git diff --name-only HEAD~1`

## Detailed Changes
!`git diff HEAD~1`

## Review Checklist

Review the above changes for:
1. Code quality and readability
2. Security vulnerabilities
3. Performance implications
4. Test coverage
5. Documentation completeness

Provide specific, actionable feedback organized by priority.
```

<Note>
  Claude Code 包含捆绑的 `code-review` 和 `verify` skills。如果您以其中之一的名称命名自定义命令，例如 `.claude/commands/code-review.md`，您的命令会覆盖捆绑的 skill，`slash_commands` 列表中该名称仅出现一次。
</Note>

<h4 id="test-runner-command">
  测试运行器命令
</h4>

创建 `.claude/commands/test.md`：

```markdown theme={null}
---
allowed-tools: Bash, Read, Edit
argument-hint: [test-pattern]
description: Run tests with optional pattern
---

Run tests matching pattern: $ARGUMENTS

1. Detect the test framework (Jest, pytest, etc.)
2. Run tests with the provided pattern
3. If tests fail, analyze and fix them
4. Re-run to verify fixes
```

通过 SDK 使用这些命令：

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  // Run code review
  try {
    for await (const message of query({
      prompt: "/review-pr",
      options: { maxTurns: 3 }
    })) {
      // Process review feedback
    }
  } catch (error) {
    // A single-shot query() throws after yielding an error result,
    // so the second query below still runs.
    console.error(`Session ended with an error: ${error}`);
  }

  // Run specific tests
  for await (const message of query({
    prompt: "/test auth",
    options: { maxTurns: 5 }
  })) {
    // Handle test results
  }
  ```

  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions


  async def main():
      # Run code review
      try:
          async for message in query(prompt="/review-pr", options=ClaudeAgentOptions(max_turns=3)):
              # Process review feedback
              pass
      except Exception as error:
          # A single-shot query() raises after yielding an error result,
          # so the second query below still runs.
          print(f"Session ended with an error: {error}")

      # Run specific tests
      async for message in query(prompt="/test auth", options=ClaudeAgentOptions(max_turns=5)):
          # Handle test results
          pass


  asyncio.run(main())
  ```
</CodeGroup>

<h2 id="see-also">
  另请参阅
</h2>

* [Slash Commands](/docs/zh-CN/skills) - 完整的 slash command 文档
* [SDK 中的 Subagents](/docs/zh-CN/agent-sdk/subagents) - 类似的基于文件系统的 subagents 配置
* [TypeScript SDK 参考](/docs/zh-CN/agent-sdk/typescript) - 完整的 API 文档
* [SDK 概述](/docs/zh-CN/agent-sdk/overview) - 一般 SDK 概念
* [CLI 参考](/docs/zh-CN/cli-reference) - 命令行界面