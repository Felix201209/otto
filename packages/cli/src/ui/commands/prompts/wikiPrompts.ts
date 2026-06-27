/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LLM Wiki prompts - based on Karpathy's LLM Wiki pattern.
 * Wiki data lives in {project}/.llm-wiki/
 *
 * Architecture:
 *   raw/        — immutable source documents (user curated)
 *   wiki/       — LLM-maintained structured knowledge (markdown)
 *   index.md    — content catalog with links and one-line summaries
 *   log.md      — chronological append-only operation log
 */

export const WIKI_DIR = '.llm-wiki';
export const WIKI_RAW_DIR = '.llm-wiki/raw';
export const WIKI_PAGES_DIR = '.llm-wiki/wiki';
export const WIKI_INDEX = '.llm-wiki/index.md';
export const WIKI_LOG = '.llm-wiki/log.md';

export const WIKI_INIT_PROMPT = `
You are a knowledge base maintainer following the LLM Wiki pattern. Your task is to initialize a project-level wiki in the \`.llm-wiki/\` directory.

**Create the following directory structure and files:**

1. Create directory: \`.llm-wiki/raw/\` (for immutable source documents)
2. Create directory: \`.llm-wiki/wiki/\` (for LLM-maintained knowledge pages)
3. Create \`.llm-wiki/index.md\` with this initial content:

\`\`\`markdown
# LLM Wiki Index

> Auto-maintained by Otto. Do not edit manually.

## Sources
<!-- Source summaries will be listed here -->

## Entities
<!-- Entity pages will be listed here -->

## Concepts
<!-- Concept pages will be listed here -->

## Synthesis
<!-- Cross-cutting analysis pages will be listed here -->
\`\`\`

4. Create \`.llm-wiki/log.md\` with this initial content:

\`\`\`markdown
# LLM Wiki Log

> Chronological record of wiki operations.

## [${new Date().toISOString().slice(0, 10)}] init | Wiki Initialized
- Created wiki directory structure
- Ready for source ingestion
\`\`\`

5. Create \`.llm-wiki/wiki/overview.md\` — a brief overview page about this project based on what you can learn from the project root (README, package.json, etc.). Include YAML frontmatter with tags and date.

After creating all files, confirm the structure is ready and suggest what sources the user might want to ingest first.
`;

export function getWikiIngestPrompt(sourcePath: string): string {
  return `
You are a knowledge base maintainer following the LLM Wiki pattern. The wiki lives in \`.llm-wiki/\`.

**Your task: Ingest a new source document and update the wiki.**

Source to ingest: \`${sourcePath}\`

**Workflow:**

1. **Read the source** — Read the file at \`${sourcePath}\` completely.
2. **Discuss & extract** — Identify key entities, concepts, facts, claims, and relationships.
3. **Create source summary** — Write a summary page in \`.llm-wiki/wiki/\` named after the source (e.g., \`source-<name>.md\`). Include:
   - YAML frontmatter: \`type: source\`, \`source_path\`, \`date\`, \`tags\`
   - Key takeaways
   - Important entities and concepts mentioned
   - Notable claims or data points
4. **Update entity/concept pages** — For each significant entity or concept:
   - If a page already exists in \`wiki/\`, update it with new information from this source, noting the source.
   - If no page exists, create one with YAML frontmatter (\`type: entity\` or \`type: concept\`) and cross-references using \`[[wikilinks]]\`.
5. **Update index.md** — Add the new source summary and any new pages to the appropriate sections in \`.llm-wiki/index.md\`.
6. **Append to log.md** — Add an entry to \`.llm-wiki/log.md\`:
   \`## [YYYY-MM-DD] ingest | <source name>\`
   List which pages were created or updated.

**Rules:**
- Use \`[[wikilinks]]\` for cross-references between wiki pages.
- Always include YAML frontmatter with at least \`type\`, \`date\`, and \`tags\`.
- Never modify files in \`raw/\` — those are immutable source documents.
- Flag any contradictions with existing wiki content explicitly.
- A single ingest may touch 5-15 wiki pages — that's normal and expected.
`;
}

