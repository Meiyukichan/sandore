/**
 * 焦点/可见性恢复刷新 Hook。
 *
 * 用户切回 tab 或窗口获焦时立即调用回调；
 * 组件卸载时自动清理事件监听。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/use-focus-refresh
 */
import { useEffect } from 'react'

export function useFocusRefresh(onRefresh: () => void): void {
  useEffect(() => {
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') onRefresh()
    }
    const onFocus = (): void => { onRefresh() }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', onFocus)
    }
  }, [onRefresh])
}
