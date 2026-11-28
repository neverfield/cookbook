import path from 'node:path';
import { parse as babelParse, type ParserPlugin } from '@babel/parser';
import postcss from 'postcss';
import postcssScss from 'postcss-scss';
import type { Diagnostic, SyntaxValidator } from '@codecanvas/protocol';

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx']);
const TS_EXTENSIONS = new Set(['.ts', '.mts', '.cts']);
const TSX_EXTENSIONS = new Set(['.tsx']);
const CSS_EXTENSIONS = new Set(['.css']);
const SCSS_EXTENSIONS = new Set(['.scss']);
const JSON_EXTENSIONS = new Set(['.json']);

const BASE_BABEL_PLUGINS: readonly ParserPlugin[] = [
  'decorators-legacy',
  'importAttributes',
  'explicitResourceManagement',
];

interface BabelParseErrorLike {
  message?: unknown;
  reasonCode?: unknown;
  loc?: {
    line?: unknown;
    column?: unknown;
  };
}

interface PostcssErrorLike {
  name?: unknown;
  reason?: unknown;
  message?: unknown;
  line?: unknown;
  column?: unknown;
}

function offsetToLineColumn(
  text: string,
  offset: number,
): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let column = 1;
  for (let i = 0; i < clamped; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function validateWithBabel(
  file: string,
  text: string,
  plugins: readonly ParserPlugin[],
): Diagnostic[] {
  try {
    babelParse(text, {
      sourceType: 'unambiguous',
      sourceFilename: file,
      errorRecovery: false,
      plugins: [...plugins],
    });
    return [];
  } catch (error) {
    const err = error as BabelParseErrorLike;
    const rawLine = typeof err.loc?.line === 'number' ? err.loc.line : 1;
    // Babel loc.column is 0-based; normalize to 1-based for consistent diagnostics.
    const rawColumn =
      typeof err.loc?.column === 'number' ? err.loc.column + 1 : 1;
    const message =
      typeof err.message === 'string' && err.message.length > 0
        ? err.message
        : 'JavaScript/TypeScript syntax error';
    const code = typeof err.reasonCode === 'string' ? err.reasonCode : undefined;

    return [
      {
        file,
        severity: 'error',
        line: rawLine,
        col: rawColumn,
        column: rawColumn,
        message,
        source: 'babel',
        ...(code !== undefined ? { code } : {}),
      },
    ];
  }
}

function validateWithPostcss(
  file: string,
  text: string,
  scss: boolean,
): Diagnostic[] {
  try {
    if (scss) {
      postcssScss.parse(text, { from: file });
    } else {
      postcss.parse(text, { from: file });
    }
    return [];
  } catch (error) {
    const err = error as PostcssErrorLike;
    const line = typeof err.line === 'number' && err.line >= 1 ? err.line : 1;
    const column =
      typeof err.column === 'number' && err.column >= 1 ? err.column : 1;
    const message =
      typeof err.reason === 'string' && err.reason.length > 0
        ? err.reason
        : typeof err.message === 'string' && err.message.length > 0
          ? err.message
          : 'CSS syntax error';

    return [
      {
        file,
        severity: 'error',
        line,
        col: column,
        column,
        message,
        source: scss ? 'postcss-scss' : 'postcss',
      },
    ];
  }
}

function validateJson(file: string, text: string): Diagnostic[] {
  try {
    JSON.parse(text);
    return [];
  } catch (error) {
    const message =
      error instanceof Error && error.message.length > 0
        ? error.message
        : 'Invalid JSON syntax';

    let line = 1;
    let column = 1;

    const lineColMatch = /\(line\s+(\d+)\s+column\s+(\d+)\)/i.exec(message);
    if (lineColMatch?.[1] && lineColMatch[2]) {
      line = Number.parseInt(lineColMatch[1], 10);
      column = Number.parseInt(lineColMatch[2], 10);
    } else {
      const posMatch = /at position\s+(\d+)/i.exec(message);
      if (posMatch?.[1]) {
        const computed = offsetToLineColumn(
          text,
          Number.parseInt(posMatch[1], 10),
        );
        line = computed.line;
        column = computed.column;
      }
    }

    return [
      {
        file,
        severity: 'error',
        line,
        col: column,
        column,
        message,
        source: 'json',
      },
    ];
  }
}

/**
 * Built-in pre-write parse validator (§8.2 step 2):
 * - JS/JSX/MJS/CJS via `@babel/parser` with JSX plugin
 * - TS/MTS/CTS via `@babel/parser` with TypeScript plugin
 * - TSX via `@babel/parser` with TypeScript + JSX plugins
 * - CSS via `postcss`, SCSS via `postcss-scss`
 * - JSON via `JSON.parse`
 */
export function validateSyntax(file: string, text: string): Diagnostic[] {
  const ext = path.extname(file).toLowerCase();

  if (JS_EXTENSIONS.has(ext)) {
    return validateWithBabel(file, text, ['jsx', ...BASE_BABEL_PLUGINS]);
  }
  if (TS_EXTENSIONS.has(ext)) {
    return validateWithBabel(file, text, ['typescript', ...BASE_BABEL_PLUGINS]);
  }
  if (TSX_EXTENSIONS.has(ext)) {
    return validateWithBabel(file, text, [
      'typescript',
      'jsx',
      ...BASE_BABEL_PLUGINS,
    ]);
  }
  if (CSS_EXTENSIONS.has(ext)) {
    return validateWithPostcss(file, text, false);
  }
  if (SCSS_EXTENSIONS.has(ext)) {
    return validateWithPostcss(file, text, true);
  }
  if (JSON_EXTENSIONS.has(ext)) {
    return validateJson(file, text);
  }

  return [];
}

export function createDefaultValidator(): SyntaxValidator {
  return {
    validate: validateSyntax,
  };
}
