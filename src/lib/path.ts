/**
 * Returns true when `child` is `parent` or is directly inside it
 * (directory-boundary-aware: "foo/bar" is under "foo", but "foobar" is not).
 */
export function isUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + '/')
}

/**
 * Returns the last path segment (filename) from a POSIX-style path.
 */
export function basename(p: string): string {
  return p.split('/').pop() ?? p
}

/**
 * Returns the portion of `p` relative to `root`, or `p` unchanged if it
 * does not start with `root`. The leading separator is stripped so callers
 * receive a clean relative path.
 */
export function relpath(p: string, root: string): string {
  if (!root) return p
  return p.startsWith(root) ? p.slice(root.length + 1) : p
}
