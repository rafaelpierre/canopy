self.addEventListener('message', (e: MessageEvent) => {
  const { rawData, tokenTypes } = e.data as { rawData: Int32Array; tokenTypes: string[] }

  let line = 0,
    char = 0
  const tokens: Array<{ line: number; startCharacter: number; length: number; tokenType: string }> =
    []

  for (let i = 0; i < rawData.length; i += 5) {
    line += rawData[i]
    if (rawData[i] > 0) char = 0
    char += rawData[i + 1]
    const length = rawData[i + 2]
    const tokenType = tokenTypes[rawData[i + 3]]
    if (!tokenType) continue
    tokens.push({ line: line + 1, startCharacter: char, length, tokenType })
  }

  ;(self as any).postMessage({ tokens })
})
