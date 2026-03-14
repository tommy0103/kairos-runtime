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
  for (const t of tokens) out += one(t, state);
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
