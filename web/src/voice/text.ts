/**
 * What of a reply is worth hearing: the prose. Code blocks, tables, tool output and link targets
 * are on screen; reading them out is noise. `SentenceFeed` turns a streaming reply into chunks
 * that can be spoken while the rest is still arriving.
 */

/** Markdown → plain spoken text. */
export function speakable(md: string): string {
  let t = md
  // fenced code: one short mention instead of the code
  t = t.replace(/```[\s\S]*?(```|$)/g, ' (code on screen) ')
  // tables: any run of lines that start with |
  t = t.replace(/(^|\n)(\s*\|.*(\n|$))+/g, '\n(table on screen)\n')
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links: keep the words
  t = t.replace(/<\/?[a-z][^>]*>/gi, ' ') // html tags
  t = t.replace(/https?:\/\/\S+/g, 'a link')
  t = t.replace(/`([^`]+)`/g, '$1') // inline code: keep the words
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
  t = t.replace(/^\s{0,3}>\s?/gm, '') // quotes
  t = t.replace(/^\s*([-*+]|\d+[.)])\s+/gm, '') // list markers
  t = t.replace(/^\s*([-*_]\s*){3,}$/gm, ' ') // rules
  t = t.replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]+?)\1/g, '$2') // emphasis
  t = t.replace(/[*_~#|]+/g, ' ')
  t = t.replace(/\s*\n\s*\n\s*/g, '. ').replace(/\s*\n\s*/g, ' ')
  t = t.replace(/(\(code on screen\)[.\s]*){2,}/g, '(code on screen) ')
  t = t.replace(/\.\s*\./g, '.').replace(/\s+([.,!?;:])/g, '$1').replace(/\s{2,}/g, ' ')
  return t.trim()
}

/** Split spoken text into sentences, then pack them into chunks of a comfortable length. */
export function chunk(text: string, min = 60, max = 320): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? []
  const out: string[] = []
  let cur = ''
  for (const raw of sentences) {
    const s = raw.trim()
    if (!s) continue
    if (s.length > max) {
      if (cur) out.push(cur), (cur = '')
      // a very long sentence: break at commas, then at word boundaries
      for (const part of s.match(new RegExp(`.{1,${max}}(\\s|$)`, 'g')) ?? [s]) out.push(part.trim())
      continue
    }
    if (cur && cur.length + s.length + 1 > max) out.push(cur), (cur = '')
    cur = cur ? `${cur} ${s}` : s
    if (cur.length >= min) out.push(cur), (cur = '')
  }
  if (cur) out.push(cur)
  return out.filter((c) => /[a-z0-9]/i.test(c))
}

/**
 * Feed it a reply as it streams; it hands back chunks once whole sentences are in, never from
 * inside an unfinished code block. `flush()` at the end returns the rest.
 */
export class SentenceFeed {
  private raw = ''
  private spoken = 0

  push(delta: string): string[] {
    this.raw += delta
    const pending = this.raw.slice(this.spoken)
    // not while a code fence is open: its end decides what it was
    if ((pending.match(/```/g) ?? []).length % 2 === 1) return []
    // up to the last sentence end or paragraph break
    let cut = -1
    const re = /[.!?]["')\]]*\s|\n\s*\n/g
    let m: RegExpExecArray | null
    while ((m = re.exec(pending))) cut = m.index + m[0].length
    if (cut < 0 || cut < 40) return []
    this.spoken += cut
    return chunk(speakable(pending.slice(0, cut)))
  }

  flush(): string[] {
    const rest = this.raw.slice(this.spoken)
    this.spoken = this.raw.length
    return chunk(speakable(rest))
  }
}
