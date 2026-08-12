/**
 * Small, tolerant XML scanner for the well-understood documents inside an
 * EPUB: container.xml and the OPF package document. It is not a general XML
 * parser — it handles elements, attributes, text, CDATA, comments,
 * processing instructions, and entities, and it recovers from malformed
 * input instead of throwing. Names are namespace-tolerant: `name` and
 * `localName` are both reported (`opf:meta` → localName `meta`).
 *
 * Node has no built-in XML parser and EPUB parsing must stay in the worker
 * (no DOM), which is why this exists instead of a dependency.
 */

export interface XmlStartElement {
  /** Raw qualified name, lowercased (e.g. `opf:meta`). */
  name: string
  /** Local part without namespace prefix (e.g. `meta`). */
  localName: string
  /** Attributes keyed by qualified name (original case) and by local name. */
  attributes: Record<string, string>
  selfClosing: boolean
}

export interface XmlEvents {
  onStart?: (element: XmlStartElement) => void
  /** Fired for explicit end tags and for self-closing elements. */
  onEnd?: (name: string, localName: string) => void
  /** Text or CDATA content, entities already decoded. */
  onText?: (text: string) => void
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (match, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code >= 0 ? String.fromCodePoint(code) : match
    }
    switch (body) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      default:
        return match // unknown entity: pass through untouched
    }
  })
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g
  let match
  while ((match = re.exec(source)) !== null) {
    const value = decodeEntities(match[3] ?? match[4] ?? '')
    attributes[match[1]!] = value
    const colon = match[1]!.indexOf(':')
    if (colon !== -1) attributes[match[1]!.slice(colon + 1)] = value
  }
  return attributes
}

export function scanXml(xml: string, events: XmlEvents): void {
  let i = 0
  const length = xml.length

  while (i < length) {
    const lt = xml.indexOf('<', i)
    if (lt === -1) {
      events.onText?.(decodeEntities(xml.slice(i)))
      break
    }
    if (lt > i) events.onText?.(decodeEntities(xml.slice(i, lt)))

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4)
      i = end === -1 ? length : end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9)
      const text = end === -1 ? xml.slice(lt + 9) : xml.slice(lt + 9, end)
      events.onText?.(text)
      i = end === -1 ? length : end + 3
      continue
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      // Processing instruction or DOCTYPE — skip.
      const end = xml.indexOf('>', lt + 2)
      i = end === -1 ? length : end + 1
      continue
    }

    const gt = xml.indexOf('>', lt + 1)
    if (gt === -1) break // unterminated tag: stop, keep what we have
    const raw = xml.slice(lt + 1, gt)
    i = gt + 1

    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim().toLowerCase()
      const colon = name.indexOf(':')
      events.onEnd?.(name, colon === -1 ? name : name.slice(colon + 1))
      continue
    }

    const selfClosing = raw.endsWith('/')
    const body = selfClosing ? raw.slice(0, -1) : raw
    const space = body.search(/[\s]/)
    const name = (space === -1 ? body : body.slice(0, space)).toLowerCase()
    if (!name) continue
    const colon = name.indexOf(':')
    const localName = colon === -1 ? name : name.slice(colon + 1)
    events.onStart?.({
      name,
      localName,
      attributes: space === -1 ? {} : parseAttributes(body.slice(space + 1)),
      selfClosing,
    })
    if (selfClosing) events.onEnd?.(name, localName)
  }
}

/** Collects the concatenated text content of the current element. */
export function textCollector(): {
  onText: (text: string) => void
  value: () => string
} {
  let buffer = ''
  return {
    onText: (text) => {
      buffer += text
    },
    value: () => buffer.trim(),
  }
}
