export type QName={prefix:string;local:string;uri:string};
export class NamespaceStack{#frames:Record<string,string>[]=[{}];start(declarations:Record<string,string>){this.#frames.push({...this.#frames.at(-1),...declarations})}end(){if(this.#frames.length>1)this.#frames.pop()}resolve(name:string,attribute=false):QName{const [prefix='',local=name]=name.includes(':')?name.split(':',2):['',name];const uri=this.#frames.at(-1)?.[prefix]??'';return {prefix,local,uri:attribute?uri:uri}}}

export type XmlEvent =
  | { type: 'text'; text: string; cdata: boolean }
  | { type: 'cdataStart' }
  | { type: 'cdataEnd' }
  | { type: 'startTag'; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { type: 'endTag'; name: string }
  | { type: 'comment'; text: string }
  | { type: 'pi'; target: string; data: string }
  | { type: 'error'; message: string };

type State = 'text' | 'cdata' | 'tag';
type TagKind = 'start' | 'end' | 'pi' | 'comment' | 'decl';

const CDATA_OPEN = '<![CDATA[';
const COMMENT_OPEN = '<!--';

/**
 * Streaming XML parser fed with arbitrary byte/string chunks.
 *
 * CDATA termination uses a KMP-style candidate automaton: while scanning
 * character data the parser holds back only the shortest suffix that can
 * still grow into the terminator "]]>" (never more than two ']'), across
 * chunk boundaries. A failed candidate is released into the text buffer in
 * its original order before the current character is reprocessed, so no
 * input byte is ever lost or reordered. The same automaton runs in normal
 * text, but there a completed "]]>" is a well-formedness error (XML spec
 * 2.4) instead of a terminator — CDATA tolerance is not reused.
 */
export class XmlStreamParser {
  #emit: (event: XmlEvent) => void;
  #rest: Uint8Array = new Uint8Array(0); // bytes of an incomplete UTF-8 sequence
  #state: State = 'text';
  #textBuf = '';
  #brackets: 0 | 1 | 2 = 0;
  #tagBuf = '';
  #tagKind: TagKind | null = null;
  #quote: string | null = null;
  #declDepth = 0;
  #elements: string[] = [];
  #ended = false;

  constructor(onEvent: (event: XmlEvent) => void) {
    this.#emit = onEvent;
  }

  write(chunk: Uint8Array | string): this {
    if (this.#ended) throw new Error('write() after end(); call reset() to reuse the parser');
    const s = typeof chunk === 'string' ? chunk : this.#decodeChunk(chunk);
    for (const ch of s) this.#step(ch);
    this.#flushText();
    return this;
  }

  end(): this {
    if (this.#ended) return this;
    this.#ended = true;
    if (this.#rest.length > 0) {
      this.#rest = new Uint8Array(0);
      this.#error('truncated UTF-8 sequence at end of input');
    }
    if (this.#state === 'cdata') {
      this.#releaseBrackets();
      this.#flushText();
      this.#error('unclosed CDATA section');
    } else if (this.#state === 'tag') {
      this.#error(`unclosed tag '${this.#tagBuf}'`);
    } else {
      this.#releaseBrackets();
      this.#flushText();
    }
    if (this.#elements.length > 0) {
      this.#error(`unclosed element(s): ${this.#elements.join(', ')}`);
      this.#elements = [];
    }
    return this;
  }

  reset(): this {
    this.#rest = new Uint8Array(0);
    this.#state = 'text';
    this.#textBuf = '';
    this.#brackets = 0;
    this.#tagBuf = '';
    this.#tagKind = null;
    this.#quote = null;
    this.#declDepth = 0;
    this.#elements = [];
    this.#ended = false;
    return this;
  }

  /**
   * Incremental UTF-8 decoding. Bytes of a sequence split across chunks are
   * kept in #rest until complete. An invalid byte costs only that byte: it is
   * reported once per write() and skipped, so valid input around it survives.
   */
  #decodeChunk(chunk: Uint8Array): string {
    const buf = new Uint8Array(this.#rest.length + chunk.length);
    buf.set(this.#rest);
    buf.set(chunk, this.#rest.length);
    let s = '';
    let i = 0;
    let reported = false;
    const invalid = () => {
      if (!reported) {
        this.#error('invalid UTF-8 sequence');
        reported = true;
      }
    };
    while (i < buf.length) {
      const b0 = buf[i];
      if (b0 < 0x80) {
        s += String.fromCharCode(b0);
        i++;
        continue;
      }
      let len: number, cp: number, min: number;
      if (b0 >= 0xc2 && b0 <= 0xdf) {
        len = 2;
        cp = b0 & 0x1f;
        min = 0x80;
      } else if (b0 >= 0xe0 && b0 <= 0xef) {
        len = 3;
        cp = b0 & 0x0f;
        min = 0x800;
      } else if (b0 >= 0xf0 && b0 <= 0xf4) {
        len = 4;
        cp = b0 & 0x07;
        min = 0x10000;
      } else {
        invalid(); // stray continuation byte or overlong lead
        i++;
        continue;
      }
      if (i + len > buf.length) break; // incomplete: wait for more bytes
      let ok = true;
      for (let k = 1; k < len; k++) {
        const bk = buf[i + k];
        if (bk < 0x80 || bk > 0xbf) {
          ok = false;
          break;
        }
        cp = (cp << 6) | (bk & 0x3f);
      }
      if (!ok || cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
        invalid();
        i++; // skip only the lead byte; the rest is re-examined
        continue;
      }
      s += String.fromCodePoint(cp);
      i += len;
    }
    this.#rest = buf.slice(i);
    return s;
  }

  #step(ch: string): void {
    if (this.#state === 'tag') {
      this.#stepTag(ch);
      return;
    }
    if (this.#brackets > 0) {
      this.#stepBracket(ch);
      return;
    }
    if (ch === ']') {
      this.#brackets = 1;
      return;
    }
    if (this.#state === 'cdata') {
      this.#textBuf += ch;
      return;
    }
    if (ch === '<') {
      this.#flushText();
      this.#openTag();
      return;
    }
    this.#textBuf += ch;
  }

  // A ']'-candidate of length #brackets is held back; decide its fate.
  #stepBracket(ch: string): void {
    if (ch === ']') {
      // Keep only the shortest suffix that can still start "]]>": once a
      // third ']' arrives the oldest one is confirmed plain text.
      if (this.#brackets === 2) this.#textBuf += ']';
      else this.#brackets = 2;
      return;
    }
    if (ch === '>' && this.#brackets === 2) {
      this.#brackets = 0;
      if (this.#state === 'cdata') this.#closeCdata();
      else this.#error(`']]>' is not allowed in character data`);
      return;
    }
    // Candidate failed: release the held brackets in original order, then
    // reprocess the current character as ordinary input.
    this.#releaseBrackets();
    this.#step(ch);
  }

  #releaseBrackets(): void {
    if (this.#brackets > 0) {
      this.#textBuf += ']'.repeat(this.#brackets);
      this.#brackets = 0;
    }
  }

  #closeCdata(): void {
    this.#flushText(); // still in 'cdata' state, so the event is flagged cdata
    this.#state = 'text';
    this.#emit({ type: 'cdataEnd' });
  }

  #openTag(): void {
    this.#state = 'tag';
    this.#tagBuf = '<';
    this.#tagKind = null;
    this.#quote = null;
    this.#declDepth = 0;
  }

  #stepTag(ch: string): void {
    if (this.#tagKind === null) {
      this.#tagBuf += ch;
      const kind = this.#classify();
      if (kind === null) return; // opener may be split across chunks
      if (kind === 'error') {
        this.#error(`invalid markup '${this.#tagBuf}'`);
        this.#state = 'text';
        this.#tagBuf = '';
        return;
      }
      if (kind === 'cdata') {
        this.#state = 'cdata';
        this.#tagBuf = '';
        this.#emit({ type: 'cdataStart' });
        return;
      }
      this.#tagKind = kind;
      return;
    }
    const kind = this.#tagKind;
    if (kind === 'comment') {
      this.#tagBuf += ch;
      if (this.#tagBuf.endsWith('-->')) this.#finishTag();
      return;
    }
    if (kind === 'pi') {
      this.#tagBuf += ch;
      if (this.#tagBuf.endsWith('?>')) this.#finishTag();
      return;
    }
    // start / end / decl: quotes protect '>', '<' is never legal here
    if (this.#quote !== null) {
      this.#tagBuf += ch;
      if (ch === this.#quote) this.#quote = null;
      return;
    }
    if (ch === '"' || ch === "'") {
      this.#quote = ch;
      this.#tagBuf += ch;
      return;
    }
    if (ch === '<') {
      this.#error(`unexpected '<' in tag '${this.#tagBuf}'`);
      this.#openTag(); // recover: treat '<' as the start of a fresh tag
      return;
    }
    this.#tagBuf += ch;
    if (kind === 'decl') {
      if (ch === '[') this.#declDepth++;
      else if (ch === ']') this.#declDepth = Math.max(0, this.#declDepth - 1);
      if (ch === '>' && this.#declDepth === 0) this.#finishTag();
      return;
    }
    if (ch === '>') this.#finishTag();
  }

  #classify(): TagKind | 'cdata' | 'error' | null {
    const b = this.#tagBuf;
    const c = b[1];
    if (c === undefined) return null;
    if (c === '?') return 'pi';
    if (c === '/') return 'end';
    if (c === '!') {
      if (b.length < COMMENT_OPEN.length && COMMENT_OPEN.startsWith(b)) return null;
      if (b.startsWith(COMMENT_OPEN)) return 'comment';
      if (b.length < CDATA_OPEN.length && CDATA_OPEN.startsWith(b)) return null;
      if (b.startsWith(CDATA_OPEN)) return 'cdata';
      return 'decl';
    }
    if (/[A-Za-z_]/.test(c)) return 'start';
    return 'error';
  }

  #finishTag(): void {
    const raw = this.#tagBuf;
    const kind = this.#tagKind;
    this.#state = 'text';
    this.#tagBuf = '';
    this.#tagKind = null;
    if (kind === 'comment') {
      this.#emit({ type: 'comment', text: raw.slice(COMMENT_OPEN.length, -3) });
      return;
    }
    if (kind === 'pi') {
      const m = /^(\S+)([\s\S]*)$/.exec(raw.slice(2, -2));
      if (m) this.#emit({ type: 'pi', target: m[1], data: m[2].replace(/^\s+/, '') });
      else this.#error(`malformed processing instruction '${raw}'`);
      return;
    }
    if (kind === 'decl') return; // DOCTYPE and friends: consumed, not reported
    this.#parseTag(raw, kind === 'end');
  }

  #parseTag(raw: string, isEnd: boolean): void {
    let i = isEnd ? 2 : 1;
    const skipWs = () => {
      while (i < raw.length && /\s/.test(raw[i])) i++;
    };
    skipWs();
    const nameStart = i;
    while (i < raw.length && !/[\s/>=]/.test(raw[i])) i++;
    const name = raw.slice(nameStart, i);
    if (!name) {
      this.#error(`malformed tag '${raw}'`);
      return;
    }
    if (isEnd) {
      skipWs();
      if (raw[i] !== '>') {
        this.#error(`junk in end tag '${raw}'`);
        return;
      }
      this.#handleEndTag(name);
      return;
    }
    const attrs: Record<string, string> = {};
    let selfClosing = false;
    for (;;) {
      skipWs();
      const c = raw[i];
      if (c === '>') break;
      if (c === '/') {
        if (raw[i + 1] === '>') {
          selfClosing = true;
          break;
        }
        this.#error(`malformed tag '${raw}'`);
        return;
      }
      if (c === undefined) {
        this.#error(`malformed tag '${raw}'`);
        return;
      }
      const attrStart = i;
      while (i < raw.length && !/[\s=/>]/.test(raw[i])) i++;
      const attrName = raw.slice(attrStart, i);
      if (!attrName) {
        this.#error(`malformed attribute in tag '${raw}'`);
        return;
      }
      skipWs();
      if (raw[i] !== '=') {
        this.#error(`attribute '${attrName}' in tag '${raw}' has no value`);
        return;
      }
      i++;
      skipWs();
      const q = raw[i];
      if (q !== '"' && q !== "'") {
        this.#error(`unquoted value for attribute '${attrName}'`);
        return;
      }
      const close = raw.indexOf(q, i + 1);
      if (close === -1) {
        this.#error(`unterminated value for attribute '${attrName}'`);
        return;
      }
      attrs[attrName] = raw.slice(i + 1, close);
      i = close + 1;
    }
    this.#handleStartTag(name, attrs, selfClosing);
  }

  #handleStartTag(name: string, attrs: Record<string, string>, selfClosing: boolean): void {
    this.#emit({ type: 'startTag', name, attrs, selfClosing });
    if (!selfClosing) this.#elements.push(name);
  }

  #handleEndTag(name: string): void {
    const top = this.#elements.at(-1);
    if (top === name) {
      this.#elements.pop();
      this.#emit({ type: 'endTag', name });
      return;
    }
    if (top === undefined) {
      this.#error(`unexpected end tag '</${name}>' with no open element`);
      return;
    }
    // Recovery: keep the stack, drop the stray end tag.
    this.#error(`mismatched end tag '</${name}>', expected '</${top}>'`);
  }

  #flushText(): void {
    if (!this.#textBuf) return;
    this.#emit({ type: 'text', text: this.#textBuf, cdata: this.#state === 'cdata' });
    this.#textBuf = '';
  }

  #error(message: string): void {
    this.#emit({ type: 'error', message });
  }
}
