import type { VenvInfo } from '$lib/stores'

// Cross-session cache of discovered venv-per-file results. Mtime of the venv's
// owning directory is stored so we can invalidate when the .venv is removed.
export const VENV_CACHE_KEY = 'canopy:venv_cache_v3'

export interface VenvCacheEntry { mtime: number; venv: VenvInfo | null }

export function loadVenvCache(): Record<string, VenvCacheEntry> {
  try { return JSON.parse(localStorage.getItem(VENV_CACHE_KEY) ?? '{}') } catch { return {} }
}

export function saveVenvCache(cache: Record<string, VenvCacheEntry>) {
  try { localStorage.setItem(VENV_CACHE_KEY, JSON.stringify(cache)) } catch {}
}

export function findClosestVenv(filePath: string, venvList: VenvInfo[]): VenvInfo | null {
  if (!filePath || !venvList.length) return null
  const dir = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : filePath
  let best: VenvInfo | null = null
  let bestLen = -1
  for (const v of venvList) {
    if ((dir + '/').startsWith(v.subdir + '/') || dir === v.subdir) {
      if (v.subdir.length > bestLen) {
        bestLen = v.subdir.length
        best = v
      }
    }
  }
  return best
}

export interface VenvManagerDeps {
  invoke: (cmd: string, args?: any) => Promise<any>
  get: (store: any) => any
  stores: {
    projectRoot: any
    pythonCmd: any
    venvMap: any
    venvScanning: any
  }
}

/**
 * Walk-up venv discovery: given a file path, finds the closest ancestor directory
 * (bounded by projectRoot) that contains a .venv / venv / .env / env. Caches per
 * directory to avoid repeat lookups across sessions.
 *
 * Pattern matches the Python Envy VS Code extension.
 */
export function createVenvManager(deps: VenvManagerDeps) {
  const { invoke, get, stores } = deps
  const searched = new Map<string, VenvInfo | null>()  // dir → result (in-session memo)
  let busyCount = 0

  function applyVenvToMap(venv: VenvInfo) {
    const current = get(stores.venvMap) as VenvInfo[]
    if (current.some(v => v.pythonPath === venv.pythonPath)) return
    stores.venvMap.set([...current, venv])
  }

  function preloadVenvCache(root: string) {
    const cache = loadVenvCache()
    const prefix = root + ':'
    const seen = new Set<string>()
    const venvs: VenvInfo[] = []
    for (const [key, entry] of Object.entries(cache)) {
      if (!key.startsWith(prefix)) continue
      if (entry.venv && !seen.has(entry.venv.pythonPath)) {
        seen.add(entry.venv.pythonPath)
        venvs.push(entry.venv)
      }
    }
    if (venvs.length) {
      console.log(`[Canopy] preloaded ${venvs.length} cached venv(s) for`, root)
      stores.venvMap.set(venvs)
    }
  }

  /**
   * For a freshly-opened file, walk up its ancestors to find the closest venv
   * and auto-switch pythonCmd. O(depth) stats on the main process side.
   */
  async function findVenvForFile(filePath: string): Promise<void> {
    const root = get(stores.projectRoot) as string | null
    if (!root || !filePath) return
    if (filePath !== root && !filePath.startsWith(root + '/')) return

    const dir = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : filePath

    // In-session memo — if we already looked up this dir, reuse the result
    if (searched.has(dir)) {
      const cached = searched.get(dir) ?? null
      if (cached) applyAndSwitch(cached)
      return
    }

    if (++busyCount === 1) stores.venvScanning.set(true)
    try {
      const venv = await invoke('find_ancestor_venv', { filePath }) as VenvInfo | null
      searched.set(dir, venv)

      // Persist for next session, keyed by file's dir
      const cache = loadVenvCache()
      cache[root + ':' + dir] = { mtime: Date.now(), venv }
      saveVenvCache(cache)

      if (venv) applyAndSwitch(venv)
    } catch (e) {
      console.warn('[Canopy] findVenvForFile:', e)
    } finally {
      if (--busyCount === 0) stores.venvScanning.set(false)
    }
  }

  function applyAndSwitch(venv: VenvInfo) {
    applyVenvToMap(venv)
    const current = get(stores.pythonCmd) as string
    if (current !== venv.pythonPath) stores.pythonCmd.set(venv.pythonPath)
  }

  function clearMemo() { searched.clear() }

  return { findVenvForFile, preloadVenvCache, clearMemo }
}
