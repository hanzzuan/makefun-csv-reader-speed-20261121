// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Same answer for every input, much less CPU: instead of walking the text one
// character at a time and building every field with `value += c`, this parser
// scans with String.indexOf (C++ memchr-speed) and slices fields out whole.
//
// Layout of the parse:
//  - A record whose line holds no double quote and no stray CR is taken in one
//    go: split the line on commas with indexOf and slice each field.
//  - Otherwise the record goes field by field, but a run of consecutive
//    unquoted fields is still split in one go: from a field start, the run
//    reaches to the next field-start quote (a quote right after a comma; a
//    quote inside an unquoted field is literal and does not end the run),
//    the next LF, or the end of the text, unless a stray CR sits inside it,
//    in which case that one field falls back to the single-field scan.
//  - A quoted field runs to the next non-doubled quote, with "" collapsed
//    and CR/LF inside read as LF.
//  - Every error the reference reports is reproduced in the same order, with
//    the same {code, line, row}: stray_cr, unterminated_quote, quote_junk,
//    short_row and long_row, with line counted exactly as the reference does
//    (a line break inside quotes counts; a lone CR outside quotes does not).
//
// No scan is left unbounded: the positions of every CR are collected once per
// case (a single linear pass) and a pointer walks them as parsing moves left
// to right, so a stray-CR check is O(1) instead of a rescan to the next CR,
// which in an LF file can be kilobytes away. The same care is taken inside
// quoted fields, whose content is converted on its own slice.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the
// next. Dependency-free ES module; run(input) returns {columns, rows, errors}.

const COMMA = 0;
const BREAK = 1;
const END = 2;

/**
 * Convert a quoted field's raw content `seg` to its value: every "" pair
 * becomes one quote, every CRLF or lone CR becomes one LF.
 * Returns [value, lineDelta] where lineDelta counts the line breaks inside.
 * Every '"' in seg belongs to a "" pair (the caller found the closing quote
 * by skipping such pairs), so a '"' here is always followed by '"'.
 * All scans stay inside seg, so none of them can run past the field.
 */
function qseg(seg) {
  const b = seg.length;
  let out = '';
  let delta = 0;
  let s = 0;
  while (s < b) {
    let qi = seg.indexOf('"', s);
    if (qi === -1) qi = b + 1;
    let ri = seg.indexOf('\r', s);
    if (ri === -1) ri = b + 1;
    let ni = seg.indexOf('\n', s);
    if (ni === -1) ni = b + 1;
    let m = qi;
    let kind = 0;
    if (ri < m) {
      m = ri;
      kind = 1;
    }
    if (ni < m) {
      m = ni;
      kind = 2;
    }
    if (m > b) {
      out += seg.slice(s);
      break;
    }
    if (kind === 0) {
      out += seg.slice(s, m);
      out += '"';
      s = m + 2;
    } else if (kind === 2) {
      out += seg.slice(s, m + 1);
      delta += 1;
      s = m + 1;
    } else {
      out += seg.slice(s, m);
      out += '\n';
      delta += 1;
      s = m + 1 < b && seg.charCodeAt(m + 1) === 10 ? m + 2 : m + 1;
    }
  }
  return [out, delta];
}

