import type { TextEdit } from '@codecanvas/protocol';

export class TextEditApplyError extends Error {
  readonly file: string;

  constructor(file: string, message: string) {
    super(message);
    this.name = 'TextEditApplyError';
    this.file = file;
  }
}

/**
 * Apply non-overlapping surgical TextEdit ranges to `source`.
 */
export function applyTextEdits(
  file: string,
  source: string,
  edits: readonly TextEdit[],
): string {
  if (edits.length === 0) {
    return source;
  }

  const indexed = edits.map((edit, order) => {
    const { start, end } = edit.range;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      end > source.length
    ) {
      throw new TextEditApplyError(
        file,
        `Invalid TextEdit range [${String(start)}, ${String(end)}] for "${file}" (length ${source.length}).`,
      );
    }
    return { edit, order };
  });

  indexed.sort((a, b) => {
    if (a.edit.range.start !== b.edit.range.start) {
      return a.edit.range.start - b.edit.range.start;
    }
    if (a.edit.range.end !== b.edit.range.end) {
      return a.edit.range.end - b.edit.range.end;
    }
    return a.order - b.order;
  });

  const parts: string[] = [];
  let cursor = 0;

  for (const { edit } of indexed) {
    const { start, end } = edit.range;
    if (start < cursor) {
      throw new TextEditApplyError(
        file,
        `Overlapping TextEdit range [${start}, ${end}] in "${file}" (previous edit ended at ${cursor}).`,
      );
    }
    parts.push(source.slice(cursor, start));
    parts.push(edit.newText);
    cursor = end;
  }

  parts.push(source.slice(cursor));
  return parts.join('');
}
