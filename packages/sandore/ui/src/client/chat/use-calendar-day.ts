/**
 * use-calendar-day：抄自 DSH `packages/client/ui-conversation/src/client/chat/use-calendar-day.ts`。
 * 组件本地日历日 tick：memoized 消息行跨午夜保持稳定 props，IconActions 时钟需要
 * 一个本地日座，在下一个本地午夜重新触发而不触及框架 hooks。逐字保留。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/chat/use-calendar-day
 */
import { useEffect, useState } from 'react'
import { msUntilNextLocalMidnight, startOfLocalDay } from './message-chrome.ts'

/**
 * Local calendar-day epoch that advances at each local midnight.
 * @returns Midnight ms for the current local day; updates after the boundary.
 */
export function useCalendarDay(): number {
  const [day, setDay] = useState(() => startOfLocalDay(Date.now()))
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const arm = (): void => {
      const now = Date.now()
      setDay(startOfLocalDay(now))
      timer = setTimeout(arm, msUntilNextLocalMidnight(now))
    }
    timer = setTimeout(arm, msUntilNextLocalMidnight(Date.now()))
    return () => { clearTimeout(timer) }
  }, [])
  return day
}
