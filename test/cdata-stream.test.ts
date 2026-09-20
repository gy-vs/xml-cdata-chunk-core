import { describe, expect, it } from 'vitest';
import { XmlEvent, XmlStreamParser } from '../src/index.js';

function parse(chunks: (string | Uint8Array)[]): XmlEvent[] {
  const events: XmlEvent[] = [];
  const p = new XmlStreamParser((e) => events.push(e));
  for (const c of chunks) p.write(c);
  p.end();
  return events;
}

const texts = (events: XmlEvent[]) =>
  events.filter((e): e is Extract<XmlEvent, { type: 'text' }> => e.type === 'text');
const cdataText = (events: XmlEvent[]) =>
  texts(events)
    .filter((e) => e.cdata)
    .map((e) => e.text)
    .join('');
const plainText = (events: XmlEvent[]) =>
  texts(events)
    .filter((e) => !e.cdata)
    .map((e) => e.text)
    .join('');
const errors = (events: XmlEvent[]) =>
  events.filter((e): e is Extract<XmlEvent, { type: 'error' }> => e.type === 'error');
const ofType = <T extends XmlEvent['type']>(events: XmlEvent[], type: T) =>
  events.filter((e) => e.type === type);

/** All two-chunk splits of a string. */
function splits2(s: string): string[][] {
  const out: string[][] = [];
  for (let i = 0; i <= s.length; i++) out.push([s.slice(0, i), s.slice(i)]);
  return out;
}

/** All three-chunk splits of a string. */
function splits3(s: string): string[][] {
  const out: string[][] = [];
  for (let i = 0; i <= s.length; i++)
    for (let j = i; j <= s.length; j++) out.push([s.slice(0, i), s.slice(i, j), s.slice(j)]);
  return out;
}

/** All two-chunk splits at byte level (may cut through multi-byte UTF-8). */
function byteSplits2(s: string): Uint8Array[][] {
  const bytes = new TextEncoder().encode(s);
  const out: Uint8Array[][] = [];
  for (let i = 0; i <= bytes.length; i++) out.push([bytes.subarray(0, i), bytes.subarray(i)]);
  return out;
}

function expectBytesEqual(actual: string, expected: string) {
  expect([...new TextEncoder().encode(actual)]).toEqual([...new TextEncoder().encode(expected)]);
}

describe('CDATA terminator chunking', () => {
  const doc = (inner: string) => `<r><![CDATA[${inner}]]></r>`;

  it('ends the section only on a complete ]]>', () => {
    const events = parse(['<r><![CDATA[hello]]></r>']);
    expect(errors(events)).toEqual([]);
    expect(cdataText(events)).toBe('hello');
    expect(events.map((e) => e.type)).toEqual([
      'startTag',
      'cdataStart',
      'text',
      'cdataEnd',
      'endTag',
    ]);
  });

  it('survives every two-chunk split of the document', () => {
    const cases: Array<[string, string]> = [
      [doc('hello'), 'hello'],
      [doc(''), ''],
      [doc(']'), ']'],
      [doc('a]]]b'), 'a]]]b'],
      ['<r>a<![CDATA[x]]>b</r>', 'x'],
      ['<r><![CDATA[a]]><![CDATA[b]]></r>', 'ab'],
    ];
    for (const [document, inner] of cases) {
      for (const chunks of splits2(document)) {
        const events = parse(chunks);
        expect(errors(events), `chunks=${JSON.stringify(chunks)}`).toEqual([]);
        expect(cdataText(events), `chunks=${JSON.stringify(chunks)}`).toBe(inner);
      }
    }
  });

  it('survives every three-chunk split (terminator cut into 1+1+1)', () => {
    for (const chunks of splits3(doc('hi'))) {
      const events = parse(chunks);
      expect(errors(events), `chunks=${JSON.stringify(chunks)}`).toEqual([]);
      expect(cdataText(events), `chunks=${JSON.stringify(chunks)}`).toBe('hi');
    }
    for (const chunks of splits3(doc(']'))) {
      const events = parse(chunks);
      expect(errors(events), `chunks=${JSON.stringify(chunks)}`).toEqual([]);
      expect(cdataText(events), `chunks=${JSON.stringify(chunks)}`).toBe(']');
    }
  });

  it('handles the terminator arriving one character per write', () => {
    const events = parse(['<r><![CDATA[hello', ']', ']', '>', '</r>']);
    expect(errors(events)).toEqual([]);
    expect(cdataText(events)).toBe('hello');
  });

  it('handles the opener <![CDATA[ split across chunks', () => {
    for (const chunks of splits2('<r><![CDATA[x]]></r>')) {
      const events = parse(chunks);
      expect(errors(events), `chunks=${JSON.stringify(chunks)}`).toEqual([]);
      expect(cdataText(events)).toBe('x');
      expect(ofType(events, 'cdataStart')).toHaveLength(1);
      expect(ofType(events, 'cdataEnd')).toHaveLength(1);
    }
  });
});

