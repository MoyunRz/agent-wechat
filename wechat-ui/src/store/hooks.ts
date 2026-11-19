import { useCallback, useRef, useSyncExternalStore } from 'react'
import { store, type AppState } from './state'

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b))
    return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null)
    return false
  const aRecord = a as Record<string, unknown>
  const bRecord = b as Record<string, unknown>
  const aKeys = Object.keys(aRecord)
  if (aKeys.length !== Object.keys(bRecord).length)
    return false
  return aKeys.every(key => Object.is(aRecord[key], bRecord[key]))
}

/**
 * Subscribe to one value. The selector must return a stable reference for
 * unchanged state (a field, or a primitive); use `useShallow` when it builds a
 * new object or array.
 */
export function useStore<T>(selector: (state: AppState) => T): T {
  const selectorRef = useRef(selector)
  selectorRef.current = selector
  const getSnapshot = useCallback(() => selectorRef.current(store.getState()), [])
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}

/** Like `useStore`, but compares the selector result shallowly. */
export function useShallow<T>(selector: (state: AppState) => T): T {
  const selectorRef = useRef(selector)
  selectorRef.current = selector
  const cacheRef = useRef<{ value: T } | null>(null)
  const getSnapshot = useCallback(() => {
    const next = selectorRef.current(store.getState())
    const cached = cacheRef.current
    if (cached && shallowEqual(cached.value, next))
      return cached.value
    cacheRef.current = { value: next }
    return next
  }, [])
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}

/** The whole state object; re-renders on every change. Prefer the selectors. */
export function useAppState(): AppState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
