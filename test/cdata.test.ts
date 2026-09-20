import {describe,expect,it} from 'vitest';
import {StreamParser,XmlErrorCode,XmlEvent} from '../src/index.js';

const parseAll=(chunks:(string|Uint8Array)[]):XmlEvent[]=>{
  const p=new StreamParser();
  const out:XmlEvent[]=[];
  for(const c of chunks)out.push(...p.write(c));
  out.push(...p.end());
  return out;
};
const texts=(events:XmlEvent[],cdata:boolean)=>events.filter(e=>e.type==='text'&&e.cdata===cdata).map(e=>(e as {data:string}).data).join('');
const cdataText=(events:XmlEvent[])=>texts(events,true);
const plainText=(events:XmlEvent[])=>texts(events,false);
const codes=(events:XmlEvent[]):XmlErrorCode[]=>events.filter(e=>e.type==='error').map(e=>(e as {code:XmlErrorCode}).code);
const textEvents=(events:XmlEvent[])=>events.filter(e=>e.type==='text')as {type:'text';data:string;cdata:boolean}[];
const bytes=(s:string)=>new TextEncoder().encode(s);
// Text events may merge, but never across a CDATA boundary: two adjacent
// plain-text events must never occur.
const expectBoundaries=(events:XmlEvent[])=>{
  for(let i=1;i<events.length;i++){
    const a=events[i-1],b=events[i];
    if(a.type==='text'&&b.type==='text')expect(a.cdata||b.cdata,'adjacent plain-text events').toBe(true);
  }
};

describe('CDATA terminator chunking',()=>{
  const doc='<r a="1">t<![CDATA[x]y]]z]]>u</r>';
  const baseline=parseAll([doc]);

  it('parses the baseline document',()=>{
    expect(codes(baseline)).toEqual([]);
    expect(cdataText(baseline)).toBe('x]y]]z');
    expect(plainText(baseline)).toBe('tu');
  });

  it('is insensitive to every two-chunk split',()=>{
    for(let i=0;i<=doc.length;i++)
      expect(parseAll([doc.slice(0,i),doc.slice(i)]),`split at ${i}`).toEqual(baseline);
  });

  it('is insensitive to every three-chunk split',()=>{
    for(let i=0;i<=doc.length;i++)
      for(let j=i;j<=doc.length;j++)
        expect(parseAll([doc.slice(0,i),doc.slice(i,j),doc.slice(j)]),`split at ${i},${j}`).toEqual(baseline);
  });

  it('is insensitive to byte-by-byte feeding',()=>{
    expect(parseAll([...doc])).toEqual(baseline);
  });

  it('handles every split of the terminator itself',()=>{
    const head='<r><![CDATA[data',tail='</r>';
    for(const pieces of [[']]>'],[']]','>'],[']',']>'],[']',']','>'],[']]','>'],['',']]>','']]){
      const events=parseAll([head,...pieces,tail]);
      expect(codes(events)).toEqual([]);
      expect(cdataText(events)).toBe('data');
      expect(textEvents(events).filter(e=>e.cdata)).toHaveLength(1);
    }
  });

  it('spits a failed candidate back across a chunk boundary',()=>{
    // The ']]' candidate is held across the two writes, then fails on 'b'.
    const events=parseAll(['<r><![CDATA[a]',']b]]></r>']);
    expect(codes(events)).toEqual([]);
    expect(cdataText(events)).toBe('a]]b');
  });
});

