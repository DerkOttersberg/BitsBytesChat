import type Store from "electron-store"

// Mutations stay synchronous. Empty scoped files are reclaimed at startup,
// when no live read handles or later writes can race their removal.
export function createStoreHandlers(getStore: (name: string) => Store) {
  return {
    get(name: string, key: string) {
      try {
        const value = getStore(name).get(key)
        if (value === undefined || value === null) return null
        return typeof value === "string" ? value : JSON.stringify(value)
      } catch {
        return null
      }
    },
    set(name: string, key: string, value: string) {
      getStore(name).set(key, value)
    },
    delete(name: string, key: string) {
      getStore(name).delete(key)
    },
    clear(name: string) {
      getStore(name).clear()
    },
    keys(name: string) {
      return Object.keys(getStore(name).store)
    },
    length(name: string) {
      return Object.keys(getStore(name).store).length
    },
  }
}