/** csv-reader 1.0.0's answer for one case's input, {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  // Positions of every CR in the text, in order. Parsing moves left to right,
  // so crPtr always points at the first CR at or after pos; a stray-CR check
  // is then a comparison, not a rescan.
  const crs = [];
  {
    let c = text.indexOf('\r');
    while (c !== -1) {
      crs.push(c);
      c = text.indexOf('\r', c + 1);
    }
  }
  const crN = crs.length;
  let crPtr = 0;

  while (true) {
    // Lines left with no characters are no records.
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

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;

    let fields;
    let lastQuoted = false;

    // Fast path: the record's line holds no quote and no stray CR.
    const le = text.indexOf('\n', pos);
    const lineEnd = le === -1 ? n : le;
    const qi = text.indexOf('"', pos);
    if (qi === -1 || qi >= lineEnd) {
      while (crPtr < crN && crs[crPtr] < pos) crPtr += 1;
      const nextCR = crPtr < crN ? crs[crPtr] : -1;
      const crlf = lineEnd < n && nextCR === lineEnd - 1;
      if (nextCR === -1 || nextCR >= lineEnd || crlf) {
        const segEnd = crlf ? lineEnd - 1 : lineEnd;
        fields = [];
        let s = pos;
        while (true) {
          const ci = text.indexOf(',', s);
          if (ci === -1 || ci >= segEnd) {
            fields.push(text.slice(s, segEnd));
            break;
          }
          fields.push(text.slice(s, ci));
          s = ci + 1;
        }
        pos = lineEnd < n ? lineEnd + 1 : n;
        if (lineEnd < n) line += 1;
      }
    }

    if (fields === undefined) {
      // Slow path: field by field, with runs of unquoted fields split at once.
      fields = [];
      let ended = END;
      while (true) {
        const quoted = text.charCodeAt(pos) === 34;
        lastQuoted = quoted;
        let v = '';
        let junk = false;
        let needScan = false;
        if (quoted) {
          const open = pos;
          const openLine = line;
          let q = text.indexOf('"', pos + 1);
          let paired = false;
          while (q !== -1 && text.charCodeAt(q + 1) === 34) {
            paired = true;
            q = text.indexOf('"', q + 2);
          }
          if (q === -1) {
            // The quote never closes: it is a literal character, and the
            // text after it is read again as unquoted.
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            pos = open + 1;
            line = openLine;
            // Parsing steps back to just after the opening quote, so the CR
            // pointer steps back with it (its only backward move).
            while (crPtr > 0 && crs[crPtr - 1] >= pos) crPtr -= 1;
            v = '"';
            needScan = true;
          } else {
            while (crPtr < crN && crs[crPtr] < open + 1) crPtr += 1;
            const hasCR = crPtr < crN && crs[crPtr] < q;
            const ni = text.indexOf('\n', open + 1);
            const hasLF = ni !== -1 && ni < q;
            if (!paired && !hasCR && !hasLF) {
              v = text.slice(open + 1, q);
            } else {
              const r = qseg(text.slice(open + 1, q));
              v = r[0];
              line += r[1];
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
                ended = BREAK;
              } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
                pos += 2;
                line += 1;
                ended = BREAK;
              } else {
                // What follows the closing quote is appended as it stands,
                // up to the next comma or line break.
                junk = true;
                needScan = true;
              }
            }
          }
        } else {
          // Unquoted run: to the next field-start quote, the next LF, or
          // the end of the text. A quote preceded by a comma opens the next
          // quoted field; any other quote is a literal inside this field.
          let nq = text.indexOf('"', pos);
          while (nq !== -1 && text.charCodeAt(nq - 1) !== 44) nq = text.indexOf('"', nq + 1);
          const nl = text.indexOf('\n', pos);
          let runEnd = n;
          let stopAtQuote = false;
          if (nq !== -1) {
            runEnd = nq;
            stopAtQuote = true;
          }
          if (nl !== -1 && nl < runEnd) {
            runEnd = nl;
            stopAtQuote = false;
          }
          while (crPtr < crN && crs[crPtr] < pos) crPtr += 1;
          const nextCR = crPtr < crN ? crs[crPtr] : -1;
          // A CR at runEnd - 1 when the run ends at an LF is the CRLF's own
          // CR, not a stray one; any other CR before runEnd is stray.
          const crLimit = stopAtQuote || nl === -1 || nl !== runEnd ? runEnd : runEnd - 1;
          if (nextCR !== -1 && nextCR < crLimit) {
            // A stray CR sits inside this run: parse just this one field
            // with the single-field scan, then resume the run after it.
            needScan = true;
          } else {
            const segEnd = !stopAtQuote && runEnd < n && text.charCodeAt(runEnd - 1) === 13 ? runEnd - 1 : runEnd;
            let s = pos;
            while (true) {
              const ci = text.indexOf(',', s);
              if (ci === -1 || ci >= segEnd) {
                // When the run stops at a quote, the piece after the last
                // comma is not a field: the quoted field follows it.
                if (!stopAtQuote) fields.push(text.slice(s, segEnd));
                break;
              }
              fields.push(text.slice(s, ci));
              s = ci + 1;
            }
            if (stopAtQuote) {
              pos = runEnd;
              continue;
            }
            pos = runEnd < n ? runEnd + 1 : n;
            if (runEnd < n) line += 1;
            break;
          }
        }
        if (needScan) {
          // Read unquoted characters onto v up to the next comma or line
          // break; a CR not followed by LF is dropped (stray_cr).
          const before = v.length;
          let start = pos;
          while (true) {
            while (crPtr < crN && crs[crPtr] < pos) crPtr += 1;
            const nextCR = crPtr < crN ? crs[crPtr] : -1;
            const ci = text.indexOf(',', pos);
            const ni = text.indexOf('\n', pos);
            let m = -1;
            let kind = 0;
            if (ci !== -1) {
              m = ci;
              kind = 0;
            }
            if (ni !== -1 && (m === -1 || ni < m)) {
              m = ni;
              kind = 1;
            }
            if (nextCR !== -1 && (m === -1 || nextCR < m)) {
              m = nextCR;
              kind = 2;
            }
            if (m === -1) {
              v += text.slice(start, n);
              pos = n;
              ended = END;
              break;
            }
            if (kind === 0) {
              v += text.slice(start, m);
              pos = m + 1;
              ended = COMMA;
              break;
            }
            if (kind === 1) {
              v += text.slice(start, m);
              pos = m + 1;
              line += 1;
              ended = BREAK;
              break;
            }
            if (text.charCodeAt(m + 1) === 10) {
              v += text.slice(start, m);
              pos = m + 2;
              line += 1;
              ended = BREAK;
              break;
            }
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            v += text.slice(start, m);
            pos = m + 1;
            start = m + 1;
          }
          if (junk && v.length > before) {
            errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
          }
        }
        fields.push(v);
        if (ended !== COMMA) break;
      }
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
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

  return { columns: header ? columns ?? [] : null, rows, errors };
}
