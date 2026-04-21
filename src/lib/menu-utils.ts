export function menuFocus(node: HTMLElement) {
  requestAnimationFrame(() => node.querySelector<HTMLElement>('[role="menuitem"]')?.focus())
  return {}
}

export function handleMenuKeydown(e: KeyboardEvent, closeMenu: () => void) {
  e.stopPropagation()
  if (e.key === 'Escape') { closeMenu(); return }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const items = Array.from((e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="menuitem"]'))
    const idx = items.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'ArrowDown' ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0)
    items[Math.max(0, next)]?.focus()
  }
}
