/**
 * Shared recognition of "this file is a Robin workflow".
 *
 * Two consumers need the same answer and must not drift: the installer
 * (bin/robin-review.js) archives historical Robin workflows before writing the
 * canonical one, and the consumer CLI (bin/robin-pr.js) preflights whether the
 * repository actually has an active Robin workflow before it waits for a run or
 * posts `/robin`.
 *
 * Recognition parses the YAML rather than scanning lines: a `uses:` line inside
 * a `run: |` script block is text, not a workflow reference, and `on` may be a
 * string, a sequence, a block mapping, or a flow mapping. A file we cannot parse
 * is treated as not-Robin, which is the safe answer on both sides — the
 * installer leaves it alone and the CLI neither waits nor posts.
 *
 * Robin ships from two owners: antongulin/robin (public) and suelio-arts/robin
 * (the fork MIX pins).
 */

const YAML = require("yaml");

/** Fully anchored: a reference must carry a complete, well-formed ref after the `@`. */
const ROBIN_USES =
  /^(?:antongulin|suelio-arts)\/(?:robin|universal-code-reviewer)(?:\/\.github\/workflows\/review\.ya?ml)?@[A-Za-z0-9._/-]+$/;

/**
 * A modern Robin pin, whose owner and ref the installer preserves — in either
 * shape, since consumers pin the fork as a direct action step. Only the `robin`
 * repository counts: legacy `universal-code-reviewer` references migrate to the
 * current defaults instead of being carried forward.
 */
const MODERN_PIN =
  /^(antongulin|suelio-arts)\/robin(?:\/\.github\/workflows\/review\.ya?ml)?@([A-Za-z0-9._/-]+)$/;

const DEFAULT_OWNER = "antongulin";

function parseWorkflow(source) {
  try {
    const document = YAML.parse(String(source || ""), { logLevel: "silent" });
    return document && typeof document === "object" ? document : null;
  } catch {
    return null;
  }
}

/** Every `uses:` value a job or one of its steps actually resolves — never script text. */
function usesValues(document) {
  const values = [];
  const jobs = document && document.jobs;
  if (!jobs || typeof jobs !== "object") return values;
  for (const job of Object.values(jobs)) {
    if (!job || typeof job !== "object") continue;
    if (typeof job.uses === "string") values.push(job.uses.trim());
    if (!Array.isArray(job.steps)) continue;
    for (const step of job.steps) {
      if (step && typeof step === "object" && typeof step.uses === "string") values.push(step.uses.trim());
    }
  }
  return values;
}

const isRobinWorkflow = (source) => usesValues(parseWorkflow(source)).some((value) => ROBIN_USES.test(value));

/**
 * The owner and ref this repository already pins, so re-running the installer
 * never silently moves a fork consumer back to the public action or drops its
 * pinned SHA. The generated workflow is always the reusable form; only the
 * owner and ref are carried over.
 */
function robinWorkflowPin(source) {
  for (const value of usesValues(parseWorkflow(source))) {
    const match = value.match(MODERN_PIN);
    if (match) return { owner: match[1], ref: match[2] };
  }
  return null;
}

const namesCreated = (types) => {
  if (types === undefined || types === null) return true;
  if (Array.isArray(types)) return types.includes("created");
  return types === "created";
};

/**
 * Does this workflow answer a `/robin` comment? It must declare an
 * `issue_comment` trigger with no `types` filter, or one that includes
 * `created`. A workflow that only offers `workflow_call` or `pull_request`
 * cannot be started by commenting, so `--rerun` must not try.
 */
function hasIssueCommentTrigger(source) {
  const document = parseWorkflow(source);
  if (!document) return false;
  // YAML 1.1 readers fold an unquoted `on` key to boolean true; accept both.
  const on = document.on !== undefined ? document.on : document[true];
  if (on === undefined || on === null) return false;
  if (typeof on === "string") return on === "issue_comment";
  if (Array.isArray(on)) return on.includes("issue_comment");
  if (typeof on !== "object") return false;
  if (!Object.prototype.hasOwnProperty.call(on, "issue_comment")) return false;
  const config = on.issue_comment;
  if (!config || typeof config !== "object") return true;
  return namesCreated(config.types);
}

module.exports = { DEFAULT_OWNER, isRobinWorkflow, hasIssueCommentTrigger, robinWorkflowPin };
