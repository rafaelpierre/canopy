<script lang="ts">
  import type { Snippet } from 'svelte'
  import { tick } from 'svelte'

  interface Props {
    open:     boolean
    onClose:  () => void
    width?:   string
    children: Snippet
  }
  let { open, onClose, width = '460px', children }: Props = $props()

  let boxEl: HTMLElement | undefined = $state(undefined)
  let previousFocus: HTMLElement | null = null

  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

  $effect(() => {
    if (open) {
      previousFocus = document.activeElement as HTMLElement | null
      tick().then(() => {
        const first = boxEl?.querySelector<HTMLElement>(FOCUSABLE)
        ;(first ?? boxEl)?.focus()
      })
    } else {
      previousFocus?.focus()
      previousFocus = null
    }
  })

  function trapFocus(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key !== 'Tab' || !boxEl) return
    const focusable = Array.from(boxEl.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (!focusable.length) return
    const first = focusable[0]
    const last  = focusable[focusable.length - 1]
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus() }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus() }
    }
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="bm-backdrop"
    role="presentation"
    onclick={(e) => { if (e.target === e.currentTarget) onClose() }}
  >
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="bm-box"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      style="width:{width}"
      bind:this={boxEl}
      onclick={(e) => e.stopPropagation()}
      onkeydown={trapFocus}
    >
      {@render children()}
    </div>
  </div>
{/if}

<style>
  .bm-backdrop {
    position: fixed; inset: 0; z-index: 9000;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(3px);
    display: flex; align-items: center; justify-content: center;
    animation: bm-fade 0.1s ease-out;
  }

  .bm-box {
    background: var(--bg-panel);
    border: 1px solid rgba(123, 140, 222, 0.25);
    border-radius: 12px;
    box-shadow:
      0 24px 64px rgba(0, 0, 0, 0.72),
      0 0 0 1px rgba(123, 140, 222, 0.06),
      0 4px 16px rgba(123, 140, 222, 0.12);
    overflow: hidden;
    animation: bm-in 0.12s ease-out;
  }

  .bm-box:focus { outline: none; }

  @keyframes bm-fade {
    from { opacity: 0 }
    to   { opacity: 1 }
  }

  @keyframes bm-in {
    from { opacity: 0; transform: scale(0.96) translateY(-6px) }
    to   { opacity: 1; transform: scale(1)    translateY(0) }
  }
</style>
