/**
 * One page of something a session owns — its routing trace, its
 * conversation — fetched by offset.
 *
 * Both tabs of the session screen page the same way and need the same
 * guard: a late answer for the page the reader just left must not replace
 * the one they turned to. The rows on screen stay put until the next page
 * arrives, so turning a page does not flash a loading state.
 *
 * The caller remounts this per session (a `key`), which is what resets the
 * page to the newest one when the header walks to another session.
 */
import { useEffect, useState } from 'react'

export function useSessionPage<T>(fetchPage: (offset: number) => Promise<T>, pageSize: number) {
  const [pageIndex, setPageIndex] = useState(0)
  const [page, setPage] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const request = { stale: false }
    fetchPage(pageIndex * pageSize)
      .then((res) => {
        if (request.stale) return
        setPage(res)
        setError(null)
      })
      .catch((e: Error) => {
        if (!request.stale) setError(e.message)
      })
    return () => {
      request.stale = true
    }
  }, [fetchPage, pageIndex, pageSize])

  return { pageIndex, setPageIndex, page, error }
}
