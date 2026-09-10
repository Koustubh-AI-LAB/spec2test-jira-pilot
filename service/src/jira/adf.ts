/**
 * Jira descriptions are ADF (Atlassian Document Format): a JSON tree, not text.
 *
 * Gate 1 binds the PO's approval to a hash of the requirement, so this
 * flattening is load-bearing. If it is unstable, a document nobody touched
 * hashes differently on the next reconcile, every criterion is marked stale and
 * Gate 1 reopens for nothing. A pipeline that cries wolf gets switched off, so
 * a false drift signal is worse here than a missed one.
 *
 * Two rules keep it stable:
 *   - formatting marks (bold, italic, colour, text alignment) are ignored -
 *     restyling a requirement is not a requirement change;
 *   - every block renders to one fixed textual shape, so an unknown or newly
 *     introduced node type degrades to its text content rather than vanishing
 *     or throwing.
 */

export interface AdfNode {
  type?: string;
  version?: number;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
}

const INDENT = '  ';

function attr(node: AdfNode, key: string): string {
  const value = node.attrs?.[key];
  return value === undefined || value === null ? '' : String(value);
}

/**
 * Inline runs. Marks are deliberately not consulted: `**must**` and `must`
 * are the same requirement.
 */
function inline(nodes: AdfNode[] | undefined): string {
  if (!nodes) return '';
  return nodes.map(inlineOne).join('');
}

function inlineOne(node: AdfNode): string {
  switch (node.type) {
    case 'text':
      return node.text ?? '';
    case 'hardBreak':
      return '\n';
    // Rendered from attrs, never from the account's current display name: a PO
    // changing their nickname must not read as an edited requirement.
    case 'mention':
      return attr(node, 'id') ? `@${attr(node, 'id')}` : '@mention';
    case 'emoji':
      return attr(node, 'shortName');
    case 'date':
      return attr(node, 'timestamp');
    case 'status':
      return attr(node, 'text');
    case 'inlineCard':
    case 'blockCard':
      return attr(node, 'url');
    default:
      return inline(node.content);
  }
}

function isList(node: AdfNode): boolean {
  return node.type === 'bulletList' || node.type === 'orderedList' || node.type === 'taskList';
}

function renderListItem(item: AdfNode, out: string[], depth: number, marker: string): void {
  const children = item.content ?? [];
  // Split first: a nested list handled as both "the item's text" and "a nested
  // block" would render twice and the hash would depend on child ordering.
  const blocks = children.filter((c) => !isList(c));
  const nested = children.filter(isList);

  const headText = blocks[0] ? inline(blocks[0].content).trim() : '';
  out.push(`${INDENT.repeat(depth)}${marker} ${headText}`.trimEnd());

  for (const block of blocks.slice(1)) renderBlock(block, out, depth + 1);
  for (const list of nested) renderBlock(list, out, depth + 1);
}

function renderBlock(node: AdfNode, out: string[], depth: number): void {
  const pad = INDENT.repeat(depth);

  switch (node.type) {
    case 'doc':
      for (const child of node.content ?? []) renderBlock(child, out, depth);
      return;

    case 'paragraph':
    case 'heading': {
      const text = inline(node.content).trim();
      if (text) for (const line of text.split('\n')) out.push(pad + line.trim());
      return;
    }

    case 'codeBlock': {
      const text = inline(node.content);
      for (const line of text.split('\n')) out.push(pad + line);
      return;
    }

    case 'blockquote':
    case 'panel':
      for (const child of node.content ?? []) renderBlock(child, out, depth);
      return;

    case 'bulletList':
      (node.content ?? []).forEach((li) => renderListItem(li, out, depth, '-'));
      return;

    case 'orderedList':
      (node.content ?? []).forEach((li, i) => renderListItem(li, out, depth, `${i + 1}.`));
      return;

    case 'taskList':
      (node.content ?? []).forEach((li) => renderListItem(li, out, depth, '-'));
      return;

    case 'table':
      for (const row of node.content ?? []) {
        const cells = (row.content ?? []).map((cell) => inline(cell.content ?? []).trim());
        out.push(pad + cells.join(' | '));
      }
      return;

    // Decorative or non-textual: carry no requirement meaning, and their attrs
    // churn (media ids, widths) would produce phantom drift.
    case 'rule':
    case 'mediaSingle':
    case 'mediaGroup':
    case 'media':
      return;

    default:
      if (node.content) {
        for (const child of node.content) renderBlock(child, out, depth);
      } else {
        const text = inlineOne(node).trim();
        if (text) out.push(pad + text);
      }
  }
}

/**
 * ADF document (or a plain string, which the v2 API and some clients still
 * send) to canonical plain text.
 */
export function adfToText(doc: unknown): string {
  if (doc === null || doc === undefined) return '';
  if (typeof doc === 'string') return doc.replace(/\r\n/g, '\n').trim();

  const root = doc as AdfNode;
  // Blank line between top-level blocks, none between list items. Done
  // per-block rather than globally: without it, two paragraphs and a single
  // paragraph containing a line break flatten identically and hash the same,
  // so splitting a requirement in two would not register as a change.
  const blocks = root.type === 'doc' ? (root.content ?? []) : [root];
  const groups: string[] = [];
  for (const block of blocks) {
    const lines: string[] = [];
    renderBlock(block, lines, 0);
    if (lines.length) groups.push(lines.join('\n'));
  }
  return groups.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The exact text Gate 1's hash is taken over. Summary is included on purpose:
 * retitling "may hold 3 books" to "may hold 5 books" is a requirement change,
 * and hashing the description alone would miss it entirely.
 */
export function requirementText(summary: string, description: unknown): string {
  return [summary.trim(), adfToText(description)].filter(Boolean).join('\n\n');
}

/** Plain text to a minimal ADF document, for comments we post back. */
export function textToAdf(text: string): AdfNode {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim());
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((p) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: p.replace(/\n/g, ' ').trim() }],
    })),
  };
}
