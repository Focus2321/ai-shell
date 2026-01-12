type StreamWriter = (data: string) => void;

type TableState = {
  header: string[];
  rows: string[][];
};

type RendererState = {
  buffer: string;
  pendingLines: string[];
  inCodeBlock: boolean;
  tableState: TableState | null;
};

const ansi = {
  reset: '\x1b[0m',
  boldOn: '\x1b[1m',
  boldOff: '\x1b[22m',
  italicOn: '\x1b[3m',
  italicOff: '\x1b[23m',
  strikeOn: '\x1b[9m',
  strikeOff: '\x1b[29m',
  underlineOn: '\x1b[4m',
  underlineOff: '\x1b[24m',
  dimOn: '\x1b[2m',
  dimOff: '\x1b[22m',
  cyanOn: '\x1b[36m',
  cyanOff: '\x1b[39m',
  codeOn: '\x1b[36m',
  codeOff: '\x1b[39m',
  headingOn: '\x1b[1m\x1b[36m',
  headingOff: '\x1b[22m\x1b[39m',
};

const createInitialState = (): RendererState => ({
  buffer: '',
  pendingLines: [],
  inCodeBlock: false,
  tableState: null,
});

const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, '');

const isFence = (line: string) => line.trim().startsWith('```');

const isTableSeparator = (line: string) =>
  /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(line);

const isTableRow = (line: string) => line.includes('|');

const parseTableRow = (line: string) => {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
};

const renderInline = (text: string) => {
  let output = text;
  output = output.replace(/`([^`]+)`/g, `${ansi.codeOn}$1${ansi.codeOff}`);
  output = output.replace(
    /~~([^~]+)~~/g,
    `${ansi.strikeOn}$1${ansi.strikeOff}`
  );
  output = output.replace(
    /(\*\*|__)(.+?)\1/g,
    `${ansi.boldOn}$2${ansi.boldOff}`
  );
  output = output.replace(
    /(^|[^*])\*([^*]+)\*(?!\*)/g,
    `$1${ansi.italicOn}$2${ansi.italicOff}`
  );
  output = output.replace(
    /(^|[^_])_([^_]+)_(?!_)/g,
    `$1${ansi.italicOn}$2${ansi.italicOff}`
  );
  output = output.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    `${ansi.underlineOn}${ansi.cyanOn}$1${ansi.underlineOff}${ansi.cyanOff} ($2)`
  );
  return output;
};

const renderTable = (table: TableState) => {
  const allRows = [table.header, ...table.rows];
  const widths: number[] = [];

  allRows.forEach((row) => {
    row.forEach((cell, index) => {
      const styled = renderInline(cell);
      const length = stripAnsi(styled).length;
      widths[index] = Math.max(widths[index] ?? 0, length, 3);
    });
  });

  const renderRow = (row: string[], isHeader: boolean) => {
    const cells = widths.map((width, index) => {
      const value = row[index] ?? '';
      const styled = renderInline(value);
      const padding = width - stripAnsi(styled).length;
      const padded = styled + ' '.repeat(Math.max(0, padding));
      if (!isHeader) {
        return padded;
      }
      return `${ansi.boldOn}${ansi.cyanOn}${padded}${ansi.boldOff}${ansi.cyanOff}`;
    });
    return `| ${cells.join(' | ')} |`;
  };

  const separator = `| ${widths
    .map((width) => '-'.repeat(width))
    .join(' | ')} |`;
  const lines = [renderRow(table.header, true), separator];
  table.rows.forEach((row) => lines.push(renderRow(row, false)));
  return lines.join('\n');
};

const renderLine = (line: string) => {
  if (!line.trim()) {
    return '';
  }

  const headingMatch = line.match(/^\s*(#{1,6})\s+(.*)$/);
  if (headingMatch) {
    const text = renderInline(headingMatch[2].trim());
    return `${ansi.headingOn}${text}${ansi.headingOff}`;
  }

  const hrMatch = line.match(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/);
  if (hrMatch) {
    return `${ansi.dimOn}${'─'.repeat(40)}${ansi.dimOff}`;
  }

  const blockquoteMatch = line.match(/^(\s*)>\s?(.*)$/);
  if (blockquoteMatch) {
    const indent = blockquoteMatch[1];
    const content = renderInline(blockquoteMatch[2].trim());
    return `${indent}${ansi.dimOn}│${ansi.dimOff} ${content}`;
  }

  const orderedMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
  if (orderedMatch) {
    const indent = orderedMatch[1];
    const marker = orderedMatch[2];
    const content = renderInline(orderedMatch[3]);
    return `${indent}${marker}. ${content}`;
  }

  const unorderedMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (unorderedMatch) {
    const indent = unorderedMatch[1];
    const content = renderInline(unorderedMatch[2]);
    return `${indent}• ${content}`;
  }

  return renderInline(line);
};

export type MarkdownRenderer = {
  write: (chunk: string) => void;
  flush: () => void;
};

export const createMarkdownRenderer = (
  writer: StreamWriter
): MarkdownRenderer => {
  const state = createInitialState();

  const processPending = (final = false) => {
    while (state.pendingLines.length > 0) {
      if (state.tableState) {
        const nextLine = state.pendingLines[0];
        if (isTableRow(nextLine) && !isTableSeparator(nextLine)) {
          state.tableState.rows.push(parseTableRow(nextLine));
          state.pendingLines.shift();
          continue;
        }
        writer(`${renderTable(state.tableState)}\n`);
        state.tableState = null;
        continue;
      }

      const line = state.pendingLines[0];

      if (state.inCodeBlock) {
        state.pendingLines.shift();
        if (isFence(line)) {
          state.inCodeBlock = false;
          writer(`${ansi.codeOff}\n`);
          continue;
        }
        writer(`${line}\n`);
        continue;
      }

      if (isFence(line)) {
        state.inCodeBlock = true;
        state.pendingLines.shift();
        writer(`${ansi.codeOn}\n`);
        continue;
      }

      if (isTableRow(line)) {
        if (state.pendingLines.length < 2 && !final) {
          break;
        }
        const separator = state.pendingLines[1];
        if (separator && isTableSeparator(separator)) {
          state.tableState = {
            header: parseTableRow(line),
            rows: [],
          };
          state.pendingLines.shift();
          state.pendingLines.shift();
          continue;
        }
      }

      state.pendingLines.shift();
      writer(`${renderLine(line)}\n`);
    }
  };

  return {
    write: (chunk: string) => {
      state.buffer += chunk;
      const lines = state.buffer.split('\n');
      state.buffer = lines.pop() ?? '';
      state.pendingLines.push(...lines);
      processPending();
    },
    flush: () => {
      if (state.buffer) {
        state.pendingLines.push(state.buffer);
        state.buffer = '';
      }
      processPending(true);
      if (state.tableState) {
        writer(`${renderTable(state.tableState)}\n`);
        state.tableState = null;
      }
      if (state.inCodeBlock) {
        state.inCodeBlock = false;
        writer(`${ansi.codeOff}\n`);
      }
    },
  };
};