describe('empty CDATA', () => {
  it('emits boundaries but no text for <![CDATA[]]>', () => {
    const events = parse(['<r><![CDATA[]]></r>']);
    expect(errors(events)).toEqual([]);
    expect(cdataText(events)).toBe('');
    expect(texts(events)).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(['startTag', 'cdataStart', 'cdataEnd', 'endTag']);
  });
});

describe('consecutive right brackets inside CDATA', () => {
  const cases: Array<[string, string]> = [
    ['<r><![CDATA[]]]></r>', ']'],
    ['<r><![CDATA[]]]]></r>', ']]'],
    ['<r><![CDATA[]]]]]></r>', ']]]'],
    ['<r><![CDATA[a]b]]></r>', 'a]b'],
    ['<r><![CDATA[a]]b]]></r>', 'a]]b'],
    ['<r><![CDATA[a]]]b]]></r>', 'a]]]b'],
    ['<r><![CDATA[a]>b]]></r>', 'a]>b'],
    ['<r><![CDATA[]>]]></r>', ']>'],
    ['<r><![CDATA[]>]]]></r>', ']>]'],
    ['<r><![CDATA[>]]></r>', '>'],
    ['<r><![CDATA[ ] ] ] ]]></r>', ' ] ] ] '],
  ];

  it('loses no character, whatever the bracket run', () => {
    for (const [document, inner] of cases) {
      const events = parse([document]);
      expect(errors(events), document).toEqual([]);
      expect(cdataText(events), document).toBe(inner);
    }
  });

  it('loses no character under every two-chunk split', () => {
    for (const [document, inner] of cases) {
      for (const chunks of splits2(document)) {
        const events = parse(chunks);
        expect(errors(events), `chunks=${JSON.stringify(chunks)}`).toEqual([]);
        expect(cdataText(events), `chunks=${JSON.stringify(chunks)}`).toBe(inner);
      }
    }
  });

  it('treats < and & as literal text inside CDATA', () => {
    const events = parse(['<r><![CDATA[a<b&c<![CDATA[]]></r>']);
    expect(errors(events)).toEqual([]);
    expect(cdataText(events)).toBe('a<b&c<![CDATA[');
    expect(ofType(events, 'startTag')).toHaveLength(1);
  });
});

describe('adjacent CDATA sections and text boundaries', () => {
  it('never merges text events across a CDATA boundary', () => {
    const events = parse(['<r>x<![CDATA[a]]>y<![CDATA[b]]>z</r>']);
    expect(errors(events)).toEqual([]);
    expect(texts(events)).toEqual([
      { type: 'text', text: 'x', cdata: false },
      { type: 'text', text: 'a', cdata: true },
      { type: 'text', text: 'y', cdata: false },
      { type: 'text', text: 'b', cdata: true },
      { type: 'text', text: 'z', cdata: false },
    ]);
  });

  it('keeps adjacent CDATA sections as separate events', () => {
    const events = parse(['<r><![CDATA[a]]><![CDATA[b]]><![CDATA[]]><![CDATA[c]]></r>']);
    expect(errors(events)).toEqual([]);
    expect(texts(events)).toEqual([
      { type: 'text', text: 'a', cdata: true },
      { type: 'text', text: 'b', cdata: true },
      { type: 'text', text: 'c', cdata: true },
    ]);
    expect(ofType(events, 'cdataStart')).toHaveLength(4);
    expect(ofType(events, 'cdataEnd')).toHaveLength(4);
  });

  it('flags every cdata text event strictly between cdataStart and cdataEnd', () => {
    const events = parse(['<r>t1<![CDATA[a]]>t2<![CDATA[b]]>t3</r>']);
    let inside = false;
    for (const e of events) {
      if (e.type === 'cdataStart') inside = true;
      else if (e.type === 'cdataEnd') inside = false;
      else if (e.type === 'text') expect(e.cdata).toBe(inside);
    }
  });
});

