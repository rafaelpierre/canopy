<script lang="ts">
  import BaseModal from './BaseModal.svelte'
  import { basename } from './path'

  export type SaveDialogType =
    | { kind: 'close-tab';    path: string }
    | { kind: 'close-app';    paths: string[] }
    | { kind: 'disk-conflict'; path: string }

  interface Props {
    dialog:    SaveDialogType | null
    onSave:    () => void
    onDiscard: () => void
    onCancel:  () => void
  }
  let { dialog, onSave, onDiscard, onCancel }: Props = $props()

  let title        = $derived(getTitle(dialog))
  let body         = $derived(getBody(dialog))
  let saveLabel    = $derived(getSaveLabel(dialog))
  let discardLabel = $derived(getDiscardLabel(dialog))
  let files        = $derived(dialog?.kind === 'close-app' ? dialog.paths : [])
  let isConflict   = $derived(dialog?.kind === 'disk-conflict')

  function getTitle(d: SaveDialogType | null) {
    if (!d) return ''
    if (d.kind === 'disk-conflict') return 'File Changed on Disk'
    return 'Unsaved Changes'
  }

  function getBody(d: SaveDialogType | null) {
    if (!d) return ''
    if (d.kind === 'close-tab')
      return `"${basename(d.path)}" has unsaved changes.`
    if (d.kind === 'close-app') {
      const n = d.paths.length
      return `You have unsaved changes in ${n} file${n !== 1 ? 's' : ''}. Save before quitting?`
    }
    if (d.kind === 'disk-conflict')
      return `"${basename(d.path)}" was modified outside of Canopy while you have unsaved edits. What would you like to do?`
    return ''
  }

  function getSaveLabel(d: SaveDialogType | null) {
    if (!d) return 'Save'
    if (d.kind === 'close-app') return 'Save All'
    if (d.kind === 'disk-conflict') return 'Keep My Changes'
    return 'Save'
  }

  function getDiscardLabel(d: SaveDialogType | null) {
    if (!d) return "Don't Save"
    if (d.kind === 'disk-conflict') return 'Reload from Disk'
    if (d.kind === 'close-tab') return 'Close Without Saving'
    return "Don't Save"
  }
</script>

<BaseModal open={dialog !== null} onClose={onCancel} width="420px">
  <div class="sd-root">

    <div class="sd-header">
      <div class="sd-icon" class:conflict={isConflict}>
        {#if isConflict}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 2L14.5 13H1.5L8 2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
            <path d="M8 6.5V9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <circle cx="8" cy="11.5" r="0.75" fill="currentColor"/>
          </svg>
        {:else}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M11 1H5L1 5V11L5 15H11L15 11V5L11 1Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
            <path d="M8 5V8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <circle cx="8" cy="11" r="0.75" fill="currentColor"/>
          </svg>
        {/if}
      </div>
      <h2 class="sd-title">{title}</h2>
    </div>

    <div class="sd-body">
      <p class="sd-message">{body}</p>
      {#if files.length > 0}
        <ul class="sd-file-list">
          {#each files as f}
            <li><span class="dot">●</span>{basename(f)}</li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="sd-footer">
      <button class="btn-ghost" onclick={onCancel}>Cancel</button>
      <div class="sd-primary-actions">
        <button class="btn-discard" onclick={onDiscard}>{discardLabel}</button>
        <button class="btn-save" onclick={onSave}>{saveLabel}</button>
      </div>
    </div>

  </div>
</BaseModal>

<style>
  .sd-root {
    font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
    color: var(--text-primary);
  }

  /* ── Header ── */
  .sd-header {
    display: flex; align-items: center; gap: 12px;
    padding: 22px 22px 0;
  }

  .sd-icon {
    width: 34px; height: 34px; border-radius: 8px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    background: rgba(123, 140, 222, 0.14);
    color: var(--accent);
    border: 1px solid rgba(123, 140, 222, 0.2);
  }
  .sd-icon.conflict {
    background: rgba(229, 192, 123, 0.12);
    color: var(--warning);
    border-color: rgba(229, 192, 123, 0.2);
  }

  .sd-title {
    font-size: 13px; font-weight: 600; margin: 0;
    color: var(--text-primary); letter-spacing: 0.01em;
  }

  /* ── Body ── */
  .sd-body {
    padding: 14px 22px 18px;
  }

  .sd-message {
    font-size: 12px; color: var(--text-secondary);
    margin: 0; line-height: 1.65;
  }

  .sd-file-list {
    margin: 12px 0 0; padding: 0; list-style: none;
    background: rgba(0, 0, 0, 0.2);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 6px;
    max-height: 130px; overflow-y: auto;
  }
  .sd-file-list li {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 12px; font-size: 11px; color: var(--text-secondary);
  }
  .sd-file-list li + li { border-top: 1px solid rgba(255, 255, 255, 0.04); }
  .dot { font-size: 5px; color: var(--accent); opacity: 0.6; flex-shrink: 0; }
  .sd-file-list::-webkit-scrollbar { width: 4px; }
  .sd-file-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

  /* ── Footer ── */
  .sd-footer {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 22px 18px;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
  }

  .sd-primary-actions { display: flex; gap: 8px; }

  button {
    font-family: inherit; font-size: 11px; font-weight: 500;
    padding: 7px 15px; border-radius: 6px; border: none;
    cursor: pointer; transition: background 0.1s, color 0.1s;
    letter-spacing: 0.02em; white-space: nowrap;
  }

  .btn-save {
    background: var(--accent); color: #fff;
  }
  .btn-save:hover { background: #8f9fe8; }

  .btn-discard {
    background: rgba(224, 108, 117, 0.1);
    color: var(--error);
    border: 1px solid rgba(224, 108, 117, 0.2);
  }
  .btn-discard:hover { background: rgba(224, 108, 117, 0.2); }

  .btn-ghost {
    background: rgba(255, 255, 255, 0.04);
    color: var(--text-secondary);
    border: 1px solid rgba(255, 255, 255, 0.07);
  }
  .btn-ghost:hover { background: rgba(255, 255, 255, 0.09); color: var(--text-primary); }
</style>
