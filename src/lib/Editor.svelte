<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { get } from 'svelte/store'

  let container: HTMLDivElement
  let editor: any = null
  let currentPath: string | null = null
  let currentModel: any = null
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let unsubs: (() => void)[] = []
  let semanticWorker: Worker | null = null

  // Content as last written to disk by us — used only to suppress own-write watcher events
  const lastSavedContent = new Map<string, string>()
  // Monaco alternative-version-id at the last EXPLICIT save (Cmd+S) or file load.
  // Dirty = current version !== this value. Auto-save does NOT update this.
  const lastExplicitVersionId = new Map<string, number>()
  // Paths currently being watched in the main process — prevents redundant IPC calls
  const watchedPaths = new Set<string>()
  // Disposable for the active model's content-change listener
  let contentChangeDisposable: any = null
  // Debounce timer for LSP didChange notifications — avoids sending 10+ msgs/sec during fast typing
  let lspChangeTimer: ReturnType<typeof setTimeout> | null = null

  // Lazy-loaded modules
  let monaco: any
  let invoke: any
  let lspClient: any
  let pathToUri: any
  let stores: any

  // Track semantic token legend from server
  let serverTokenTypes: string[] = []
  let serverTokenModifiers: string[] = []

  // -------------------------------------------------------------------------
  // Monaco theme (Zed-inspired)
  // -------------------------------------------------------------------------

  function defineTheme() {
    monaco.editor.defineTheme('canopy-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        // Zed-inspired syntax colors
        { token: 'keyword',             foreground: 'c678dd' },
        { token: 'keyword.control',     foreground: 'c678dd' },
        { token: 'string',              foreground: '98c379' },
        { token: 'string.quote',        foreground: '98c379' },
        { token: 'string.escape',       foreground: '56b6c2' },
        { token: 'string.delimeter',    foreground: '98c379' },
        { token: 'comment',             foreground: '5c6370' },
        { token: 'comment.doc',         foreground: '5c6370' },
        { token: 'number',              foreground: 'd19a66' },
        { token: 'operator',            foreground: '56b6c2' },
        { token: 'delimiter',           foreground: 'abb2bf' },
        { token: 'type',                foreground: 'e5c07b' },
        { token: 'type.identifier',     foreground: 'e5c07b' },
        { token: 'class',               foreground: 'e5c07b' },
        { token: 'function',            foreground: '61afef' },
        { token: 'variable',            foreground: 'abb2bf' },
        { token: 'variable.predefined', foreground: 'e06c75' },
        { token: 'constant',            foreground: 'd19a66' },
        { token: 'tag',                 foreground: 'e06c75' },
        { token: 'attribute.name',      foreground: 'e5c07b' },
        { token: 'attribute.value',     foreground: '98c379' },
        { token: 'namespace',           foreground: 'e5c07b' },
        { token: 'decorator',           foreground: 'e5c07b' },
        { token: 'parameter',           foreground: 'e06c75' },
        { token: 'property',            foreground: 'e06c75' },
        { token: 'enumMember',          foreground: '56b6c2' },
        { token: 'method',              foreground: '61afef' },
        { token: 'macro',               foreground: 'c678dd' },
        { token: 'selfParameter',       foreground: 'e06c75' },
      ],
      colors: {
        'editor.background':                '#1c1c1c',
        'editor.foreground':                '#d4d4d4',
        'editor.lineHighlightBackground':   '#ffffff06',
        'editor.selectionBackground':       '#3d4f6f',
        'editor.inactiveSelectionBackground':'#3d4f6f80',
        'editorCursor.foreground':          '#528bff',
        'editorLineNumber.foreground':      '#3e3e3e',
        'editorLineNumber.activeForeground':'#7a7a7a',
        'editorGutter.background':          '#1c1c1c',
        'editorWidget.background':          '#252525',
        'editorWidget.border':              '#444444',
        'editorSuggestWidget.background':   '#252525',
        'editorSuggestWidget.border':       '#444444',
        'editorSuggestWidget.selectedBackground': '#3d4f6f40',
        'list.hoverBackground':             '#2a2a2a',
        'scrollbar.shadow':                 '#00000000',
        'scrollbarSlider.background':       '#ffffff18',
        'scrollbarSlider.hoverBackground':  '#ffffff2e',
        'scrollbarSlider.activeBackground': '#ffffff38',
        'editorOverviewRuler.border':               '#00000000',
        'editorOverviewRuler.errorForeground':      '#e06c75cc',
        'editorOverviewRuler.warningForeground':    '#e5c07b99',
        'editorOverviewRuler.infoForeground':       '#61afef66',
        'editorError.foreground':                   '#e06c75',
        'editorWarning.foreground':                 '#e5c07b',
        'editorInfo.foreground':                    '#61afef',
      },
    })
  }

  // -------------------------------------------------------------------------
  // LSP ↔ Monaco bridge
  // -------------------------------------------------------------------------

  function lspSeverityToMonaco(severity: number): number {
    // LSP: 1=Error, 2=Warning, 3=Information, 4=Hint
    // Monaco: 8=Error, 4=Warning, 2=Info, 1=Hint
    switch (severity) {
      case 1: return 8
      case 2: return 4
      case 3: return 2
      case 4: return 1
      default: return 2
    }
  }

  function posToMonaco(pos: { line: number; character: number }) {
    return { lineNumber: pos.line + 1, column: pos.character + 1 }
  }

  function monacoToLsp(pos: { lineNumber: number; column: number }) {
    return { line: pos.lineNumber - 1, character: pos.column - 1 }
  }

  // -------------------------------------------------------------------------
  // Semantic tokens
  // -------------------------------------------------------------------------

  const SEMANTIC_COLOR_MAP: Record<string, string> = {
    namespace:     '#d4bfff',
    type:          '#e5c07b',
    class:         '#e5c07b',
    enum:          '#e5c07b',
    interface:     '#7ee6c2',
    struct:        '#e5c07b',
    typeParameter: '#d19a66',
    parameter:     '#e06c75',
    variable:      '#abb2bf',
    property:      '#e06c75',
    enumMember:    '#56b6c2',
    function:      '#61afef',
    method:        '#61afef',
    keyword:       '#c678dd',
    macro:         '#c678dd',
    decorator:     '#c678dd',
    selfParameter: '#e06c75',
    clsParameter:  '#e06c75',
  }

  function applySemanticTokens(data: number[]) {
    if (!semanticWorker || !editor || !currentModel) return
    const tokenTypes = lspClient.serverTokenTypes
    if (!tokenTypes?.length) return
    // Convert to Int32Array so the buffer can be transferred (zero-copy)
    const buf = new Int32Array(data)
    semanticWorker.postMessage({ rawData: buf, tokenTypes }, [buf.buffer])
  }

  function applyDecodedTokens(tokens: Array<{ line: number; startCharacter: number; length: number; tokenType: string }>) {
    if (!editor || !currentModel) return
    const decorations = tokens
      .filter(t => SEMANTIC_COLOR_MAP[t.tokenType])
      .map(t => ({
        range: new monaco.Range(t.line, t.startCharacter + 1, t.line, t.startCharacter + t.length + 1),
        options: { inlineClassName: `sem-${t.tokenType}` },
      }))
    const oldDecos = (editor as any)._semanticDecos ?? []
    ;(editor as any)._semanticDecos = editor.deltaDecorations(oldDecos, decorations)
  }

  // -------------------------------------------------------------------------
  // Language detection
  // -------------------------------------------------------------------------

  const LANG_MAP: Record<string, string> = {
    py: 'python', json: 'json', toml: 'ini', ini: 'ini', conf: 'ini', cfg: 'ini',
    md: 'markdown', yaml: 'yaml', yml: 'yaml', xml: 'xml', html: 'html', css: 'css',
    js: 'javascript', ts: 'typescript', sh: 'shell', bash: 'shell', zsh: 'shell',
    txt: 'plaintext', rst: 'plaintext', dockerfile: 'dockerfile',
  }

  function langFromPath(path: string): string {
    const filename = path.split('/').pop()?.toLowerCase() ?? ''
    if (filename === 'dockerfile') return 'dockerfile'
    return LANG_MAP[filename.split('.').pop() ?? ''] ?? 'plaintext'
  }

  // -------------------------------------------------------------------------
  // Load file
  // -------------------------------------------------------------------------

  async function loadFile(path: string) {
    if (path === currentPath) return
    let content: string
    try {
      content = await invoke('read_file_content', { path })
    } catch (e) {
      console.error('read_file_content failed:', e)
      return
    }

    // Record disk version — used only for watcher own-write suppression.
    lastSavedContent.set(path, content)

    // Watch for external changes (Claude Code etc.) — skip IPC if already watching.
    if (!watchedPaths.has(path)) {
      invoke('watch_file', { path }).catch(() => {})
      watchedPaths.add(path)
    }

    currentPath = path

    // Dispose previous content-change listener before switching models
    contentChangeDisposable?.dispose()
    contentChangeDisposable = null

    // Create or update model
    const uri = monaco.Uri.parse(pathToUri(path))
    const lang = langFromPath(path)
    let model = monaco.editor.getModel(uri)
    if (model) {
      model.setValue(content)
      monaco.editor.setModelLanguage(model, lang)
    } else {
      model = monaco.editor.createModel(content, lang, uri)
    }
    currentModel = model
    editor.setModel(model)

    // Snapshot the version at load time — this is the "clean" baseline.
    // Dirty = buffer version has diverged from this since the last Cmd+S.
    lastExplicitVersionId.set(path, model.getAlternativeVersionId())
    stores.dirtyTabs.update((s: Set<string>) => { const n = new Set(s); n.delete(path); return n })

    // Clear semantic decorations
    const oldDecos2 = (editor as any)._semanticDecos ?? []
    ;(editor as any)._semanticDecos = editor.deltaDecorations(oldDecos2, [])

    const isPython = path.endsWith('.py')
    if (isPython && lspClient?.isReady()) {
      const alreadyOpen = lspClient.isOpen(path)
      if (alreadyOpen) {
        // File was opened by workspace scan — restore its markers immediately so
        // there's no flash, then send didChange to get a fresh analysis.
        const cached = _diagBuffer.get(pathToUri(path))
        if (cached?.length) {
          monaco.editor.setModelMarkers(model, 'basedpyright', cached.map((m: any) => ({
            severity: m.severity, message: m.message,
            startLineNumber: m.startLineNumber, startColumn: m.startColumn,
            endLineNumber: m.endLineNumber, endColumn: m.endColumn, source: m.source,
          })))
        } else {
          monaco.editor.setModelMarkers(model, 'basedpyright', [])
        }
        lspClient.didChange(path, content)
      } else {
        monaco.editor.setModelMarkers(model, 'basedpyright', [])
        lspClient.didOpen(path, content)
      }
      requestSemanticTokens(path)
    } else {
      monaco.editor.setModelMarkers(model, 'basedpyright', [])
    }

    // Track content changes: update dirty state and auto-save
    const filePath = path  // capture for closure
    contentChangeDisposable = model.onDidChangeContent(() => {
      if (currentPath !== filePath) return

      // Dirty = version has diverged from the last explicit save (Cmd+S) or load.
      // O(1) integer comparison — no string allocation on every keystroke.
      const isDirty = model.getAlternativeVersionId() !== (lastExplicitVersionId.get(filePath) ?? -1)
      stores.dirtyTabs.update((s: Set<string>) => {
        const n = new Set(s)
        if (isDirty) n.add(filePath)
        else n.delete(filePath)
        return n
      })

      if (isPython && lspClient?.isReady()) {
        if (lspChangeTimer) clearTimeout(lspChangeTimer)
        lspChangeTimer = setTimeout(() => {
          if (currentPath === filePath && lspClient?.isReady()) {
            lspClient.didChange(filePath, model.getValue())
          }
          lspChangeTimer = null
        }, 100)
      }
      if (saveTimer) clearTimeout(saveTimer)
      // Auto-save writes to disk for safety but does NOT clear dirty —
      // only an explicit Cmd+S resets the dirty baseline.
      saveTimer = setTimeout(async () => {
        const contentToSave = model.getValue()
        try {
          await invoke('write_file_content', { path: filePath, content: contentToSave })
          lastSavedContent.set(filePath, contentToSave)  // watcher suppression only
        } catch (e) {
          console.error('[Canopy] auto-save failed:', filePath, e)
        }
      }, 400)
    })
  }

  async function requestSemanticTokens(path: string, retries = 1) {
    if (!lspClient?.isReady() || !editor || path !== currentPath) return
    try {
      const result = await lspClient.semanticTokensFull(path)
      if (!result?.data || path !== currentPath) return
      applySemanticTokens(result.data)
    } catch (e) {
      // LSP may not have tokens ready yet — retry once after a short delay
      if (retries > 0 && path === currentPath) {
        setTimeout(() => requestSemanticTokens(path, retries - 1), 200)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Mount / Destroy
  // -------------------------------------------------------------------------

  // Mutable accumulator for LSP diagnostics — flushed to the reactive store in batches.
  // Avoids O(n²) Map clones during workspace scan (one flush per 50ms window).
  let _diagBuffer = new Map<string, any[]>()
  let _diagFlushTimer: ReturnType<typeof setTimeout> | null = null

  function flushDiagBuffer() {
    _diagFlushTimer = null
    if (stores) stores.diagnosticsByUri.set(new Map(_diagBuffer))
  }

  onMount(async () => {
    // Set up Monaco workers before importing
    ;(globalThis as any).MonacoEnvironment = {
      getWorker(_moduleId: string, label: string) {
        switch (label) {
          case 'json':
            return new Worker(new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url), { type: 'module' })
          case 'css':
          case 'scss':
          case 'less':
            return new Worker(new URL('monaco-editor/esm/vs/language/css/css.worker.js', import.meta.url), { type: 'module' })
          case 'html':
          case 'handlebars':
          case 'razor':
            return new Worker(new URL('monaco-editor/esm/vs/language/html/html.worker.js', import.meta.url), { type: 'module' })
          case 'typescript':
          case 'javascript':
            return new Worker(new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url), { type: 'module' })
          default:
            return new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url), { type: 'module' })
        }
      },
    }

    const [monacoMod, ipcMod, lspMod, storesMod] = await Promise.all([
      import('monaco-editor'),
      import('$lib/ipc'),
      import('./lsp/client'),
      import('./stores'),
    ])

    monaco    = monacoMod
    invoke    = ipcMod.invoke
    lspClient = lspMod.lspClient
    pathToUri = lspMod.pathToUri
    stores    = storesMod

    semanticWorker = new Worker(
      new URL('./semantic-tokens.worker.ts', import.meta.url),
      { type: 'module' }
    )
    semanticWorker.onmessage = ({ data }: MessageEvent) => {
      applyDecodedTokens(data.tokens)
    }

    defineTheme()

    editor = monaco.editor.create(container, {
      value: '',
      language: 'python',
      theme: 'canopy-dark',
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontLigatures: false,
      lineHeight: 20,
      minimap: { enabled: false },
      scrollbar: {
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
        useShadows: false,
      },
      overviewRulerBorder: false,
      overviewRulerLanes: 3,
      renderLineHighlight: 'line',
      renderLineHighlightOnlyWhenFocus: false,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      smoothScrolling: true,
      padding: { top: 8 },
      automaticLayout: true,
      bracketPairColorization: { enabled: true },
      guides: { indentation: true, bracketPairs: false },
      wordWrap: 'off',
      tabSize: 4,
      insertSpaces: true,
      folding: true,
      glyphMargin: false,
      lineNumbersMinChars: 3,
      'semanticHighlighting.enabled': true,
    })

    // Expose editor instance for command palette find integration
    stores.monacoEditorRef.set(editor)

    // Ctrl+S / Cmd+S — save all open tabs immediately
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
      const saveFn = get(stores.saveTabsFn) as ((paths: string[]) => Promise<void>) | null
      if (!saveFn) return
      const tabs = get(stores.openTabs) as string[]
      await saveFn(tabs)
    })

    // Expose save callback — saves a given set of paths using their Monaco models.
    // This is the ONLY place that advances lastExplicitVersionId and clears dirty.
    stores.saveTabsFn.set(async (paths: string[]) => {
      for (const p of paths) {
        const uri = monaco.Uri.parse(pathToUri(p))
        const model = monaco.editor.getModel(uri)
        if (!model) continue
        if (saveTimer && p === currentPath) { clearTimeout(saveTimer); saveTimer = null }
        const content = model.getValue()
        try {
          await invoke('write_file_content', { path: p, content })
          lastSavedContent.set(p, content)
          lastExplicitVersionId.set(p, model.getAlternativeVersionId())
          stores.dirtyTabs.update((s: Set<string>) => { const n = new Set(s); n.delete(p); return n })
          if (p.endsWith('.py') && lspClient?.isReady()) lspClient.didChange(p, content)
        } catch (e) {
          console.error('[Canopy] save failed:', p, e)
        }
      }
    })

    // Expose buffer-content reader — returns Monaco model value for any open path
    stores.getBufferFn.set((path: string) => {
      const uri = monaco.Uri.parse(pathToUri(path))
      const model = monaco.editor.getModel(uri)
      return model ? model.getValue() : null
    })

    // Expose reload callback — forces a file to re-read from disk and resets dirty baseline
    stores.reloadFileFn.set(async (path: string) => {
      try {
        const content = await invoke('read_file_content', { path })
        lastSavedContent.set(path, content)
        if (path === currentPath) {
          // Full reload via loadFile (re-applies LSP markers, semantic tokens, etc.)
          // loadFile will set lastExplicitVersionId and clear dirty.
          currentPath = null
          await loadFile(path)
        } else {
          // Background tab: update model content and reset baseline
          const uri = monaco.Uri.parse(pathToUri(path))
          const model = monaco.editor.getModel(uri)
          if (model) {
            model.setValue(content)
            lastExplicitVersionId.set(path, model.getAlternativeVersionId())
            stores.dirtyTabs.update((s: Set<string>) => { const n = new Set(s); n.delete(path); return n })
          }
        }
      } catch (e) {
        console.error('[Canopy] reload failed:', path, e)
      }
    })

    // Expose dispose callback — cleans up Monaco model and Editor-side Maps for a closed tab
    stores.disposeTabFn.set((path: string) => {
      lastSavedContent.delete(path)
      lastExplicitVersionId.delete(path)
      watchedPaths.delete(path)
      const uri = monaco.Uri.parse(pathToUri(path))
      const model = monaco.editor.getModel(uri)
      if (model && path !== currentPath) model.dispose()
    })

    // Register completion provider — trigger on common Python typing patterns
    monaco.languages.registerCompletionItemProvider('python', {
      triggerCharacters: ['.', '(', '[', ',', ' ', ':', '"', "'", '@', '/'],
      provideCompletionItems: async (model: any, position: any, context: any) => {
        if (!lspClient?.isReady() || !currentPath) return { suggestions: [] }
        const lspPos = monacoToLsp(position)
        try {
          const triggerKind = context?.triggerKind ?? 1
          const triggerChar = context?.triggerCharacter
          const result = await lspClient.completion(currentPath, lspPos, triggerKind, triggerChar)
          const items = result?.items ?? result ?? []
          return {
            suggestions: items.slice(0, 200).map((item: any) => ({
              label: item.label,
              kind: item.kind ?? 1,
              detail: item.detail,
              documentation: typeof item.documentation === 'string'
                ? item.documentation
                : item.documentation?.value,
              insertText: item.insertText ?? item.label,
              range: undefined,
            })),
          }
        } catch { return { suggestions: [] } }
      },
    })

    // Register hover provider
    monaco.languages.registerHoverProvider('python', {
      provideHover: async (model: any, position: any) => {
        if (!lspClient?.isReady() || !currentPath) return null
        try {
          const result = await lspClient.hover(currentPath, monacoToLsp(position))
          if (!result?.contents) return null
          const value = typeof result.contents === 'string'
            ? result.contents
            : result.contents.value ?? result.contents.map?.((c: any) => c.value ?? c).join('\n\n')
          if (!value) return null
          return {
            contents: [{ value: `\`\`\`python\n${value}\n\`\`\`` }],
          }
        } catch { return null }
      },
    })

    // Register definition provider (Ctrl/Cmd+Click)
    monaco.languages.registerDefinitionProvider('python', {
      provideDefinition: async (model: any, position: any) => {
        if (!lspClient?.isReady() || !currentPath) return null
        try {
          const result = await lspClient.definition(currentPath, monacoToLsp(position))
          if (!result) return null
          const defs = Array.isArray(result) ? result : [result]
          return defs.map((d: any) => {
            const uri = d.uri ?? d.targetUri
            const range = d.range ?? d.targetRange
            return {
              uri: monaco.Uri.parse(uri),
              range: range ? new monaco.Range(
                range.start.line + 1, range.start.character + 1,
                range.end.line + 1, range.end.character + 1,
              ) : undefined,
            }
          })
        } catch { return null }
      },
    })

    // Register references provider (Shift+F12 / right-click → Find All References)
    monaco.languages.registerReferenceProvider('python', {
      provideReferences: async (model: any, position: any) => {
        if (!lspClient?.isReady() || !currentPath) return []
        try {
          const result = await lspClient.references(currentPath, monacoToLsp(position))
          if (!Array.isArray(result)) return []
          return result.map((r: any) => ({
            uri:   monaco.Uri.parse(r.uri),
            range: new monaco.Range(
              r.range.start.line + 1, r.range.start.character + 1,
              r.range.end.line + 1,   r.range.end.character + 1,
            ),
          }))
        } catch { return [] }
      },
    })

    // LSP diagnostics → workspace map + Monaco markers for open file
    lspClient.onDiagnostics((uri: string, rawItems: any[]) => {
      const filePath = uri.startsWith('file://') ? uri.slice('file://'.length) : uri

      const diagItems = rawItems.map((d: any) => ({
        severity:        lspSeverityToMonaco(d.severity ?? 1),
        message:         d.message,
        filePath,
        startLineNumber: d.range.start.line + 1,
        startColumn:     d.range.start.character + 1,
        endLineNumber:   d.range.end.line + 1,
        endColumn:       d.range.end.character + 1,
        source:          d.source ?? 'basedpyright',
      }))

      // Accumulate into local buffer; flush to store in batches (avoids O(n²) Map copies)
      if (diagItems.length === 0) _diagBuffer.delete(uri)
      else _diagBuffer.set(uri, diagItems)
      if (_diagFlushTimer) clearTimeout(_diagFlushTimer)
      _diagFlushTimer = setTimeout(flushDiagBuffer, 50)

      // Apply Monaco markers only for the currently open file
      const isOpenFile = currentPath && (uri === pathToUri(currentPath) || uri.endsWith(currentPath))
      if (isOpenFile && currentModel) {
        monaco.editor.setModelMarkers(currentModel, 'basedpyright', diagItems.map((m: any) => ({
          severity:        m.severity,
          message:         m.message,
          startLineNumber: m.startLineNumber,
          startColumn:     m.startColumn,
          endLineNumber:   m.endLineNumber,
          endColumn:       m.endColumn,
          source:          m.source,
        })))
        if (currentPath?.endsWith('.py')) requestSemanticTokens(currentPath)
      }
    })

    // Subscribe to file path changes
    unsubs.push(
      stores.openFilePath.subscribe((path: string | null) => {
        if (path) {
          loadFile(path)
        } else if (editor) {
          currentPath = null
          editor.setModel(null)
        }
      })
    )

    // Track LSP status changes:
    // - 'starting': clear stale diagnostic buffer so a restart never resurrects old counts
    // - 'ready': register current file if not already open (handles race where file loaded
    //            before LSP finished initializing)
    unsubs.push(
      stores.lspStatus.subscribe((status: string) => {
        if (status === 'starting') {
          if (_diagFlushTimer) { clearTimeout(_diagFlushTimer); _diagFlushTimer = null }
          _diagBuffer.clear()
        }
        if (status === 'ready' && currentPath?.endsWith('.py') && currentModel) {
          if (lspClient.isOpen(currentPath)) {
            lspClient.didChange(currentPath, currentModel.getValue())
          } else {
            lspClient.didOpen(currentPath, currentModel.getValue())
          }
          requestSemanticTokens(currentPath)
        }
      })
    )

    // Subscribe to revealLine — jump to and highlight a specific line
    unsubs.push(
      stores.revealLine.subscribe((line: number | null) => {
        if (!line || !editor) return
        editor.revealLineInCenter(line)
        editor.setPosition({ lineNumber: line, column: 1 })
        editor.focus()
        // Clear the store so it can be re-triggered with the same line
        setTimeout(() => stores.revealLine.set(null), 50)
      })
    )

    // Subscribe to font size changes (Cmd+/-)
    unsubs.push(
      stores.editorFontSize.subscribe((size: number) => {
        if (editor) {
          editor.updateOptions({ fontSize: size, lineHeight: Math.round(size * 1.55) })
        }
      })
    )
  })

  onDestroy(() => {
    for (const u of unsubs) u()
    contentChangeDisposable?.dispose()
    editor?.dispose()
    if (saveTimer) clearTimeout(saveTimer)
    semanticWorker?.terminate()
    semanticWorker = null
    if (stores) {
      stores.saveTabsFn.set(null)
      stores.reloadFileFn.set(null)
      stores.getBufferFn.set(null)
      stores.disposeTabFn.set(null)
    }
  })
