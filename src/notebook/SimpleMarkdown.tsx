import React from 'react';

interface SimpleMarkdownProps {
  text: string;
  onInternalLinkClick?: (href: string) => void;
}

function renderInline(
  line: string,
  onInternalLinkClick?: (href: string) => void,
): React.ReactNode[] {
  const tokens: React.ReactNode[] = [];
  const regex = /(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let k = 0;

  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      tokens.push(line.slice(lastIndex, match.index));
    }
    const seg = match[0];
    if (seg.startsWith('[') && seg.includes('](') && seg.endsWith(')')) {
      const splitIdx = seg.indexOf('](');
      const label = seg.slice(1, splitIdx);
      const href = seg.slice(splitIdx + 2, -1).trim();
      const isExternal = /^https?:\/\//i.test(href);
      tokens.push(
        <a
          key={k++}
          href={href}
          target={isExternal ? '_blank' : undefined}
          rel={isExternal ? 'noopener noreferrer' : undefined}
          className="nb-md-link"
          onClick={(e) => {
            if (!isExternal && onInternalLinkClick) {
              e.preventDefault();
              onInternalLinkClick(href);
            }
          }}
        >
          {label}
        </a>,
      );
    } else if (seg.startsWith('**') && seg.endsWith('**')) {
      tokens.push(<strong key={k++}>{seg.slice(2, -2)}</strong>);
    } else if (seg.startsWith('`') && seg.endsWith('`')) {
      tokens.push(
        <code key={k++} className="nb-inline-code">
          {seg.slice(1, -1)}
        </code>,
      );
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < line.length) {
    tokens.push(line.slice(lastIndex));
  }
  return tokens;
}

function splitTableRow(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isTableSeparator(row: string): boolean {
  const trimmed = row.trim();
  if (!trimmed.includes('|')) return false;
  const cells = splitTableRow(trimmed);
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

export const SimpleMarkdown: React.FC<SimpleMarkdownProps> = ({
  text,
  onInternalLinkClick,
}) => {
  const lines = text.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push(
        <pre key={`code_${i}`} className="nb-md-pre">
          <code>{codeLines.join('\n')}</code>
        </pre>,
      );
      i++;
      continue;
    }

    if (
      line.trim().startsWith('|') &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const headers = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push(
        <div key={`tbl_wrap_${i}`} className="nb-md-table-wrap">
          <table className="nb-md-table">
            <thead>
              <tr>
                {headers.map((h, hIdx) => (
                  <th key={hIdx}>{renderInline(h, onInternalLinkClick)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, rIdx) => (
                <tr key={rIdx}>
                  {headers.map((_, cIdx) => (
                    <td key={cIdx}>{renderInline(r[cIdx] ?? '', onInternalLinkClick)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (line.startsWith('#### ')) {
      blocks.push(<h5 key={`h4_${i}`}>{renderInline(line.slice(5), onInternalLinkClick)}</h5>);
      i++;
      continue;
    }
    if (line.startsWith('### ')) {
      blocks.push(<h4 key={`h3_${i}`}>{renderInline(line.slice(4), onInternalLinkClick)}</h4>);
      i++;
      continue;
    }
    if (line.startsWith('## ')) {
      blocks.push(<h3 key={`h2_${i}`}>{renderInline(line.slice(3), onInternalLinkClick)}</h3>);
      i++;
      continue;
    }
    if (line.startsWith('# ')) {
      blocks.push(<h2 key={`h1_${i}`}>{renderInline(line.slice(2), onInternalLinkClick)}</h2>);
      i++;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(
          <li key={`li_${i}`}>
            {renderInline(lines[i].replace(/^\s*[-*]\s+/, ''), onInternalLinkClick)}
          </li>,
        );
        i++;
      }
      blocks.push(<ul key={`ul_${i}`}>{items}</ul>);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(
          <li key={`oli_${i}`}>
            {renderInline(lines[i].replace(/^\s*\d+\.\s+/, ''), onInternalLinkClick)}
          </li>,
        );
        i++;
      }
      blocks.push(<ol key={`ol_${i}`}>{items}</ol>);
      continue;
    }

    if (line.trim() === '---') {
      blocks.push(<hr key={`hr_${i}`} />);
      i++;
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    blocks.push(<p key={`p_${i}`}>{renderInline(line, onInternalLinkClick)}</p>);
    i++;
  }

  return <div className="nb-markdown">{blocks}</div>;
};
