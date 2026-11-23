// Fast CSV reader: a drop-in for csv-reader 1.0.0 (make.fun's reference program).
// run(input) returns exactly csv-reader's answer for {text, header}:
// {columns, rows, errors}. Same broken-row policy, same error records, same
// order — but read as one index-based pass instead of one character at a
// time: a single regex finds the next delimiter (comma, LF or CR) and slice
// takes each field whole; quoted fields are found with indexOf('"') and
// their segments are normalised (CRLF and lone CR inside quotes read as LF)
// only when they actually hold a line break.
//
// Policy (csv-reader 1.0.0): a U+FEFF at the very start is dropped; a record
// ends at LF or CRLF, and a line left with no characters is no record;
// outside quotes a CR not followed by LF is dropped (stray_cr); a field
// that opens with a quote runs to the next quote that is not doubled ("" is
// one quote, each CRLF or lone CR inside read as LF); what follows its
// closing quote up to the next comma or line break is appended as it stands
// (quote_junk, when the field ends); a quote that never closes is a literal
// character and the text after it is read again as unquoted
// (unterminated_quote); a quote inside an unquoted field is a literal
// character; fields stay strings, never trimmed or converted; columns is
// the first record when header is true else null; rows holds the records
// after it, each padded (short_row, with fields: its field count) or cut
// (long_row, with extra: the cut fields) to the first record's width; each
// error is {code, line, row}, line the 1-based line its record starts on
// (counting every LF, CRLF and lone CR inside quotes) and row its record's
// index in rows, null for the header, in the order met.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to
// the next. No network, no clock reads.

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  let pos = 0;
  let line = 1;
  if (len > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The record being read: the line it starts on, its index in rows (null: header).
  let recordLine = 1;
  let recordRow = null;

  // How the last field ended: 0 comma, 1 line break, 2 end of text.
  let ended = 2;
  // Characters kept by the last unquoted read (for quote_junk).
  let added = 0;
  // Line breaks in the last quoted segment processed.
  let qb = 0;

  // Next comma, LF or CR at or after pos, in one scan.
  const DELIM = /[,\n\r]/g;

  // Reads unquoted characters onto `value` up to the next comma or line
  // break; a CR not followed by LF is dropped (stray_cr). Sets `ended`
  // and `added` (characters kept by this read).
  function readUnquoted(value) {
    added = 0;
    let seg = pos;
    for (;;) {
      DELIM.lastIndex = pos;
      const mt = DELIM.exec(text);
      if (mt === null) {
        if (pos < len) {
          value += text.slice(seg);
          added += len - seg;
        }
        pos = len;
        ended = 2;
        return value;
      }
      const m = mt.index;
      const ch = text.charCodeAt(m);
      if (ch === 44) {
        // Comma: the field ends, the record goes on.
        if (m > seg) {
          value += text.slice(seg, m);
          added += m - seg;
        }
        pos = m + 1;
        ended = 0;
        return value;
      }
      if (ch === 10) {
        // LF: the field and the record end.
        if (m > seg) {
          value += text.slice(seg, m);
          added += m - seg;
        }
        pos = m + 1;
        line += 1;
        ended = 1;
        return value;
      }
      // CR at m.
      if (m + 1 < len && text.charCodeAt(m + 1) === 10) {
        // CRLF: the field and the record end.
        if (m > seg) {
          value += text.slice(seg, m);
          added += m - seg;
        }
        pos = m + 2;
        line += 1;
        ended = 1;
        return value;
      }
      // Lone CR: dropped (stray_cr), the field keeps going.
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      if (m > seg) {
        value += text.slice(seg, m);
        added += m - seg;
      }
      pos = m + 1;
      seg = m + 1;
    }
  }

  // Appends the quoted segment [a, b) to `value`, reading each CRLF and
  // lone CR inside it as one LF, and sets `qb` to the line breaks it holds.
  function quotedSegment(value, a, b) {
    if (a === b) {
      // Empty segment (an empty quoted field "": no text, no breaks.
      qb = 0;
      return value;
    }
    const ni = text.indexOf('\n', a);
    const ri = text.indexOf('\r', a);
    const hasN = ni !== -1 && ni < b;
    const hasR = ri !== -1 && ri < b;
    if (!hasN && !hasR) {
      qb = 0;
      return value + text.slice(a, b);
    }
    if (!hasR) {
      // Only LFs: the text stands as it is, count them.
      let n = 0;
      let i = a;
      for (;;) {
        const j = text.indexOf('\n', i);
        if (j === -1 || j >= b) break;
        n += 1;
        i = j + 1;
      }
      qb = n;
      return value + text.slice(a, b);
    }
    // Holds a CR: normalise CRLF and lone CR to LF, count the breaks
    // (each LF once, each CR not followed by LF once).
    const seg = text.slice(a, b);
    let n = 0;
    let i = 0;
    for (;;) {
      const j = seg.indexOf('\n', i);
      if (j === -1) break;
      n += 1;
      i = j + 1;
    }
    i = 0;
    for (;;) {
      const j = seg.indexOf('\r', i);
      if (j === -1) break;
      if (j + 1 >= seg.length || seg.charCodeAt(j + 1) !== 10) n += 1;
      i = j + 1;
    }
    qb = n;
    return value + seg.replace(/\r\n?/g, '\n');
  }

  // Reads a quoted field whose opening quote is at pos. Sets `ended`.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let lb = 0;
    let seg = pos + 1;
    let p = pos + 1;
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      if (q + 1 < len && text.charCodeAt(q + 1) === 34) {
        // Doubled quote: one literal quote, keep scanning.
        value = quotedSegment(value, seg, q);
        lb += qb;
        value += '"';
        p = q + 2;
        seg = q + 2;
        continue;
      }
      // Closing quote at q.
      value = quotedSegment(value, seg, q);
      lb += qb;
      pos = q + 1;
      line += lb;
      if (pos >= len) {
        ended = 2;
        return value;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        ended = 0;
        return value;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        ended = 1;
        return value;
      }
      if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        ended = 1;
        return value;
      }
      // What follows the closing quote is appended as it stands, up to
      // the next comma or line break.
      const junk = readUnquoted(value);
      if (added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return junk;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted = false;
    do {
      quoted = pos < len && text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field);
    } while (ended === 0);

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

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