describe('UTF-8 chunking', () => {
  const inner = 'héllo—世界🙂]é';
  const document = `<r><![CDATA[${inner}]]></r>`;

  it('decodes multi-byte characters cut at every byte offset', () => {
    for (const chunks of byteSplits2(document)) {
      const events = parse(chunks);
      expect(errors(events)).toEqual([]);
      expect(cdataText(events)).toBe(inner);
      expectBytesEqual(cdataText(events), inner);
    }
  });

  it('decodes a 4-byte character fed one byte per write', () => {
    const bytes = new TextEncoder().encode(document);
    const events = parse([...bytes].map((b) => new Uint8Array([b])));
    expect(errors(events)).toEqual([]);
    expect(cdataText(events)).toBe(inner);
  });

  it('reports invalid UTF-8 and keeps parsing subsequent chunks', () => {
    const events: XmlEvent[] = [];
    const p = new XmlStreamParser((e) => events.push(e));
    p.write(new Uint8Array([0x3c, 0x72, 0x3e, 0xff, 0xfe])); // "<r>" + invalid bytes
    p.write('<![CDATA[ok]]></r>');
    p.end();
    expect(errors(events).map((e) => e.message)).toEqual(['invalid UTF-8 sequence']);
    expect(cdataText(events)).toBe('ok');
    expect(ofType(events, 'endTag')).toHaveLength(1);
  });
});

describe('EOF handling', () => {
  it('reports unclosed CDATA at EOF and still delivers the content', () => {
    const events = parse(['<r><![CDATA[abc']);
    expect(cdataText(events)).toBe('abc');
    expect(errors(events).map((e) => e.message)).toEqual([
      'unclosed CDATA section',
      'unclosed element(s): r',
    ]);
  });

  it('releases a dangling bracket candidate as text at EOF', () => {
    const events = parse(['<r><![CDATA[abc]]']);
    expect(cdataText(events)).toBe('abc]]');
    expect(errors(events).map((e) => e.message)).toContain('unclosed CDATA section');
  });

  it('reports an unclosed tag at EOF', () => {
    const events = parse(['<r><![CD']);
    expect(errors(events).map((e) => e.message)).toEqual([
      "unclosed tag '<![CD'",
      'unclosed element(s): r',
    ]);
  });

  it('reports unclosed elements at EOF', () => {
    const events = parse(['<a><b>text']);
    expect(plainText(events)).toBe('text');
    expect(errors(events).map((e) => e.message)).toEqual(['unclosed element(s): a, b']);
  });

  it('reports a truncated UTF-8 sequence at EOF', () => {
    const bytes = new TextEncoder().encode('<r>世');
    const events = parse([bytes.subarray(0, bytes.length - 1)]);
    expect(errors(events).map((e) => e.message)).toContain(
      'truncated UTF-8 sequence at end of input',
    );
  });

  it('emits trailing text and bracket candidates before EOF', () => {
    const events = parse(['<r>ab]]']);
    expect(plainText(events)).toBe('ab]]');
    expect(errors(events).map((e) => e.message)).toEqual(['unclosed element(s): r']);
  });
});

