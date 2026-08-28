/**
 * 内存 mock userQuestions（测试专用，非发布面）。
 *
 * 提供 `ask` 等价语义：记录每次调用，支持「可编程 handler」与「答案队列」两种
 * 回复注入；无 handler 且队列空时挂起（等待引擎 `replyQuestion` 兼容路径或测试
 * 手动 resolve）。以 `ctx.provide('userQuestions', …)` 注入。
 * @module dsh-sandore/workflow/tests/mocks/user-questions
 */
import type { AskUserQuestionAnswer } from '../../workflow/types.ts';
import type { UserQuestions, UserQuestionsRequest } from '../../workflow/seam.ts';

/** 内存 mock userQuestions：记录调用并支持可编程回复。 */
export class FakeUserQuestions implements UserQuestions {
  /** 每次 `ask` 调用的入参记录。 */
  readonly calls: UserQuestionsRequest[] = [];
  /** 待回复答案队列（`ask` 依次弹出）。 */
  readonly answers: AskUserQuestionAnswer[] = [];
  /** 可编程回复 handler（优先级高于答案队列）。 */
  resolveNext?: (request: UserQuestionsRequest) => Promise<AskUserQuestionAnswer>;

  ask(request: UserQuestionsRequest): Promise<AskUserQuestionAnswer> {
    this.calls.push(request);
    if (this.resolveNext !== undefined) {
      return this.resolveNext(request);
    }
    const answer = this.answers.shift();
    if (answer !== undefined) {
      return Promise.resolve(answer);
    }
    // 无编程回复：挂起（永不 resolve），由兼容路径或测试手动驱动。
    return new Promise<AskUserQuestionAnswer>(() => {});
  }
}
