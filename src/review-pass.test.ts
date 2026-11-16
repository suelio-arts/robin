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
const linear = async () => true;

describe("reviewPass", () => {
  it("reviews the whole change below the cap, counting only Robin's reviewed heads", async () => {
    const load = jest.fn();
    const below = [reviewed(1, head("1")), reviewed(2, head("2")), reviewed(4, head("2")),
      { id: 5, user: { login: "someone", type: "User" }, body: reviewed(5, head("5")).body },
      { id: 6, user: bot, body: `## ${ROBIN_SIGNATURE}\n<!-- robin-outcome: v1 incomplete head=${head("6")} -->` }];
    expect(await reviewPass(below, head("9"), linear, load)).toEqual({ kind: "full" });
    expect(load).not.toHaveBeenCalled();
  });

  it("at the cap, passes only the last review's thread and body Highs to one fix-only pass", async () => {
    const other = { ...thread, pull_request_review_id: 2, body: "**Robin** — :rotating_light: HIGH\n\nolder" };
    const medium = { ...thread, body: "**Robin** — :warning: MEDIUM\n\nnit" };
    const pass = await reviewPass(capped, head("9"), linear, async () => [thread, other, medium]);
    expect(pass).toEqual({ kind: "fix", since: head("3"), highs: ["a.ts:4: " + thread.body, ":rotating_light: **1 (`a.ts`)** — unplaced"] });
    if (pass.kind === "fix") expect(fixPassInstructions(pass)).toContain("not needed to fix them");
  });

  it.each([
    ["the fix pass was used", [...capped, { id: 7, user: bot, body: `## ${ROBIN_SIGNATURE}\n${fixPassMarker(head("3"))}` }], head("9"), linear, [thread], /already ran its fix-only pass/],
    ["nothing changed", capped, head("3"), linear, [thread], /Nothing changed/],
    ["history was merged or rewritten", capped, head("9"), async () => false, [thread], /merges or rewrites history/],
    ["no High to fix", [reviewed(1, head("1")), reviewed(2, head("2")), reviewed(3, head("3"))], head("9"), linear, [], /no High finding/],
  ])("is capped when %s", async (_name, reviews, current, isLinear, comments, reason) => {
    const pass = await reviewPass(reviews, current, isLinear, async () => comments);
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

describe("GitUtils.isLinearDescendant", () => {
  it("accepts only a merge-free extension of the reviewed head", async () => {
    const dir = mkdtempSync(join(tmpdir(), "robin-linear-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
    try {
      git("init", "-q", "-b", "main");
      git("config", "user.email", "t@example.invalid"); git("config", "user.name", "t");
      const commit = (name: string) => { writeFileSync(join(dir, name), name); git("add", name); git("commit", "-qm", name); return git("rev-parse", "HEAD"); };
      const reviewedHead = commit("a");
      const fix = commit("b");
      git("checkout", "-qb", "side", reviewedHead); const side = commit("c");
      git("checkout", "-q", "main"); git("merge", "-q", "--no-edit", "side"); const merged = git("rev-parse", "HEAD");
      const utils = new GitUtils({} as never, dir);
      expect(await utils.isLinearDescendant(reviewedHead, fix)).toBe(true);
      expect(await utils.isLinearDescendant(reviewedHead, merged)).toBe(false);
      expect(await utils.isLinearDescendant(fix, side)).toBe(false);
      expect(await utils.isLinearDescendant(head("e"), fix)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
