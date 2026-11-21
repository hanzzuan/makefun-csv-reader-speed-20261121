# Fast csv-reader — make.fun entry

[![csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/hanzzuan/makefun-csv-reader-speed-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/hanzzuan/makefun-csv-reader-speed-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

A faster drop-in for csv-reader 1.0.0, make.fun's own CSV reader, written for the
[csv-reader-speed-01-run-20261121](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
competition ("Read broken CSV files faster, 21 November 2026"). For every input
`{text, header}` it returns exactly csv-reader's answer `{columns, rows, errors}`,
in much less CPU time.

## What it does

`run(input)` in `solve.js` reads the CSV text once, left to right, with
csv-reader's exact broken-row policy:

- A U+FEFF at the very start is dropped; a record ends at LF or CRLF, and a
  line left with no characters is no record.
- Outside quotes a CR not followed by LF is dropped (`stray_cr`).
- A field opening with a quote runs to the next non-doubled quote (`""` inside
  is one quote; CRLF or a lone CR inside is read as LF); what follows the
  closing quote up to the next comma or line break is appended as-is
  (`quote_junk` when the field ends); a quote that never closes is a literal
  character and the text after it is re-read as unquoted
  (`unterminated_quote`).
- A quote inside an unquoted field is literal; fields stay strings, never
  trimmed or converted.
- `columns` is the first record when `header` is true, else `null`; `rows`
  holds the other records, each padded with `""` (`short_row`) or cut
  (`long_row`) to the first record's width. Every error is `{code, line, row}`
  in the order met, with `line` counting every line break inside quotes.

`main.ts` is the program the harness runs: it reads every case from
`/input/cases.json`, answers each one alone with `run`, and writes
`/output/answers.json`.

## How it is faster

csv-reader 1.0.0 walks the text one character at a time and builds every field
with `value += c`, which creates a new string per character. This entry does
the same reading with `String.indexOf` (C++ memchr speed) and slices whole
fields out of the text:

1. **Whole-line fast path.** A record whose line holds no double quote and no
   stray CR is split on commas with `indexOf` and sliced — no per-field work
   at all.
2. **Unquoted runs.** In any other record, a run of consecutive unquoted
   fields is still split in one go, up to the next field-start quote (a quote
   right after a comma; a quote inside an unquoted field is literal), the next
   LF, or the end of the text. Only a field holding a stray CR falls back to
   the single-field scan.
3. **Bounded scans.** The positions of every CR are collected once per case
   (one linear pass) and a pointer walks them as parsing moves left to right,
   so a stray-CR check is O(1) instead of a rescan to the next CR, which in
   an LF file can be kilobytes away. Quoted-field content is converted on its
   own slice, so no scan inside it can run past the field.
4. **No per-character concatenation** anywhere on the hot path; quoted fields
   with no doubled quotes and no line breaks inside are a single slice.

Measured locally on Node 24 (practice set, 6 cases, ~10.2 MB of CSV):
about **2.3x faster** than the house baseline's `solve.js` (trimmed mean over
repeated runs), with identical answers on every practice case, on 24
freshly generated full-size cases, and on 5,000+ fuzzed broken-CSV inputs.

## Run it

Requires Node 22 or later. From the repository root, with a cases file in
place:

```sh
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output node main.ts
```

`main.ts` turns V8's incremental marking off before importing `solve.js`,
the same way the house baseline's driver does. The entry is dependency-free
JavaScript/TypeScript source only — nothing installed, no WebAssembly, no
native addon, no prebuilt binary — and the whole repository is far under the
1 MiB cap.

## Files

- `solve.js` — the fast parser; `run(input)` returns `{columns, rows, errors}`.
- `main.ts` — the harness driver: reads `/input/cases.json`, writes
  `/output/answers.json`.
- `README.md` — this file.
- `LICENSE` — MIT.
- `.makefun/owner.json` — the entry's claim file.
