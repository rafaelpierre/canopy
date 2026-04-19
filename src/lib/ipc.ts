// IPC abstraction layer — bridges Svelte frontend to Electron main process.
// Replaces all @tauri-apps/* imports with a single module.

const api = (window as any).electronAPI

const IPC_TIMEOUT_MS = 30_000

export async function invoke<T = any>(command: string, args?: Record<string, any>): Promise<T> {
  return Promise.race([
    api.invoke(command, args),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`IPC timeout: ${command}`)), IPC_TIMEOUT_MS)
    ),
  ])
}

export function listen<T = any>(
  event: string,
  callback: (event: { payload: T }) => void,
): Promise<() => void> {
  // Returns a Promise<UnlistenFn> to match Tauri's listen() signature
  const unlisten = api.on(event, callback)
  return Promise.resolve(unlisten)
}

export async function openFolderDialog(options?: {
  directory?: boolean
  multiple?: boolean
  title?: string
}): Promise<string | null> {
  return api.openFolderDialog()
}

export async function openFileDialog(options?: {
  title?: string
  filters?: Array<{ name: string; extensions: string[] }>
}): Promise<string | null> {
  return api.openFileDialog(options)
}
