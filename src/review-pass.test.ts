import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubReviewer, ROBIN_SIGNATURE } from "./github-reviewer";
import { GitUtils } from "./git-utils";
import { fixPassMarker } from "./outcome";
import { fixPassInstructions, reviewPass } from "./review-pass";

const head = (c: string) => c.repeat(40);
const bot = { login: "github-actions[bot]", type: "Bot" };
const reviewed = (id: number, sha: string, extra = "") => ({
  id, user: bot, body: `## ${ROBIN_SIGNATURE}${extra}\n\n<!-- robin-outcome: v1 reviewed head=${sha} high=1 medium=0 low=0 suggestions=0 -->`,
});
const capped = [reviewed(1, head("1")), reviewed(2, head("2")),
  reviewed(3, head("3"), "\n\n### :page_facing_up: Findings Not Posted Inline\n\n:rotating_light: **1 (`a.ts`)** — unplaced\n\n:warning: **2** — medium\n\n---\nfooter")];
const thread = { pull_request_review_id: 3, path: "a.ts", line: 4, body: "**Robin** — :rotating_light: HIGH\n\nwrong merge" };
const fixDiff = async () => "diff --git a/a.ts b/a.ts\n+fixed\n";

describe("reviewPass", () => {
  it("reviews the whole change below the cap, counting only Robin's reviewed heads", async () => {
    const load = jest.fn();
    const below = [reviewed(1, head("1")), reviewed(2, head("2")), reviewed(4, head("2")),
      { id: 5, user: { login: "someone", type: "User" }, body: reviewed(5, head("5")).body },
      { id: 6, user: bot, body: `## ${ROBIN_SIGNATURE}\n<!-- robin-outcome: v1 incomplete head=${head("6")} -->` }];
    expect(await reviewPass(below, head("9"), fixDiff, load)).toEqual({ kind: "full" });
    expect(load).not.toHaveBeenCalled();
  });

  it("at the cap, passes only the last review's thread and body Highs to one fix-only pass", async () => {
    const other = { ...thread, pull_request_review_id: 2, body: "**Robin** — :rotating_light: HIGH\n\nolder" };
    const medium = { ...thread, body: "**Robin** — :warning: MEDIUM\n\nnit" };
    const pass = await reviewPass(capped, head("9"), fixDiff, async () => [thread, other, medium]);
    expect(pass).toEqual({ kind: "fix", since: head("3"), highs: ["a.ts:4: " + thread.body, ":rotating_light: **1 (`a.ts`)** — unplaced"],
      diff: "diff --git a/a.ts b/a.ts\n+fixed\n" });
    if (pass.kind === "fix") expect(fixPassInstructions(pass)).toContain("not needed to fix them");
  });

  it.each([
    ["the fix pass was used", [...capped, { id: 7, user: bot, body: `## ${ROBIN_SIGNATURE}\n${fixPassMarker(head("3"))}` }], head("9"), fixDiff, [thread], /already ran its fix-only pass/],
    ["nothing changed", capped, head("3"), fixDiff, [thread], /Nothing changed/],
    ["history was rewritten or a merge resolved by hand", capped, head("9"), async () => undefined, [thread], /rewrites history or resolves a merge by hand/],
    ["only merges changed", capped, head("9"), async () => "", [thread], /Only merges changed/],
    ["no High to fix", [reviewed(1, head("1")), reviewed(2, head("2")), reviewed(3, head("3"))], head("9"), fixDiff, [], /no High finding/],
  ])("is capped when %s", async (_name, reviews, current, authorDiff, comments, reason) => {
    const pass = await reviewPass(reviews, current, authorDiff, async () => comments);
    expect(pass.kind).toBe("capped");
    if (pass.kind === "capped") expect(pass.reason).toMatch(reason);
  });
});

describe("fix-only pass review", () => {
  const files = [{ filename: "a.ts", patch: "@@ -1 +1,4 @@\n-x\n+a\n+b\n+c\n+d" }];
  const post = async (high: object[]) => {
    const createReview = jest.fn().mockResolvedValue({ data: { id: 30, html_url: "u" } });
    const octokit = {
      paginate: jest.fn().mockImplementation(async (method) => method === "files" ? files : []),
      rest: { pulls: { createReview, listFiles: "files", listReviews: "reviews", dismissReview: jest.fn() } },
    };
    const findings = { summary: "s", medium: [], low: [], suggestions: [], rawResponse: "", high } as any;
    const posted = await new GitHubReviewer(octokit as any).postReview("o", "r", 7, findings, false, undefined, head("9"), head("3"));
    return { request: createReview.mock.calls[0][0], posted };
  };

  it("approves only when the fix holds, and stamps the fix-pass marker without a reuse key", async () => {
    const clean = await post([]);
    expect(clean.request.event).toBe("APPROVE");
    expect(clean.request.body).toContain(fixPassMarker(head("3")));
    expect(clean.request.body).not.toContain("robin-review-key");
    const held = await post([{ severity: "high", file: "a.ts", line: 2, description: "not fixed" }]);
    expect(held.request.event).toBe("COMMENT");
    expect(held.request.comments).toHaveLength(1);
    expect(held.posted.verdict).toBe("COMMENTED");
  });
});

describe("GitUtils.authorDiff", () => {
  it("keeps the author's commits, drops clean merges of main, and refuses hand-resolved merges or rewritten history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "robin-author-diff-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
    try {
      git("init", "-q", "-b", "main");
      git("config", "user.email", "t@example.invalid"); git("config", "user.name", "t");
      const commit = (name: string, text = name) => { writeFileSync(join(dir, name), text + "\n"); git("add", name); git("commit", "-qm", name); return git("rev-parse", "HEAD"); };
      commit("shared", "base");
      git("checkout", "-qb", "topic"); const reviewedHead = commit("topic");
      git("checkout", "-q", "main"); commit("main-only");
      git("checkout", "-q", "topic"); git("merge", "-q", "--no-edit", "main"); const cleanMerge = git("rev-parse", "HEAD");
      const fix = commit("fix");
      const utils = new GitUtils({} as never, dir);
      const diff = await utils.authorDiff(reviewedHead, fix);
      expect(diff).toContain("b/fix");
      expect(diff).not.toContain("main-only");
      expect(await utils.authorDiff(reviewedHead, cleanMerge)).toBe("");
      git("checkout", "-q", "main"); commit("shared", "main side");
      git("checkout", "-q", "topic"); commit("shared", "topic side");
      try { git("merge", "-q", "--no-edit", "main"); } catch { writeFileSync(join(dir, "shared"), "resolved\n"); git("add", "shared"); git("commit", "-qm", "resolve"); }
      expect(await utils.authorDiff(reviewedHead, git("rev-parse", "HEAD"))).toBeUndefined();
      git("checkout", "-q", "main");
      expect(await utils.authorDiff(reviewedHead, git("rev-parse", "HEAD"))).toBeUndefined();
      expect(await utils.authorDiff("e".repeat(40), fix)).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
