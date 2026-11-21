// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader): run(input) returns exactly
// readCsv's {columns, rows, errors} for every input {text, header}, but much faster.
//
// What the profiling of the previous entry showed on this competition's drawn corpus, and
// what this rewrite fixes:
//   1. The corpus is quote- and CR-dense by design, so a whole-line fast path almost never
//      fires (0 of 10,431 records on the heaviest practice case). The field-by-field path is
//      the hot path; it is written here as one tight segment scanner: every field is located
//      with indexOf hops (native, memchr-speed), substrings are materialised once at field
//      ends, and no regular expression runs anywhere.
//   2. The old quoted-field cleanup paid three extra passes per field (match + replace +
//      replaceAll). Here a quoted span is classified first (the closing-quote search already
//      reports whether it skipped a doubled quote; two cursor comparisons report CR / LF
//      inside): a span with no doubled quote and no CR is one slice; only a span that truly
//      needs rewriting gets a single manual rebuild pass that also counts its lines.
//   3. Persistent lazy cursors for the next '"', CR and LF mean no stretch of text is ever
//      re-scanned: each cursor only moves forward across the whole run.
//
// Semantics follow vendor/csv-reader/index.js (csv-reader 1.0.0) exactly:
//   - U+FEFF at the very start dropped; a line with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field opening with a quote runs to the next non-doubled quote, "" inside is one quote,
//     each CRLF or lone CR inside reads as LF; text after the closing quote up to the next comma
//     or line break is appended as-is (quote_junk, when the field ends); a quote that never
//     closes is a literal character and the text after it is re-read as unquoted
//     (unterminated_quote); a quote inside an unquoted field is literal;
//   - columns is the first record when header is true, else null; rows are the records after it,
//     each padded with "" (short_row, with fields: its count) or cut (long_row, with extra: the
//     cut fields) to the first record's width;
//   - each error is {code, line, row} in the order met, a record's short_row/long_row when it
//     ends: line the 1-based line its record starts on, counting every LF, CRLF and lone CR
//     inside quotes, row its record's index in rows, null for the header.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // Lazily kept cursors: the next '"' / CR / LF at or after the last place they were refreshed
  // for (-1: none left, -2: not yet looked). A cursor is refreshed only once it falls behind
  // the read position, so across a run each stretch of text is scanned by each cursor once.
  let nextQ = -2;
  let nextR = -2;
  let nextN = -2;

  // The record being read, for the errors it records.
  let recordLine = 1;
  let recordRow = null;

  // readUnquoted's results.
  let uVal = '';
  let uEnd = 0;
  // Reads unquoted characters onto `init` up to the next comma or line break, starting at
  // `start`: a CR not followed by LF is dropped (stray_cr). Sets uVal/uEnd, pos and line.
  function readUnquoted(init, start) {
    let val = init;
    let cur = start;
    for (;;) {
      const ci = text.indexOf(',', cur);
      const ni = text.indexOf('\n', cur);
      if (nextR !== -1 && nextR < cur) nextR = text.indexOf('\r', cur);
      const ri = nextR;
      let m = -1;
      let k = -1;
      if (ci !== -1) { m = ci; k = 0; }
      if (ni !== -1 && (m === -1 || ni < m)) { m = ni; k = 1; }
      if (ri !== -1 && (m === -1 || ri < m)) { m = ri; k = 2; }
      if (m === -1) {
        uVal = val + text.slice(cur);
        pos = n;
        uEnd = END;
        return;
      }
      if (k === 0) {
        uVal = val + text.slice(cur, m);
        pos = m + 1;
        uEnd = COMMA;
        return;
      }
      if (k === 1) {
        uVal = val + text.slice(cur, m);
        pos = m + 1;
        line += 1;
        uEnd = LINE_BREAK;
        return;
      }
      // A CR: the CRLF that ends the record, or a stray to drop.
      if (text.charCodeAt(m + 1) === 10) {
        uVal = val + text.slice(cur, m);
        pos = m + 2;
        line += 1;
        uEnd = LINE_BREAK;
        return;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      val += text.slice(cur, m);
      cur = m + 1;
    }
  }

  // Counts the LFs in text[a, b) with indexOf hops.
  function countLF(a, b) {
    let count = 0;
    let i = text.indexOf('\n', a);
    while (i !== -1 && i < b) {
      count += 1;
      i = text.indexOf('\n', i + 1);
    }
    return count;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Whole-line fast path: the record sits on one line holding no '"' and no stray CR, so
    // its fields are the line split on commas (native code). The cursors say whether the line
    // qualifies without scanning it again.
    if (nextN !== -1 && nextN < pos) nextN = text.indexOf('\n', pos);
    const nl = nextN;
    const segEnd = nl === -1 ? n : nl;
    if (nextQ !== -1 && nextQ < pos) nextQ = text.indexOf('"', pos);
    let fastEnd = -1; // where the line's content ends, when the fast path applies
    if (nextQ === -1 || nextQ >= segEnd) {
      if (nextR !== -1 && nextR < pos) nextR = text.indexOf('\r', pos);
      if (nextR === -1 || nextR >= segEnd) {
        fastEnd = segEnd;
      } else if (nextR === segEnd - 1 && nl !== -1) {
        fastEnd = segEnd - 1; // the CR of the closing CRLF
      }
    }
    if (fastEnd !== -1) {
      const fields = text.slice(pos, fastEnd).split(',');
      pos = nl === -1 ? n : nl + 1;
      if (nl !== -1) line += 1;
      if (width < 0) width = fields.length;
      if (header && columns === null) {
        columns = fields;
        continue;
      }
      if (fields.length < width) {
        errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
        while (fields.length < width) fields.push('');
      } else if (fields.length > width) {
        errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
      }
      rows.push(fields);
      continue;
    }

    // Field-by-field path: the line holds a quote or a stray CR.
    const fields = [];
    let lastQuoted = false;
    let ended = END;
    for (;;) {
      let value;
      if (text.charCodeAt(pos) === 34) {
        lastQuoted = true;
        const open = pos;
        // Find the closing quote, skipping doubled ones; remember whether any were skipped
        // (a quote inside the span is then necessarily one half of a "" pair).
        let q = text.indexOf('"', pos + 1);
        let doubled = false;
        while (q !== -1 && text.charCodeAt(q + 1) === 34) {
          doubled = true;
          q = text.indexOf('"', q + 2);
        }
        if (q === -1) {
          // The quote never closes: it is a literal character, and the text after it is
          // read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          readUnquoted('"', open + 1);
          value = uVal;
          ended = uEnd;
        } else {
          const spanStart = open + 1;
          if (nextR !== -1 && nextR < spanStart) nextR = text.indexOf('\r', spanStart);
          const hasCr = nextR !== -1 && nextR < q;
          if (!doubled && !hasCr) {
            // One slice; only the line count needs the LFs inside.
            value = text.slice(spanStart, q);
            if (nextN !== -1 && nextN < spanStart) nextN = text.indexOf('\n', spanStart);
            if (nextN !== -1 && nextN < q) line += countLF(spanStart, q);
          } else {
            // Single rebuild pass over the span: "" becomes ", each CRLF or lone CR becomes
            // LF, and every break inside counts one line.
            const parts = [];
            let cur = spanStart;
            while (cur < q) {
              let mQ = text.indexOf('"', cur);
              if (mQ >= q) mQ = -1;
              let mR = text.indexOf('\r', cur);
              if (mR >= q) mR = -1;
              let m = -1;
              let isQuote = false;
              if (mQ !== -1) { m = mQ; isQuote = true; }
              if (mR !== -1 && (m === -1 || mR < m)) { m = mR; isQuote = false; }
              if (m === -1) {
                line += countLF(cur, q);
                parts.push(text.slice(cur, q));
                cur = q;
                break;
              }
              if (m > cur) {
                line += countLF(cur, m);
                parts.push(text.slice(cur, m));
              }
              if (isQuote) {
                parts.push('"');
                cur = m + 2;
              } else {
                parts.push('\n');
                line += 1;
                cur = text.charCodeAt(m + 1) === 10 ? m + 2 : m + 1;
              }
            }
            value = parts.join('');
          }
          pos = q + 1;
          if (pos >= n) {
            ended = END;
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) {
              pos += 1;
              ended = COMMA;
            } else if (c === 10) {
              pos += 1;
              line += 1;
              ended = LINE_BREAK;
            } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              ended = LINE_BREAK;
            } else {
              // What follows the closing quote is appended as it stands, up to the next
              // comma or line break.
              const before = value.length;
              readUnquoted(value, pos);
              value = uVal;
              ended = uEnd;
              if (value.length > before) {
                errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
              }
            }
          }
        }
      } else {
        lastQuoted = false;
        // The common field: it ends at the next comma, with no line break and no CR before
        // it (the cursors, refreshed only when behind, say so) — one indexOf and one slice.
        if (nextN !== -1 && nextN < pos) nextN = text.indexOf('\n', pos);
        if (nextR !== -1 && nextR < pos) nextR = text.indexOf('\r', pos);
        const ci = text.indexOf(',', pos);
        if (
          ci !== -1 &&
          (nextN === -1 || ci < nextN) &&
          (nextR === -1 || ci < nextR)
        ) {
          value = text.slice(pos, ci);
          pos = ci + 1;
          ended = COMMA;
        } else {
          readUnquoted('', pos);
          value = uVal;
          ended = uEnd;
        }
      }
      fields.push(value);
      if (ended !== COMMA) break;
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr
    // errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
