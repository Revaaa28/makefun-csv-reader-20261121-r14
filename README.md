# Fast drop-in for csv-reader 1.0.0 — round 14 (profiled rewrite)

[![Competition](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![Rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/Revaaa28/makefun-csv-reader-20261121-r14/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![Reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/Revaaa28/makefun-csv-reader-20261121-r14/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's csv-reader 1.0.0: `solve.js` exports `run(input)` returning
exactly csv-reader's `{columns, rows, errors}` for every input, and `main.ts` answers every
case in `/input/cases.json` with it into `/output/answers.json`.

This round is a rewrite driven by profiling the drawn corpus (~710k fields per set, average
13 chars, quote- and CR-dense by design):

- The whole-line fast path of the previous entry almost never fired on this corpus, so the
  field-by-field path is now the optimised one: every field is located with `indexOf` hops,
  substrings are materialised once at field ends, and no regular expression runs anywhere.
- A quoted span is classified before it is touched (the closing-quote search reports doubled
  quotes; lazy cursors report CR/LF inside): a clean span is a single slice, and only a span
  that truly needs rewriting pays a single manual rebuild pass.
- Lazy forward-only cursors for the next quote, CR and LF mean no stretch of text is ever
  re-scanned.

Verified locally against the kit's practice set (6/6 answers identical to the oracle) and
against the vendor csv-reader on 4,000 adversarial fuzz inputs (identical outputs).
