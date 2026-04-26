export interface GitignoreRule {
  regex: RegExp
  negated: boolean
  dirOnly: boolean
}

export function gitPatternToRegex(pattern: string, anchored: boolean): RegExp {
  const s = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x01')
    .replace(/\*/g, '[^/]*')
    .replace(/\x01/g, '.*')
    .replace(/\?/g, '[^/]')
  if (anchored || pattern.includes('/')) {
    return new RegExp('^' + s + '(/.*)?$')
  } else {
    return new RegExp('(^|/)' + s + '(/.*)?$')
  }
}

export function parseGitignore(content: string): GitignoreRule[] {
  const rules: GitignoreRule[] = []
  for (let line of content.split('\n')) {
    line = line.trim()
    if (!line || line.startsWith('#')) continue
    const negated = line.startsWith('!')
    if (negated) line = line.slice(1).trim()
    const dirOnly = line.endsWith('/')
    if (dirOnly) line = line.slice(0, -1)
    const anchored = line.startsWith('/')
    if (anchored) line = line.slice(1)
    if (!line) continue
    try {
      rules.push({ regex: gitPatternToRegex(line, anchored), negated, dirOnly })
    } catch {}
  }
  return rules
}
