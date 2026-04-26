/** Open all .py files in the LSP so it reports project-wide diagnostics. */
export async function scanWorkspace(
  root: string,
  deps: {
    invoke: (cmd: string, args?: any) => Promise<any>
    lspClient: any
    stores: any
  },
): Promise<void> {
  const { invoke, lspClient, stores } = deps
  let paths: string[]
  try {
    paths = await invoke('list_py_files', { root })
  } catch (e) {
    console.warn('[Canopy] scanWorkspace: list_py_files failed', e)
    return
  }
  console.log(`[Canopy] scanWorkspace: opening ${paths.length} Python files in LSP`)
  stores.lspBusy.set(true)

  const CONCURRENCY = 12
  let idx = 0

  async function worker(): Promise<void> {
    while (idx < paths.length) {
      if (!lspClient.isReady()) return
      const p = paths[idx++]
      if (lspClient.isOpen(p)) continue
      try {
        const content = await invoke('read_file_content', { path: p })
        if (lspClient.isReady()) lspClient.didOpen(p, content)
      } catch {
        /* skip unreadable */
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  stores.lspBusy.set(false)
  console.log('[Canopy] scanWorkspace: done')
}
