# XML stream core

TypeScript library for namespace-aware streaming parsing.

## StreamParser

Incremental tokenizer. Feed input with `write(chunk)` (`string` or `Uint8Array`;
UTF-8 sequences may be split across chunks) and finish with `end()`. Both return
the events produced by that call:

- `start` / `end` — elements, with a namespace-resolved `qname`
- `text` — character data (`cdata: false`) or CDATA section content (`cdata: true`)
- `comment`, `pi`
- `error` — recoverable parse problem with a `code`; parsing continues

### CDATA sections

The CDATA state keeps only the shortest suffix that can still grow into the
`]]>` terminator, so the terminator may be split across any number of chunks.
A candidate that fails to complete is handed back as content in its original
order, and consecutive `]` characters in the body are preserved. Text events
are merged while possible but never across a CDATA boundary; concatenating all
`cdata: true` text events yields the exact byte content of the CDATA sections.
`]]>` in regular character data is reported as a `cdata-end-in-text` error —
the CDATA tolerance is not reused there.

### Errors and recovery

Unclosed constructs at EOF are flushed and reported (`unclosed-cdata`,
`unexpected-eof`, `unclosed-element`, `truncated-utf8`), mismatched end tags
close the intervening open elements, and a `<` that does not open markup is
treated as text (`invalid-lt`).

Limitations: no entity decoding (`&amp;` is passed through as-is), and `<!...>`
declarations other than comments and CDATA (e.g. DOCTYPE) are skipped up to the
next `>` (`unknown-markup`).

Run `npm install`, then `npm test` and `npm run build`.
