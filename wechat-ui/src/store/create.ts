// Minimal external store. Components subscribe with `useStore` from ./hooks;
// actions mutate through `setState`. No state library is involved.

export type StatePatch<S> = Partial<S> | ((state: S) => Partial<S>)

export interface ExternalStore<S extends object> {
  getState: () => S
  setState: (patch: StatePatch<S>) => void
  subscribe: (listener: () => void) => () => void
}

export function createStore<S extends object>(initial: S): ExternalStore<S> {
  let state = initial
  const listeners = new Set<() => void>()

  return {
    getState: () => state,
    setState(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch
      if (Object.keys(next).length === 0)
        return
      state = { ...state, ...next }
      for (const listener of listeners)
        listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
