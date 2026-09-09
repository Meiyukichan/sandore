/**
 * `session-events.ts` 的单元测试：事件日志版本适配读取（数组直通 / snapshotEvents
 * 回退 / 空兜底），锁定「迭代永远拿到数组」契约。
 * @module @meiyukichan/dsh-sandore/microflow/src/session-events.spec
 */
import { describe, expect, it } from 'vitest';

import { sessionEventList } from './session-events.ts';

describe('sessionEventList', () => {
  it('passes the legacy events array through untouched', () => {
    const events = [{ seq: 0 }, { seq: 1 }];
    expect(sessionEventList({ events })).toBe(events);
  });

  it('falls back to snapshotEvents() when the direct array is absent (rc.1+)', () => {
    const snapshot = [{ seq: 0 }];
    const session = { snapshotEvents: () => snapshot };
    expect(sessionEventList(session)).toBe(snapshot);
  });

  it('prefers the direct array over snapshotEvents when both exist', () => {
    const direct = [{ seq: 0 }];
    const session = { events: direct, snapshotEvents: () => [{ seq: 99 }] };
    expect(sessionEventList(session)).toBe(direct);
  });

  it('returns [] for absent/undefined sessions, non-array events and non-array snapshots', () => {
    expect(sessionEventList(undefined)).toEqual([]);
    expect(sessionEventList(null)).toEqual([]);
    expect(sessionEventList({})).toEqual([]);
    // 旧直读被删后 events 访问可能返回 undefined；snapshotEvents 防御非数组。
    expect(sessionEventList({ events: undefined })).toEqual([]);
    expect(sessionEventList({ snapshotEvents: () => undefined })).toEqual([]);
    expect(sessionEventList({ snapshotEvents: () => ({ not: 'an array' }) })).toEqual([]);
    expect(sessionEventList(42 as never)).toEqual([]);
  });
});
