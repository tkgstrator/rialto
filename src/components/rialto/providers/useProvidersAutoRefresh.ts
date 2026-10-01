import { useEffect, useRef, useState } from 'react'
import dayjs from '@/lib/dayjs'

const REFRESH_INTERVAL_MS = 30_000

/** Poll stored data only; upstream refresh/scraping remains an explicit action. */
export function useProvidersAutoRefresh({
  enabled,
  paused,
  refresh,
  cancel
}: {
  enabled: boolean
  paused: boolean
  refresh: () => Promise<void>
  cancel: () => void
}) {
  const [now, setNow] = useState(() => dayjs().valueOf())
  const running = useRef(false)

  useEffect(() => {
    if (!enabled) return
    const tick = () => {
      if (document.visibilityState === 'hidden') return
      // Countdown keeps moving during Edit, without replacing its draft.
      setNow(dayjs().valueOf())
      if (paused || running.current) return
      running.current = true
      void refresh().finally(() => {
        running.current = false
      })
    }
    const timer = setInterval(tick, REFRESH_INTERVAL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
      cancel()
    }
  }, [enabled, paused, refresh, cancel])

  return now
}