describe('CDATA content edge cases',()=>{
  it('empty CDATA',()=>{
    const events=parseAll(['<r><![CDATA[]]></r>']);
    expect(codes(events)).toEqual([]);
    expect(textEvents(events)).toEqual([{type:'text',data:'',cdata:true}]);
    expect(cdataText(events)).toBe('');
    expect(parseAll([...'<r><![CDATA[]]></r>'])).toEqual(events);
  });

  it.each([
    [']','<![CDATA[]]]>'],
    [']]','<![CDATA[]]]]>'],
    [']]]','<![CDATA[]]]]]>'],
    [']>','<![CDATA[]>]]>'],
    [']] ','<![CDATA[]] ]]>'],
    ['a]b]]c]','<![CDATA[a]b]]c]]]>'],
    ['x]','<![CDATA[x]]]>'],
  ])('consecutive right brackets, inner %j',(inner,doc)=>{
    const events=parseAll([doc]);
    expect(codes(events)).toEqual([]);
    expect(cdataText(events)).toBe(inner);
    expect(parseAll([...doc])).toEqual(events);
  });

  it('adjacent CDATA sections stay separate events',()=>{
    const events=parseAll(['<r><![CDATA[a]]><![CDATA[b]]><![CDATA[]]></r>']);
    expect(codes(events)).toEqual([]);
    expect(textEvents(events)).toEqual([
      {type:'text',data:'a',cdata:true},
      {type:'text',data:'b',cdata:true},
      {type:'text',data:'',cdata:true},
    ]);
    expect(cdataText(events)).toBe('ab');
  });

  it('text events never cross a CDATA boundary',()=>{
    const events=parseAll(['x<![CDATA[a]]>y<![CDATA[b]]>z']);
    expect(codes(events)).toEqual([]);
    expect(textEvents(events)).toEqual([
      {type:'text',data:'x',cdata:false},
      {type:'text',data:'a',cdata:true},
      {type:'text',data:'y',cdata:false},
      {type:'text',data:'b',cdata:true},
      {type:'text',data:'z',cdata:false},
    ]);
  });

  it('merges text within one mode across writes',()=>{
    expect(textEvents(parseAll(['he','ll','o']))).toEqual([{type:'text',data:'hello',cdata:false}]);
    expect(textEvents(parseAll(['<![CDATA[he','ll','o]]>']))).toEqual([{type:'text',data:'hello',cdata:true}]);
  });

  it('passes markup characters through untouched',()=>{
    const inner='<a href="x">&amp; ]> ';
    const events=parseAll([`<![CDATA[${inner}]]>`]);
    expect(codes(events)).toEqual([]);
    expect(cdataText(events)).toBe(inner);
  });
});

describe('UTF-8 chunking',()=>{
  const doc='<r>é<![CDATA[中🙂]é]]>🙂</r>';
  const raw=bytes(doc);
  const baseline=parseAll([raw]);

  it('parses the baseline document',()=>{
    expect(codes(baseline)).toEqual([]);
    expect(cdataText(baseline)).toBe('中🙂]é');
    expect(plainText(baseline)).toBe('é🙂');
  });

  it('is insensitive to every byte split',()=>{
    for(let i=0;i<=raw.length;i++)
      expect(parseAll([raw.slice(0,i),raw.slice(i)]),`split at byte ${i}`).toEqual(baseline);
  });

  it('is insensitive to byte-by-byte feeding',()=>{
    expect(parseAll([...raw].map(b=>new Uint8Array([b])))).toEqual(baseline);
  });

  it('concatenated CDATA text is byte-identical to the section content',()=>{
    expect(bytes(cdataText(baseline))).toEqual(bytes('中🙂]é'));
  });

  it('reports truncated UTF-8 at EOF and recovers',()=>{
    const é=bytes('<r>é');
    const events=parseAll([é.slice(0,é.length-1)]);
    expect(codes(events)).toContain('truncated-utf8');
    expect(codes(events)).toContain('unclosed-element');
    expect(events.some(e=>e.type==='end'&&e.name==='r')).toBe(true);
  });
});

describe('EOF handling',()=>{
  it('unclosed CDATA flushes its content and reports',()=>{
    const events=parseAll(['<r><![CDATA[abc']);
    expect(codes(events)).toEqual(['unclosed-cdata','unclosed-element']);
    expect(cdataText(events)).toBe('abc');
    expect(events.at(-1)).toMatchObject({type:'end',name:'r'});
  });

  it.each([
    ['<r><![CDATA[ab]','ab]'],
    ['<r><![CDATA[ab]]','ab]]'],
    ['<r><![CDATA[',''],
    ['<r><![CDATA[]',']'],
    ['<r><![CDATA[]]',']]'],
  ])('held terminator candidate returns as content at EOF: %s',(doc,inner)=>{
    const events=parseAll([doc]);
    expect(codes(events)).toContain('unclosed-cdata');
    expect(cdataText(events)).toBe(inner);
  });

  it('closed CDATA but unclosed element at EOF',()=>{
    const events=parseAll(['<r><![CDATA[ab]]>']);
    expect(codes(events)).toEqual(['unclosed-element']);
    expect(cdataText(events)).toBe('ab');
    expect(events.at(-1)).toMatchObject({type:'end',name:'r'});
  });

  it('EOF inside a start tag',()=>{
    const events=parseAll(['<r><di']);
    expect(codes(events)).toEqual(['unexpected-eof','unclosed-element']);
    expect(events.some(e=>e.type==='start'&&e.name==='di')).toBe(false);
  });

  it('EOF after a lone <',()=>{
    const events=parseAll(['a<']);
    expect(codes(events)).toEqual(['unexpected-eof']);
    expect(plainText(events)).toBe('a<');
  });

  it('EOF inside comment and PI',()=>{
    expect(codes(parseAll(['<r><!-- x']))).toContain('unexpected-eof');
    expect(codes(parseAll(['<r><?pi d']))).toContain('unexpected-eof');
  });
});

