import { useCallback, useEffect, useState } from 'react'

function read<T>(key: string, initial: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw !== null ? (JSON.parse(raw) as T) : initial
  } catch {
    return initial
  }
}

/**
 * localStorage-backed state. Unlike a plain `useState` initializer (which runs
 * only on mount), this re-reads storage whenever `key` changes — callers key
 * per mode (e.g. `questBoard.collapsed.${groupBy}`), and switching modes must
 * load that mode's saved value, never persist the previous mode's value under
 * the new key.
 *
 * The key and its value are held together in one state entry so they always
 * move as a pair: when the `key` prop changes, we synchronously derive fresh
 * state from the new key during render (React's "adjust state on prop change"
 * pattern), so the write effect below only ever fires with a value that belongs
 * to the current key.
 */
export function usePersistedState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [entry, setEntry] = useState<{ key: string; value: T }>(() => ({
    key,
    value: read(key, initial)
  }))

  if (entry.key !== key) {
    setEntry({ key, value: read(key, initial) })
  }

  useEffect(() => {
    // entry.key === key always holds here thanks to the render-time sync above.
    try {
      localStorage.setItem(entry.key, JSON.stringify(entry.value))
    } catch {
      // ignore storage errors (e.g. quota, private mode)
    }
  }, [entry])

  const setValue = useCallback((value: T) => {
    setEntry((prev) => ({ key: prev.key, value }))
  }, [])

  return [entry.value, setValue]
}
