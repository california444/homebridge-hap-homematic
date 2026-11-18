/**
 * Tiny, focused XML-RPC parser/serializer.
 *
 * We use this only inside the EventServer so we can audit every line of
 * XML handling — a blanket dependency on a generic XML parser broadens
 * the attack surface for a process that listens on the LAN. The parser
 * supports the subset the CCU uses: methodCall, methodResponse,
 * params/param/value, and the value types int/i4/double/boolean/string/
 * dateTime.iso8601/base64/array/struct.
 *
 * It deliberately does NOT support entities or external DOCTYPEs (XXE
 * attacks are otherwise trivially exploitable on a LAN service).
 */

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  apos: "'",
  quot: '"',
};

export interface ParsedCall {
  method: string;
  params: unknown[];
}

class Cursor {
  constructor(
    public src: string,
    public i = 0,
  ) {}
  rest(): string {
    return this.src.slice(this.i);
  }
  skipWhitespace(): void {
    while (this.i < this.src.length && /\s/.test(this.src[this.i] ?? '')) {
      this.i++;
    }
  }
  skipDeclarations(): void {
    // <?xml …?>, <!DOCTYPE …>, comments
    while (true) {
      this.skipWhitespace();
      if (this.src.startsWith('<?xml', this.i)) {
        const end = this.src.indexOf('?>', this.i);
        if (end === -1) {
          throw new Error('Unterminated XML declaration');
        }
        this.i = end + 2;
        continue;
      }
      if (this.src.startsWith('<!--', this.i)) {
        const end = this.src.indexOf('-->', this.i);
        if (end === -1) {
          throw new Error('Unterminated comment');
        }
        this.i = end + 3;
        continue;
      }
      if (this.src.startsWith('<!', this.i)) {
        // Reject DOCTYPE outright to prevent XXE.
        throw new Error('DOCTYPE / DTD not allowed');
      }
      return;
    }
  }
  expect(token: string): void {
    if (!this.src.startsWith(token, this.i)) {
      throw new Error(`Expected ${token} at offset ${this.i}`);
    }
    this.i += token.length;
  }
  consumeText(until: string): string {
    const idx = this.src.indexOf(until, this.i);
    if (idx === -1) {
      throw new Error(`Expected ${until}`);
    }
    const text = this.src.slice(this.i, idx);
    this.i = idx;
    return text;
  }
  peekTag(): string {
    this.skipWhitespace();
    if (this.src[this.i] !== '<') {
      throw new Error(`Expected '<' at offset ${this.i}`);
    }
    const close = this.src.indexOf('>', this.i);
    if (close === -1) {
      throw new Error('Unterminated tag');
    }
    let tag = this.src
      .slice(this.i + 1, close)
      .trim()
      .split(/\s+/)[0]!;
    if (tag.endsWith('/')) {
      tag = tag.slice(0, -1);
    }
    return tag;
  }
  /** Match a self-closing tag like <nil/>. Returns true if matched. */
  trySelfClosing(name: string): boolean {
    this.skipWhitespace();
    if (this.src.startsWith(`<${name}/>`, this.i)) {
      this.i += name.length + 3;
      return true;
    }
    return false;
  }
  openTag(name: string): void {
    this.skipWhitespace();
    this.expect(`<${name}>`);
  }
  closeTag(name: string): void {
    this.skipWhitespace();
    this.expect(`</${name}>`);
  }
  /** Try to open `<name>` — return true if matched, false otherwise. */
  tryOpenTag(name: string): boolean {
    this.skipWhitespace();
    if (this.src.startsWith(`<${name}>`, this.i)) {
      this.i += name.length + 2;
      return true;
    }
    return false;
  }
  tryCloseTag(name: string): boolean {
    this.skipWhitespace();
    if (this.src.startsWith(`</${name}>`, this.i)) {
      this.i += name.length + 3;
      return true;
    }
    return false;
  }
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = parseInt(body.slice(2), 16);
      if (!Number.isFinite(code)) {
        return m;
      }
      return String.fromCodePoint(code);
    }
    if (body.startsWith('#')) {
      const code = parseInt(body.slice(1), 10);
      if (!Number.isFinite(code)) {
        return m;
      }
      return String.fromCodePoint(code);
    }
    const replacement = ENTITY_MAP[body];
    return replacement ?? m;
  });
}

