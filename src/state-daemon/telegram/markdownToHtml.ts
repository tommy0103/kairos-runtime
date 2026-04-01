import MarkdownIt from "markdown-it";

const md = new MarkdownIt();

type Token = ReturnType<typeof md.parse>[number];

const SIMPLE_TAGS: Record<string, string> = {
  strong_open: "<b>",    strong_close: "</b>",
  em_open: "<i>",        em_close: "</i>",
  s_open: "<s>",         s_close: "</s>",
  heading_open: "<b>",   heading_close: "</b>\n\n",
  blockquote_open: "<blockquote>", blockquote_close: "</blockquote>\n",
  paragraph_open: "",
  hr: "\n",
};

interface State {
  lists: Array<{ ordered: boolean; n: number }>;
}

export function markdownToTelegramHtml(markdown: string): string {
  const tokens = md.parse(markdown, {});
  return render(tokens, { lists: [] }).replace(/\n{3,}/g, "\n\n").trim();
}

function render(tokens: Token[], state: State): string {
  let out = "";
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].type === "table_open") {
      const { html, end } = renderTable(tokens, i, state);
      out += html;
      i = end + 1;
    } else {
      out += one(tokens[i], state);
      i++;
    }
  }
  return out;
}

function renderTable(tokens: Token[], start: number, state: State): { html: string; end: number } {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let i = start + 1;

  while (i < tokens.length && tokens[i].type !== "table_close") {
    const t = tokens[i];
    if (t.type === "tr_open") {
      currentRow = [];
    } else if (t.type === "tr_close") {
      rows.push(currentRow);
    } else if (t.type === "th_open" || t.type === "td_open") {
      // next token should be inline with the cell content
      i++;
      const cellContent = i < tokens.length && tokens[i].type === "inline"
        ? (tokens[i].children ? plainText(tokens[i].children!) : tokens[i].content)
        : "";
      currentRow.push(cellContent);
      // skip the th_close/td_close
      i++;
    } else {
      // thead_open, thead_close, tbody_open, tbody_close — skip
    }
    i++;
  }

  if (rows.length === 0) return { html: "", end: i };

  // calculate column widths
  const colCount = Math.max(...rows.map(r => r.length));
  const widths: number[] = Array(colCount).fill(0);
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      widths[c] = Math.max(widths[c], row[c].length);
    }
  }

  // build text table
  const lines: string[] = [];
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r].map((cell, c) => cell.padEnd(widths[c]));
    lines.push(cells.join(" | "));
    if (r === 0) {
      lines.push(widths.map(w => "-".repeat(w)).join("-+-"));
    }
  }

  return { html: `<pre>${esc(lines.join("\n"))}</pre>\n`, end: i };
}

function plainText(tokens: Token[]): string {
  let out = "";
  for (const t of tokens) {
    if (t.type === "text") out += t.content;
    else if (t.type === "code_inline") out += t.content;
    else if (t.type === "softbreak" || t.type === "hardbreak") out += " ";
    else if (t.children) out += plainText(t.children);
  }
  return out;
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escAttr(s: string) {
  return esc(s).replace(/"/g, "&quot;");
}

function one(t: Token, state: State): string {
  if (t.type in SIMPLE_TAGS) return SIMPLE_TAGS[t.type];

  switch (t.type) {
    case "inline":
      return t.children ? render(t.children, state) : "";
    case "text":
      return esc(t.content);
    case "softbreak":
    case "hardbreak":
      return "\n";

    case "paragraph_close":
      if (t.hidden) return "\n";
      return state.lists.length > 0 ? "\n" : "\n\n";

    case "code_inline":
      return `<code>${esc(t.content)}</code>`;
    case "fence": {
      const lang = t.info.trim();
      const cls = lang ? ` class="language-${escAttr(lang)}"` : "";
      return `<pre><code${cls}>${esc(t.content.trimEnd())}</code></pre>\n`;
    }
    case "code_block":
      return `<pre><code>${esc(t.content.trimEnd())}</code></pre>\n`;

    case "link_open":
      return `<a href="${escAttr(t.attrGet("href") ?? "")}">`;
    case "link_close":
      return "</a>";
    case "image": {
      const src = t.attrGet("src") ?? "";
      return src
        ? `<a href="${escAttr(src)}">${esc(t.content || "image")}</a>`
        : esc(t.content);
    }

    case "bullet_list_open":
      state.lists.push({ ordered: false, n: 0 });
      return "";
    case "ordered_list_open":
      state.lists.push({ ordered: true, n: 0 });
      return "";
    case "bullet_list_close":
    case "ordered_list_close":
      state.lists.pop();
      return state.lists.length === 0 ? "\n" : "";

    case "list_item_open": {
      const list = state.lists[state.lists.length - 1];
      if (!list) return "";
      list.n++;
      const indent = "  ".repeat(Math.max(0, state.lists.length - 1));
      return `${indent}${list.ordered ? `${list.n}.` : "\u2022"} `;
    }
    case "list_item_close":
      return "";

    case "html_block":
    case "html_inline":
      return esc(t.content);

    default:
      return t.children
        ? render(t.children, state)
        : t.content ? esc(t.content) : "";
  }
}
