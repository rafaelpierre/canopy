<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    open:     boolean
    onClose:  () => void
    width?:   string
    children: Snippet
  }
  let { open, onClose, width = '460px', children }: Props = $props()
</script>

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="bm-backdrop"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    onclick={(e) => { if (e.target === e.currentTarget) onClose() }}
    onkeydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }}
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="bm-box" style="width:{width}" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
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

  @keyframes bm-fade {
    from { opacity: 0 }
    to   { opacity: 1 }
  }

  @keyframes bm-in {
    from { opacity: 0; transform: scale(0.96) translateY(-6px) }
    to   { opacity: 1; transform: scale(1)    translateY(0) }
  }
</style>
