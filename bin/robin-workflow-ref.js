/**
 * Shared recognition of "this file is a Robin workflow".
 *
 * Two consumers need the same answer and must not drift: the installer
 * (bin/robin-review.js) archives historical Robin workflows before writing the
 * canonical one, and the consumer CLI (bin/robin-pr.js) preflights whether the
 * repository actually has an active Robin workflow before it waits for a run or
 * posts `/robin`.
 *
 * Robin ships from two owners — antongulin/robin (public) and suelio-arts/robin
 * (the fork MIX pins as a direct action step) — in two shapes: the reusable
 * workflow (`uses: <owner>/robin/.github/workflows/review.yml@ref`) and the
 * action step (`- uses: <owner>/robin@ref`). All four combinations count.
 */

const ROBIN_OWNER = "(?:antongulin|suelio-arts)";
const ROBIN_REPO = "(?:robin|universal-code-reviewer)";

/** A workflow file that runs Robin in any supported shape. */
const robinReference = new RegExp(
  `^[ \\t]*(?:-[ \\t]*)?uses:\\s*${ROBIN_OWNER}\\/${ROBIN_REPO}(?:\\/\\.github\\/workflows\\/review\\.ya?ml)?@[^\\s#]+`,
  "im"
);

/**
 * The ref of a modern reusable-workflow reference, so the installer can preserve
 * a consumer's existing pin. Only the canonical published path qualifies: the
 * installer regenerates that exact line.
 */
const currentRobinRef =
  /^[ \t]*(?:-[ \t]*)?uses:\s*antongulin\/robin\/\.github\/workflows\/review\.ya?ml@([A-Za-z0-9._/-]+)/im;

const isRobinWorkflow = (source) => robinReference.test(String(source || ""));

const uncomment = (value) => String(value).replace(/\s+#.*$/, "").trim();
const indentOf = (line) => line.match(/^[ \t]*/)[0].length;
const isBlank = (line) => !line.trim() || /^\s*#/.test(line);

/** The `on:` mapping: its inline value (if any) and the indented block under it. */
function triggerSection(source) {
  const lines = String(source || "").replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].match(/^(?:on|"on"|'on'):[ \t]*(.*)$/);
    if (!header) continue;
    const block = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (isBlank(line)) {
        block.push(line);
        continue;
      }
      if (!/^[ \t]/.test(line)) break;
      block.push(line);
    }
    return { inline: uncomment(header[1]), block };
  }
  return null;
}

const namesEvent = (value, event) =>
  new RegExp(`(^|[[,\\s])${event}(\\s*[\\],]|\\s*$)`).test(value);

/**
 * Does this workflow answer a `/robin` comment? It must declare an
 * `issue_comment` trigger with no `types` filter, or one that includes
 * `created`. A workflow that only offers `workflow_call` or `pull_request`
 * cannot be started by commenting, so `--rerun` must not try.
 */
function hasIssueCommentTrigger(source) {
  const section = triggerSection(source);
  if (!section) return false;
  if (section.inline) return namesEvent(section.inline, "issue_comment");

  const lines = section.block;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^[ \t]*-[ \t]*issue_comment[ \t]*$/.test(lines[index])) return true;
    const key = lines[index].match(/^([ \t]*)issue_comment:[ \t]*(.*)$/);
    if (!key) continue;
    const indent = key[1].length;
    const inline = uncomment(key[2]);
    if (inline && inline !== "{}") return namesEvent(inline, "created");
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (isBlank(lines[cursor])) continue;
      if (indentOf(lines[cursor]) <= indent) break;
      const types = lines[cursor].match(/^[ \t]*types:[ \t]*(.*)$/);
      if (!types) continue;
      const inlineTypes = uncomment(types[1]);
      if (inlineTypes) return namesEvent(inlineTypes, "created");
      for (let item = cursor + 1; item < lines.length; item += 1) {
        if (isBlank(lines[item])) continue;
        if (indentOf(lines[item]) <= indent) break;
        const entry = lines[item].match(/^[ \t]*-[ \t]*([A-Za-z_]+)[ \t]*$/);
        if (!entry) break;
        if (entry[1] === "created") return true;
      }
      return false;
    }
    return true;
  }
  return false;
}

module.exports = { robinReference, currentRobinRef, isRobinWorkflow, hasIssueCommentTrigger };
