import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';

export function CopyMessage({ text }: { text: string }) {
  const [state, setState] = useState(''), timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <button className="assistant-copy" aria-label={state || 'Copy response'} title={state || 'Copy response'} onClick={() => {
    void (async () => {
      try { await navigator.clipboard.writeText(text); setState('Copied'); }
      catch { setState('Copy unavailable'); }
    })();
    clearTimeout(timer.current); timer.current = setTimeout(() => setState(''), 2500);
  }}>{state === 'Copied' ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}<span>{state || 'Copy'}</span></button>;
}

// Render a small Markdown subset as React nodes; HTML and image markup stay inert.
function inline(text: string): ReactNode[] {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/g;
  const nodes: ReactNode[] = []; let start = 0;
  for (const match of text.matchAll(pattern)) {
    nodes.push(text.slice(start, match.index));
    const token = match[0], key = match.index;
    if (token.startsWith('`')) nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('**')) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('*')) nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;
      let safe = false;
      try { const url = new URL(link[2]!); safe = ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { /* Relative and non-web links stay text. */ }
      nodes.push(safe ? <a key={key} href={link[2]} target="_blank" rel="noopener noreferrer">{link[1]}</a> : token);
    }
    start = match.index + token.length;
  }
  nodes.push(text.slice(start)); return nodes;
}

function tableCells(line: string): string[] {
  const cells: string[] = []; let cell = '';
  const row = line.trim();
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '\\' && row[i + 1] === '|') { cell += '|'; i++; }
    else if (row[i] === '|') { cells.push(cell.trim()); cell = ''; }
    else cell += row[i];
  }
  cells.push(cell.trim());
  if (row.startsWith('|')) cells.shift();
  if (row.endsWith('|') && cells.at(-1) === '') cells.pop();
  return cells;
}

function tableHeader(line: string, separator?: string) {
  if (!separator || !line.includes('|')) return null;
  const headers = tableCells(line), delimiters = tableCells(separator);
  if (!headers.length || headers.length !== delimiters.length || !delimiters.every(cell => /^:?-+:?$/.test(cell))) return null;
  const alignment = delimiters.map(cell => cell.endsWith(':') ? (cell.startsWith(':') ? 'center' : 'right') : 'left') as ('left' | 'center' | 'right')[];
  return { headers, alignment };
}

export function AssistantMarkdown({ text }: { text: string }) {
  const lines = text.split(/\r\n?|\n/), blocks: ReactNode[] = [];
  const special = (line: string) => /^(?:```|#{1,6}\s|[-*+]\s|\d+\.\s|>\s)/.test(line);
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!; const key = i;
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) {
      const language = line.slice(3).trim(), code: string[] = []; i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) code.push(lines[i++]!);
      if (i < lines.length) i++;
      blocks.push(<div className="assistant-code" key={key}><div><span>{language || 'Code'}</span><CopyMessage text={code.join('\n')} /></div><pre><code>{code.join('\n')}</code></pre></div>); continue;
    }
    const table = tableHeader(line, lines[i + 1]);
    if (table) {
      const rows: ReactNode[] = []; i += 2;
      while (i < lines.length && lines[i]!.trim() && !special(lines[i]!)) {
        const cells = tableCells(lines[i]!);
        rows.push(<tr key={i}>{table.headers.map((_, column) => <td key={column} style={{ textAlign: table.alignment[column] }}>{inline(cells[column] ?? '')}</td>)}</tr>); i++;
      }
      blocks.push(<div className="assistant-table" role="region" aria-label="Response table" tabIndex={0} key={key}><table>
        <thead><tr>{table.headers.map((header, column) => <th scope="col" key={column} style={{ textAlign: table.alignment[column] }}>{inline(header)}</th>)}</tr></thead>
        {rows.length > 0 && <tbody>{rows}</tbody>}
      </table></div>); continue;
    }
    if (/^#{1,6}\s/.test(line)) { blocks.push(<h4 key={key}>{inline(line.replace(/^#{1,6}\s+/, ''))}</h4>); i++; continue; }
    if (/^(?:[-*+]\s|\d+\.\s)/.test(line)) {
      const ordered = /^\d+\./.test(line), items: ReactNode[] = [], expression = ordered ? /^\d+\.\s+/ : /^[-*+]\s+/;
      while (i < lines.length && expression.test(lines[i]!)) { items.push(<li key={i}>{inline(lines[i++]!.replace(expression, ''))}</li>); }
      blocks.push(ordered ? <ol key={key} start={parseInt(line)}>{items}</ol> : <ul key={key}>{items}</ul>); continue;
    }
    if (/^>\s/.test(line)) { const quote: string[] = []; while (i < lines.length && /^>\s/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^>\s/, '')); blocks.push(<blockquote key={key}>{inline(quote.join('\n'))}</blockquote>); continue; }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i]!.trim() && !special(lines[i]!) && !tableHeader(lines[i]!, lines[i + 1])) paragraph.push(lines[i++]!);
    blocks.push(<p key={key}>{paragraph.map((part, index) => <Fragment key={index}>{index > 0 && <br />}{inline(part)}</Fragment>)}</p>);
  }
  return <div className="assistant-answer">{blocks}</div>;
}
