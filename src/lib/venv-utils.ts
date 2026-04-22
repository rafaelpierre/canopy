import type { VenvInfo } from '$lib/stores'

export const VENV_CACHE_KEY = 'canopy:venv_cache_v2'

export interface VenvCacheEntry { mtime: number; entryCount: number; venvs: VenvInfo[] }

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
    venvMap: any
    venvScanning: any
  }
}

export function createVenvManager(deps: VenvManagerDeps) {
  const { invoke, get, stores } = deps
  const scanned = new Set<string>()
  let scanCount = 0

  function applyVenvsToMap(venvs: VenvInfo[]) {
    if (!venvs.length) return
    const current = get(stores.venvMap) as VenvInfo[]
    const merged = [...current]
    for (const v of venvs) {
      if (!merged.some(e => e.pythonPath === v.pythonPath)) merged.push(v)
    }
    if (merged.length !== current.length) stores.venvMap.set(merged)
  }

  function preloadVenvCache(root: string) {
    const cache = loadVenvCache()
    const prefix = root + ':'
    const seen = new Set<string>()
    const venvs: VenvInfo[] = []
    for (const [key, entry] of Object.entries(cache)) {
      if (!key.startsWith(prefix)) continue
      for (const v of entry.venvs) {
        if (!seen.has(v.pythonPath)) { seen.add(v.pythonPath); venvs.push(v) }
      }
    }
    if (venvs.length) {
      console.log(`[Canopy] preloaded ${venvs.length} cached venv(s) for`, root)
      stores.venvMap.set(venvs)
    }
  }

  async function maybeScanForVenv(dir: string): Promise<void> {
    const root = get(stores.projectRoot) as string | null
    if (!root || !dir || dir === root) return
    if (!dir.startsWith(root + '/')) return
    if (scanned.has(dir)) return
    scanned.add(dir)

    const cacheKey = root + ':' + dir
    let fp: { mtime: number; entryCount: number } | null = null
    try { fp = await invoke('dir_mtime', { path: dir }) } catch {}

    if (fp !== null) {
      const cache = loadVenvCache()
      const entry = cache[cacheKey]
      if (entry && entry.mtime === fp.mtime && entry.entryCount === fp.entryCount) {
        applyVenvsToMap(entry.venvs)
        return
      }
    }

    if (++scanCount === 1) stores.venvScanning.set(true)
    try {
      const list = await invoke('detect_venv_recursive', { projectRoot: dir, maxDepth: 0 })
      const venvs: VenvInfo[] = Array.isArray(list) ? list : []
      if (fp !== null) {
        const cache = loadVenvCache()
        cache[cacheKey] = { mtime: fp.mtime, entryCount: fp.entryCount, venvs }
        saveVenvCache(cache)
      }
      applyVenvsToMap(venvs)
    } catch (e) {
      console.warn('[Canopy] maybeScanForVenv:', e)
    } finally {
      if (--scanCount === 0) stores.venvScanning.set(false)
    }
  }

  return { maybeScanForVenv, preloadVenvCache, clearScanCache: () => scanned.clear() }
}
