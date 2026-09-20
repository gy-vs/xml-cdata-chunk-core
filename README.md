# XML stream core

TypeScript library for namespace-aware parsing.

Run `npm install`, then `npm test` and `npm run build`.

## XmlStreamParser

Streaming XML parser that accepts arbitrary `Uint8Array`/`string` chunks via
`write()` and emits events (`text` with a `cdata` flag, `cdataStart`,
`cdataEnd`, `startTag`, `endTag`, `comment`, `pi`, `error`) through a callback.
Call `end()` at EOF; `reset()` makes the instance reusable.

```ts
const p = new XmlStreamParser((e) => console.log(e));
p.write(new Uint8Array([0x3c, 0x72, 0x3e])); // "<r>"
p.write('<![CDATA[a]]');                      // terminator split across…
p.write(']>b</r>');                           // …chunk boundaries is fine
p.end();
```

- CDATA termination keeps only the shortest suffix that can still grow into
  `]]>` (at most two `]`), held across chunk boundaries; a failed candidate is
  released as text in original order, so no bracket is ever lost.
- Text events may be merged but never across a CDATA boundary; concatenating
  all `cdata: true` text events reproduces the marked-up content byte for byte.
- `]]>` in normal character data is reported as an error (XML 2.4); the parser
  recovers and keeps parsing. UTF-8 sequences may be split at any byte offset;
  invalid bytes are reported and skipped without losing the rest of the chunk.