export const WIKI_INGEST_ALL_PROMPT = `
You are a knowledge base maintainer following the LLM Wiki pattern. The wiki lives in \`.llm-wiki/\`.

**Your task: Ingest ALL source documents in \`.llm-wiki/raw/\` that have not yet been ingested into the wiki.**

**Workflow:**

1. **List raw sources** — List all files in \`.llm-wiki/raw/\` (recursively).
2. **Check existing summaries** — Read \`.llm-wiki/index.md\` to see which sources have already been ingested (look for source summary entries).
3. **For each un-ingested source**, perform the full ingest workflow:
   a. Read the source file completely.
   b. Identify key entities, concepts, facts, claims, and relationships.
   c. Create a source summary page in \`wiki/\` (e.g., \`source-<name>.md\`) with YAML frontmatter.
   d. Update or create entity/concept pages with cross-references using \`[[wikilinks]]\`.
   e. Update \`index.md\` with new entries.
   f. Append an entry to \`log.md\`.
4. **After processing all sources**, provide a summary of what was ingested and what pages were created/updated.

**Rules:**
- Process sources one by one in order. Do not skip any.
- Use \`[[wikilinks]]\` for cross-references between wiki pages.
- Always include YAML frontmatter with at least \`type\`, \`date\`, and \`tags\`.
- Never modify files in \`raw/\` — those are immutable source documents.
- Flag any contradictions between sources explicitly.
- Skip sources that already have a corresponding summary page in the wiki.
`;

export function getWikiQueryPrompt(question: string): string {
  return `
You are a knowledge base assistant. The wiki lives in \`.llm-wiki/\`.

**Your task: Answer a question using the wiki.**

Question: ${question}

**Workflow:**

1. **Read index.md** — Start by reading \`.llm-wiki/index.md\` to find relevant pages.
2. **Read relevant pages** — Read the wiki pages in \`.llm-wiki/wiki/\` that are most relevant to the question.
3. **Synthesize answer** — Provide a comprehensive answer with citations to specific wiki pages.
4. **Optionally file back** — If your answer contains valuable analysis or synthesis that would be useful for future queries, ask the user if they'd like to save it as a new wiki page. Good answers compound in the knowledge base.

**Rules:**
- **ONLY read from \`.llm-wiki/wiki/\` pages. NEVER read from \`.llm-wiki/raw/\` directly.** The raw directory contains unprocessed source documents — if the wiki pages don't have the information, tell the user to run \`/wiki ingest <file>\` on the relevant raw sources first.
- Always cite which wiki pages informed your answer.
- If the wiki doesn't contain enough information, say so explicitly and suggest which raw sources or external files could be ingested to fill the gap (e.g., "Run \`/wiki ingest .llm-wiki/raw/xxx.md\` to add this knowledge to the wiki.").
- If you find contradictions between wiki pages, highlight them.
`;
}

export const WIKI_LINT_PROMPT = `
You are a knowledge base health checker. The wiki lives in \`.llm-wiki/\`.

**Your task: Perform a health check on the wiki.**

**Workflow:**

1. **Read index.md** to get the full page catalog.
2. **Scan all wiki pages** in \`.llm-wiki/wiki/\`.
3. **Check for issues:**
   - **Orphan pages**: Pages that exist in \`wiki/\` but are not listed in \`index.md\`.
   - **Dead links**: \`[[wikilinks]]\` that point to non-existent pages.
   - **Missing pages**: Concepts or entities frequently mentioned but lacking their own page.
   - **Stale content**: Pages that reference sources but may be outdated (check dates in frontmatter).
   - **Contradictions**: Claims that conflict across different pages.
   - **Missing cross-references**: Pages that should link to each other but don't.
   - **Incomplete frontmatter**: Pages missing required fields (\`type\`, \`date\`, \`tags\`).
4. **Report findings** with specific file paths and line references.
5. **Suggest improvements** — new questions to investigate, sources to look for, pages to create.
6. **Fix issues** if they are straightforward (update index, add missing cross-references, fix broken frontmatter). Ask before making larger changes.
7. **Append to log.md**: \`## [YYYY-MM-DD] lint | Health Check\` with a summary of findings and fixes.
`;
