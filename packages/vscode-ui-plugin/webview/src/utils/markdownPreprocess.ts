/**
 * Defensive preprocessing for LLM-emitted markdown text.
 *
 * Real-world LLM outputs (observed in user bug reports) sometimes glue the
 * opening fence, the language tag, the body, and the closing fence onto a
 * single line — e.g. ```bashopen ios/Runner.xcworkspace```. Per CommonMark
 * spec, an opening fence must end the line, so react-markdown treats this
 * pattern as inline code, losing the language hint, the syntax-highlighting
 * affordance, and the copy button.
 *
 * `rehabGluedSingleLineFences` rewrites such single-line fences into proper
 * multi-line block fences:
 *
 *     ```bashopen ios/foo```
 * becomes
 *     ```bash
 *     open ios/foo
 *     ```
 *
 * It also handles bogus glued language tags by:
 *   1. Trying to split a known-language prefix from the captured token
 *      (`bashopen` → `bash` + `open`).
 *   2. Falling back to no language and treating the whole token as body.
 */

// Known language identifiers (lowercase). Mirror the CLI-side allowlist.
// Includes lowlight's `common` set plus popular aliases LLMs frequently emit.
const KNOWN_FENCE_LANGS = new Set<string>([
  // lowlight "common" set
  'arduino', 'bash', 'c', 'cpp', 'csharp', 'css', 'diff', 'go', 'graphql',
  'ini', 'java', 'javascript', 'json', 'kotlin', 'less', 'lua', 'makefile',
  'markdown', 'objectivec', 'perl', 'php', 'php-template', 'plaintext',
  'python', 'python-repl', 'r', 'ruby', 'rust', 'scss', 'shell', 'sql',
  'swift', 'typescript', 'vbnet', 'wasm', 'xml', 'yaml',
  // Common aliases / extensions
  'js', 'jsx', 'ts', 'tsx', 'sh', 'zsh', 'fish', 'powershell', 'ps1', 'pwsh',
  'bat', 'cmd', 'cs', 'fs', 'fsharp', 'kt', 'kts', 'rb', 'py', 'rs', 'dart',
  'flutter', 'dockerfile', 'docker', 'toml', 'csv', 'tsv', 'log', 'md', 'mdx',
  'html', 'htm', 'svg', 'vue', 'svelte', 'astro', 'tex', 'latex', 'bibtex',
  'asm', 'nasm', 'gas', 'vim', 'viml', 'lisp', 'clojure', 'clj', 'cljs',
  'elixir', 'ex', 'exs', 'erlang', 'erl', 'haskell', 'hs', 'ocaml', 'ml',
  'scala', 'groovy', 'gradle', 'cmake', 'mermaid', 'plantuml', 'graphviz',
  'dot', 'protobuf', 'proto', 'thrift', 'capnp', 'nginx', 'apache', 'caddy',
  'env', 'conf', 'config', 'properties', 'gitignore', 'gitconfig',
  // Generic/text-y
  'text', 'plain', 'plaintext', 'txt', 'console', 'output', 'terminal',
  'c++', 'c#', 'obj-c', 'objective-c',
]);

const KNOWN_FENCE_LANGS_BY_LEN = [...KNOWN_FENCE_LANGS].sort(
  (a, b) => b.length - a.length,
);

function splitGluedLang(token: string): { lang: string; leftover: string } | null {
  if (!token) return null;
  const lower = token.toLowerCase();
  for (const known of KNOWN_FENCE_LANGS_BY_LEN) {
    if (lower.startsWith(known) && lower.length > known.length) {
      return {
        lang: token.slice(0, known.length),
        leftover: token.slice(known.length),
      };
    }
  }
  return null;
}

/**
 * Match a single-line glued fence: ```<lang?><body>``` (no internal newline).
 * The lang/body split mirrors the CLI parser:
 *   - lang is `[A-Za-z0-9_+#-]*` (excludes '.' and '/' so paths fall into body)
 *   - body is everything between lang and the closing fence
 *
 * Captures:
 *   1: opening fence run (``` or ~~~ or longer)
 *   2: lang token (may be empty)
 *   3: body (may include leading whitespace)
 *   4: closing fence run
 */
const GLUED_FENCE_RE =
  /(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+#-]*)[ \t]*([^\n`~]*?)[ \t]*(`{3,}|~{3,})/g;

export function rehabGluedSingleLineFences(text: string): string {
  if (!text || (!text.includes('```') && !text.includes('~~~'))) return text;

  return text.replace(
    GLUED_FENCE_RE,
    (whole, openFence: string, rawLang: string, rawBody: string, closeFence: string) => {
      // Sanity check: same fence char family, closer at least as long.
      if (openFence[0] !== closeFence[0]) return whole;
      if (closeFence.length < openFence.length) return whole;

      let lang = rawLang || '';
      let body = rawBody || '';

      // Resolve glued bogus language tag.
      if (lang) {
        const normalized = lang.toLowerCase();
        if (!KNOWN_FENCE_LANGS.has(normalized)) {
          const split = splitGluedLang(lang);
          if (split) {
            // bashopen → bash + open
            const needsSpace = body.length > 0 && !/^[\s/.]/.test(body);
            body = body.length > 0
              ? `${split.leftover}${needsSpace ? ' ' : ''}${body}`
              : split.leftover;
            lang = split.lang;
          } else {
            // Unknown token → push to body, drop lang.
            const needsSpace = body.length > 0 && !/^[\s/.]/.test(body);
            body = body.length > 0
              ? `${lang}${needsSpace ? ' ' : ''}${body}`
              : lang;
            lang = '';
          }
        }
      }

      // If body is genuinely empty, leave the original text alone — the empty
      // block heuristic in `CodeBlock` will hide it gracefully.
      if (!body.trim()) return whole;

      // Promote to multi-line block fence. Keep the original opening fence
      // length to preserve nesting semantics. Surround with newlines so this
      // is parsed as a block by remark.
      return `\n${openFence}${lang}\n${body}\n${closeFence}\n`;
    },
  );
}