describe('error recovery',()=>{
  it('reports ]]> in plain character data, split across chunks',()=>{
    const events=parseAll(['a]',']','>b<r/>']);
    expect(codes(events)).toEqual(['cdata-end-in-text']);
    expect(plainText(events)).toBe('a]]>b');
    expect(events.some(e=>e.type==='start'&&e.name==='r')).toBe(true);
  });

  it('does not reuse CDATA tolerance for plain text',()=>{
    const events=parseAll(['x]]><![CDATA[ok]]>']);
    expect(codes(events)).toEqual(['cdata-end-in-text']);
    expect(plainText(events)).toBe('x]]>');
    expect(cdataText(events)).toBe('ok');
  });

  it('recovers from mismatched end tags with implied closes',()=>{
    const events=parseAll(['<r><a></r>']);
    expect(codes(events)).toEqual(['mismatched-end-tag']);
    expect(events.filter(e=>e.type==='end').map(e=>(e as {name:string}).name)).toEqual(['a','r']);
  });

  it('ignores end tags with no matching start tag',()=>{
    const events=parseAll(['</nope><r/>']);
    expect(codes(events)).toEqual(['mismatched-end-tag']);
    expect(events.filter(e=>e.type==='start')).toHaveLength(1);
    expect(events.filter(e=>e.type==='end')).toHaveLength(1);
  });

  it('treats a stray < as text and continues',()=>{
    const events=parseAll(['< a><r/>']);
    expect(codes(events)).toEqual(['invalid-lt']);
    expect(plainText(events)).toBe('< a>');
    expect(events.some(e=>e.type==='start'&&e.name==='r')).toBe(true);
  });

  it('skips unknown <! declarations and continues',()=>{
    const events=parseAll(['<!bogus><!doctype html><r/>']);
    expect(codes(events)).toEqual(['unknown-markup','unknown-markup']);
    expect(events.some(e=>e.type==='start'&&e.name==='r')).toBe(true);
  });

  it('throws on write after end; end is idempotent',()=>{
    const p=new StreamParser();
    p.write('<r/>');
    p.end();
    expect(()=>p.write('x')).toThrow();
    expect(p.end()).toEqual([]);
  });
});

describe('chunk invariance on a mixed document',()=>{
  const doc='<?xml version="1.0"?><r a="x>y"><![CDATA[a]]>t1<!-- c --><![CDATA[]]]]><![CDATA[z]]>t2</r>';
  const baseline=parseAll([doc]);

  it('baseline events',()=>{
    expect(codes(baseline)).toEqual([]);
    expect(cdataText(baseline)).toBe('a]]z');
    expect(plainText(baseline)).toBe('t1t2');
    expect(baseline.find(e=>e.type==='start')).toMatchObject({name:'r',attributes:{a:'x>y'}});
    expect(baseline.find(e=>e.type==='comment')).toMatchObject({data:' c '});
    expect(baseline.find(e=>e.type==='pi')).toMatchObject({target:'xml'});
    expectBoundaries(baseline);
  });

  it('is insensitive to every two-chunk split',()=>{
    for(let i=0;i<=doc.length;i++){
      const events=parseAll([doc.slice(0,i),doc.slice(i)]);
      expect(events,`split at ${i}`).toEqual(baseline);
      expectBoundaries(events);
    }
  });

  it('is insensitive to every three-chunk split',()=>{
    for(let i=0;i<=doc.length;i++)
      for(let j=i;j<=doc.length;j++)
        expect(parseAll([doc.slice(0,i),doc.slice(i,j),doc.slice(j)]),`split at ${i},${j}`).toEqual(baseline);
  });

  it('concatenated CDATA text is byte-identical to the section contents',()=>{
    expect(bytes(cdataText(baseline))).toEqual(bytes('a]]z'));
  });
});
