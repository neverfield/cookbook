'use strict';

const crypto = require('node:crypto');

const HTML_AND_SVG_TAGS = new Set([
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo',
  'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'cite', 'code', 'col', 'colgroup',
  'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'head', 'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label',
  'legend', 'li', 'link', 'main', 'map', 'mark', 'menu', 'meta', 'meter', 'nav', 'noscript',
  'object', 'ol', 'optgroup', 'option', 'output', 'p', 'picture', 'pre', 'progress', 'q', 'rp',
  'rt', 'ruby', 's', 'samp', 'script', 'search', 'section', 'select', 'slot', 'small', 'source',
  'span', 'strong', 'style', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'template',
  'textarea', 'tfoot', 'th', 'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video',
  'wbr',
  'svg', 'circle', 'clipPath', 'defs', 'ellipse', 'g', 'line', 'linearGradient', 'mask', 'path',
  'pattern', 'polygon', 'polyline', 'radialGradient', 'rect', 'stop', 'symbol', 'text', 'tspan',
  'use', 'view'
]);

const SKIP_STAMP_TAGS = new Set(['html', 'head', 'meta', 'title', 'link', 'script', 'style', 'base', 'noscript']);

function computeRev(source) {
  return crypto.createHash('sha1').update(source).digest('hex').slice(0, 12);
}

/**
 * Find the byte/char offset right after any leading comments and directive prologues
 * ('use client', 'use server', 'use cache', 'use strict') so directives remain first.
 */
function findDirectiveEnd(source) {
  let i = 0;
  const len = source.length;
  let lastDirectiveEnd = 0;

  while (i < len) {
    // Skip whitespace
    while (i < len && /\s/.test(source[i])) i++;
    // Skip single-line comments
    if (source[i] === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i + 2);
      i = nl === -1 ? len : nl + 1;
      continue;
    }
    // Skip block comments
    if (source[i] === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? len : end + 2;
      continue;
    }
    // Check string literal directive
    if (source[i] === "'" || source[i] === '"') {
      const quote = source[i];
      let j = i + 1;
      while (j < len && source[j] !== quote && source[j] !== '\n') {
        if (source[j] === '\\') j++;
        j++;
      }
      if (j < len && source[j] === quote) {
        j++;
        while (j < len && (source[j] === ' ' || source[j] === '\t')) j++;
        if (source[j] === ';') j++;
        if (source[j] === '\r') j++;
        if (source[j] === '\n') j++;
        lastDirectiveEnd = j;
        i = j;
        continue;
      }
    }
    break;
  }

  return lastDirectiveEnd;
}

/**
 * Lightweight, dependency-free JSX host-element stamper and __cc prelude injector for Spike S1.
 * Stamps HTML/SVG host tags with data-cc-src="<relPath>:<line>:<col>@<rev>" and emits
 * the edge-safe inline __cc prelude + __cc.mod() call after directives.
 */
function instrumentSource(source, relPath) {
  if (!source || source.includes('const __ccNoop =')) {
    return { code: source, stamped: 0, rev: computeRev(source || '') };
  }

  const rev = computeRev(source);
  const normalizedRel = relPath.replace(/\\/g, '/');

  // Precompute line start offsets for 1-based line, 0-based col lookup
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') lineStarts.push(i + 1);
  }

  function posAt(offset) {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - lineStarts[lo] };
  }

  const insertions = [];
  let i = 0;
  const len = source.length;

  while (i < len) {
    const ch = source[i];

    // Skip single-line comment
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i + 2);
      i = nl === -1 ? len : nl + 1;
      continue;
    }
    // Skip block comment
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? len : end + 2;
      continue;
    }
    // Skip strings
    if (ch === "'" || ch === '"') {
      i++;
      while (i < len && source[i] !== ch) {
        if (source[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    // Skip template literals (conservative: skip entire backtick block)
    if (ch === '`') {
      i++;
      while (i < len && source[i] !== '`') {
        if (source[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }

    // Potential JSX opening tag: <tagName followed by whitespace, >, or /
    if (ch === '<') {
      const rest = source.slice(i + 1);
      const m = /^([a-z][a-zA-Z0-9]*)(?=[\s/>])/.exec(rest);
      if (m) {
        const tag = m[1];
        if (HTML_AND_SVG_TAGS.has(tag) && !SKIP_STAMP_TAGS.has(tag)) {
          // Verify previous non-whitespace char is NOT an identifier/closing paren/bracket
          // (avoids mistaking `a < div` or TS generic `Array<div>` for JSX)
          let prevIdx = i - 1;
          while (prevIdx >= 0 && /\s/.test(source[prevIdx])) prevIdx--;
          const prevChar = prevIdx >= 0 ? source[prevIdx] : '';
          const looksLikeGenericOrCompare =
            prevChar === ')' || prevChar === ']' || /[a-zA-Z0-9_$]/.test(prevChar);

          // Check that "return <div" is allowed!
          let isReturnOrKeyword = false;
          if (looksLikeGenericOrCompare && /[a-zA-Z]/.test(prevChar)) {
            const wordMatch = /([a-zA-Z_$][a-zA-Z0-9_$]*)$/.exec(source.slice(0, prevIdx + 1));
            if (wordMatch && /^(return|case|yield|await|default|else|typeof)$/.test(wordMatch[1])) {
              isReturnOrKeyword = true;
            }
          }

          if (!looksLikeGenericOrCompare || isReturnOrKeyword) {
            const afterTagOffset = i + 1 + tag.length;
            // Check upcoming attributes up to tag close '>' for existing data-cc-src
            const snippet = source.slice(afterTagOffset, Math.min(len, afterTagOffset + 240));
            const gtIdx = snippet.indexOf('>');
            const tagHead = gtIdx === -1 ? snippet : snippet.slice(0, gtIdx);
            if (!tagHead.includes('data-cc-src')) {
              const { line, col } = posAt(i);
              const ref = `${normalizedRel}:${line}:${col}@${rev}`;
              insertions.push({
                offset: afterTagOffset,
                text: ` data-cc-src="${ref}"`
              });
            }
            i = afterTagOffset;
            continue;
          }
        }
      }
    }

    i++;
  }

  // Apply tag attribute insertions from back to front so offsets stay exact
  let out = source;
  for (let k = insertions.length - 1; k >= 0; k--) {
    const ins = insertions[k];
    out = out.slice(0, ins.offset) + ins.text + out.slice(ins.offset);
  }

  // Inject edge-safe inline __cc prelude + __cc.mod() after leading directives
  const directiveEnd = findDirectiveEnd(out);
  const prelude =
    `const __ccNoop = { el: (e) => e, mod: () => {}, comp: () => {} };\n` +
    `const __cc = (typeof globalThis !== "undefined" && globalThis.__cc) || __ccNoop;\n` +
    `__cc.mod(${JSON.stringify(normalizedRel)}, ${JSON.stringify(rev)});\n`;

  out = out.slice(0, directiveEnd) + prelude + out.slice(directiveEnd);

  return { code: out, stamped: insertions.length, rev };
}

module.exports = { instrumentSource, computeRev };