function encodeEntities(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseValue(c: Cursor): unknown {
  c.openTag('value');
  c.skipWhitespace();

  // Untyped string fallback: <value>foo</value>
  if (c.src.startsWith('</value>', c.i)) {
    c.closeTag('value');
    return '';
  }
  if (c.src[c.i] !== '<') {
    const text = c.consumeText('</value>');
    c.closeTag('value');
    return decodeEntities(text);
  }

  const tag = c.peekTag();
  let result: unknown;
  switch (tag) {
    case 'string': {
      c.openTag('string');
      const text = c.consumeText('</string>');
      c.closeTag('string');
      result = decodeEntities(text);
      break;
    }
    case 'int':
    case 'i4': {
      c.openTag(tag);
      const text = c.consumeText(`</${tag}>`);
      c.closeTag(tag);
      const n = parseInt(text.trim(), 10);
      if (!Number.isFinite(n)) {
        throw new Error(`Invalid <${tag}> value`);
      }
      result = n;
      break;
    }
    case 'double': {
      c.openTag('double');
      const text = c.consumeText('</double>');
      c.closeTag('double');
      const n = parseFloat(text.trim());
      if (!Number.isFinite(n)) {
        throw new Error('Invalid <double> value');
      }
      result = n;
      break;
    }
    case 'boolean': {
      c.openTag('boolean');
      const text = c.consumeText('</boolean>');
      c.closeTag('boolean');
      result = text.trim() === '1';
      break;
    }
    case 'array': {
      c.openTag('array');
      c.openTag('data');
      const items: unknown[] = [];
      while (!c.tryCloseTag('data')) {
        items.push(parseValue(c));
      }
      c.closeTag('array');
      result = items;
      break;
    }
    case 'struct': {
      c.openTag('struct');
      const obj: Record<string, unknown> = {};
      while (!c.tryCloseTag('struct')) {
        c.openTag('member');
        c.openTag('name');
        const name = decodeEntities(c.consumeText('</name>'));
        c.closeTag('name');
        const v = parseValue(c);
        c.closeTag('member');
        obj[name] = v;
      }
      result = obj;
      break;
    }
    case 'base64': {
      c.openTag('base64');
      const text = c.consumeText('</base64>');
      c.closeTag('base64');
      result = Buffer.from(text.trim(), 'base64');
      break;
    }
    case 'dateTime.iso8601': {
      c.openTag('dateTime.iso8601');
      const text = c.consumeText('</dateTime.iso8601>');
      c.closeTag('dateTime.iso8601');
      result = text.trim();
      break;
    }
    case 'nil':
    case 'ex:nil': {
      if (!c.trySelfClosing(tag)) {
        c.openTag(tag);
        c.closeTag(tag);
      }
      result = null;
      break;
    }
    default:
      throw new Error(`Unsupported XML-RPC value type: ${tag}`);
  }
  c.closeTag('value');
  return result;
}

function parseParams(c: Cursor): unknown[] {
  if (!c.tryOpenTag('params')) {
    return [];
  }
  const out: unknown[] = [];
  while (c.tryOpenTag('param')) {
    out.push(parseValue(c));
    c.closeTag('param');
  }
  c.closeTag('params');
  return out;
}

export function parseXml(body: string): ParsedCall {
  const c = new Cursor(body);
  c.skipDeclarations();
  c.openTag('methodCall');
  c.openTag('methodName');
  const method = c.consumeText('</methodName>').trim();
  c.closeTag('methodName');
  const params = parseParams(c);
  c.closeTag('methodCall');
  return { method, params };
}

function serializeValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '<value><nil/></value>';
  }
  if (typeof value === 'boolean') {
    return `<value><boolean>${value ? '1' : '0'}</boolean></value>`;
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return `<value><i4>${value}</i4></value>`;
    }
    return `<value><double>${value}</double></value>`;
  }
  if (typeof value === 'string') {
    return `<value><string>${encodeEntities(value)}</string></value>`;
  }
  if (Array.isArray(value)) {
    return `<value><array><data>${value.map(serializeValue).join('')}</data></array></value>`;
  }
  if (Buffer.isBuffer(value)) {
    return `<value><base64>${value.toString('base64')}</base64></value>`;
  }
  if (typeof value === 'object') {
    const members = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `<member><name>${encodeEntities(k)}</name>${serializeValue(v)}</member>`)
      .join('');
    return `<value><struct>${members}</struct></value>`;
  }
  return '<value><string></string></value>';
}

export function serializeResponse(value: unknown): string {
  return `<?xml version="1.0"?><methodResponse><params><param>${serializeValue(value)}</param></params></methodResponse>`;
}

export function serializeFault(code: number, message: string): string {
  return (
    '<?xml version="1.0"?><methodResponse><fault>' +
    serializeValue({ faultCode: code, faultString: message }) +
    '</fault></methodResponse>'
  );
}