describe('error recovery', () => {
  it('reports ]]> in character data and keeps parsing', () => {
    const events = parse(['<r>a]]>b<![CDATA[ok]]></r>']);
    expect(errors(events).map((e) => e.message)).toEqual([
      `']]>' is not allowed in character data`,
    ]);
    expect(plainText(events)).toBe('ab');
    expect(cdataText(events)).toBe('ok');
    expect(ofType(events, 'endTag')).toEqual([{ type: 'endTag', name: 'r' }]);
  });

  it('detects ]]> in text even when split across chunks', () => {
    const events = parse(['<r>a]', ']', '>b</r>']);
    expect(errors(events).map((e) => e.message)).toEqual([
      `']]>' is not allowed in character data`,
    ]);
    expect(plainText(events)).toBe('ab');
  });

  it('does not flag ]]> inside attribute values, comments or PIs', () => {
    const events = parse(['<r a="]]>">x<!-- ]]> --><?p ]]>?></r>']);
    expect(errors(events)).toEqual([]);
    expect(ofType(events, 'startTag')).toEqual([
      { type: 'startTag', name: 'r', attrs: { a: ']]>' }, selfClosing: false },
    ]);
    expect(ofType(events, 'comment')).toEqual([{ type: 'comment', text: ' ]]> ' }]);
    expect(ofType(events, 'pi')).toEqual([{ type: 'pi', target: 'p', data: ']]>' }]);
  });

  it('allows ]> and ]] in plain text', () => {
    const events = parse(['<r>a]>b]]c]] </r>']);
    expect(errors(events)).toEqual([]);
    expect(plainText(events)).toBe('a]>b]]c]] ');
  });

  it('recovers from a stray < inside a tag', () => {
    const events = parse(['<r><a <b>text</b></r>']);
    expect(errors(events).map((e) => e.message)).toEqual(["unexpected '<' in tag '<a '"]);
    expect(ofType(events, 'startTag').map((e) => (e as { name: string }).name)).toEqual([
      'r',
      'b',
    ]);
    expect(plainText(events)).toBe('text');
  });

  it('recovers from mismatched and unexpected end tags', () => {
    const events = parse(['<a><b></a></b></a></r>']);
    expect(errors(events).map((e) => e.message)).toEqual([
      "mismatched end tag '</a>', expected '</b>'",
      "unexpected end tag '</r>' with no open element",
    ]);
    expect(ofType(events, 'endTag')).toEqual([
      { type: 'endTag', name: 'b' },
      { type: 'endTag', name: 'a' },
    ]);
  });

  it('reset() makes the parser reusable after a failed document', () => {
    const events: XmlEvent[] = [];
    const p = new XmlStreamParser((e) => events.push(e));
    p.write('<r><![CDATA[broken');
    p.end();
    expect(errors(events)).not.toEqual([]);

    events.length = 0;
    p.reset();
    p.write('<r><![CDATA[fixed]]></r>');
    p.end();
    expect(errors(events)).toEqual([]);
    expect(cdataText(events)).toBe('fixed');
  });

  it('rejects write() after end()', () => {
    const p = new XmlStreamParser(() => {});
    p.end();
    expect(() => p.write('<r/>')).toThrow(/after end/);
  });
});

describe('concatenation of CDATA text events equals the marked-up content byte for byte', () => {
  // Deterministic PRNG so failures reproduce.
  function mulberry32(seed: number) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const alphabet = [']', ']', '>', 'a', '<', '&', ' ', 'é', '世', '🙂', '\n'];
  const rand = mulberry32(0xc0ffee);

  function randomInner(maxLen: number): string {
    let s = '';
    for (;;) {
      s = '';
      const len = Math.floor(rand() * (maxLen + 1));
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
      if (!s.includes(']]>')) return s; // ']]>' cannot appear inside CDATA content
    }
  }

  function randomChunks(s: string): string[] {
    const points = new Set<number>();
    const n = Math.floor(rand() * 5);
    for (let i = 0; i < n; i++) points.add(Math.floor(rand() * (s.length + 1)));
    const cuts = [...points].sort((a, b) => a - b);
    const chunks: string[] = [];
    let prev = 0;
    for (const c of cuts) {
      chunks.push(s.slice(prev, c));
      prev = c;
    }
    chunks.push(s.slice(prev));
    return chunks;
  }

  it('holds for 500 random contents under random chunking', () => {
    for (let n = 0; n < 500; n++) {
      const inner = randomInner(24);
      const document = `<r><![CDATA[${inner}]]></r>`;
      const events = parse(randomChunks(document));
      expect(errors(events), `inner=${JSON.stringify(inner)}`).toEqual([]);
      expect(cdataText(events), `inner=${JSON.stringify(inner)}`).toBe(inner);
      expectBytesEqual(cdataText(events), inner);
    }
  });

  it('holds for random contents under random byte-level chunking', () => {
    for (let n = 0; n < 200; n++) {
      const inner = randomInner(16);
      const bytes = new TextEncoder().encode(`<r><![CDATA[${inner}]]></r>`);
      const cuts = new Set<number>();
      for (let i = 0; i < 4; i++) cuts.add(Math.floor(rand() * (bytes.length + 1)));
      const chunks: Uint8Array[] = [];
      let prev = 0;
      for (const cut of [...cuts].sort((a, b) => a - b)) {
        chunks.push(bytes.subarray(prev, cut));
        prev = cut;
      }
      chunks.push(bytes.subarray(prev));
      const events = parse(chunks);
      expect(errors(events), `inner=${JSON.stringify(inner)}`).toEqual([]);
      expect(cdataText(events), `inner=${JSON.stringify(inner)}`).toBe(inner);
      expectBytesEqual(cdataText(events), inner);
    }
  });
});