</script>

<div class="editor-wrap selectable">
  <div class="monaco-container" bind:this={container}></div>
</div>

<style>
  .editor-wrap {
    position: relative;
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .monaco-container {
    flex: 1;
    overflow: hidden;
  }

  /* Semantic token classes */
  .monaco-container :global(.sem-class)         { color: #e5c07b !important; }
  .monaco-container :global(.sem-type)          { color: #e5c07b !important; }
  .monaco-container :global(.sem-enum)          { color: #e5c07b !important; }
  .monaco-container :global(.sem-interface)     { color: #7ee6c2 !important; }
  .monaco-container :global(.sem-namespace)     { color: #d4bfff !important; }
  .monaco-container :global(.sem-typeParameter) { color: #d19a66 !important; }
  .monaco-container :global(.sem-function)      { color: #61afef !important; }
  .monaco-container :global(.sem-method)        { color: #61afef !important; }
  .monaco-container :global(.sem-decorator)     { color: #c678dd !important; }
  .monaco-container :global(.sem-parameter)     { color: #e06c75 !important; }
  .monaco-container :global(.sem-variable)      { color: #abb2bf !important; }
  .monaco-container :global(.sem-property)      { color: #e06c75 !important; }
  .monaco-container :global(.sem-enumMember)    { color: #56b6c2 !important; }
  .monaco-container :global(.sem-keyword)       { color: #c678dd !important; }
  .monaco-container :global(.sem-macro)         { color: #c678dd !important; }
  .monaco-container :global(.sem-selfParameter) { color: #e06c75 !important; }
  .monaco-container :global(.sem-clsParameter)  { color: #e06c75 !important; }
</style>
