import { GitHubReviewer, reviewKey, cacheMarker, reuseDecision, ROBIN_SIGNATURE } from "./github-reviewer";
import { parseOutcomeMarker } from "./outcome";

const HEAD = "a".repeat(40);
const OLD_HEAD = "b".repeat(40);

describe("GitHubReviewer", () => {
  it("approves a complete review only when every High is an inline thread", () => {
    expect(GitHubReviewer.resolveReviewEvent(true, true, true)).toBe("REQUEST_CHANGES");
    expect(GitHubReviewer.resolveReviewEvent(true, false, true)).toBe("REQUEST_CHANGES");
    expect(GitHubReviewer.resolveReviewEvent(false, true, true)).toBe("APPROVE");
    expect(GitHubReviewer.resolveReviewEvent(true, true, false)).toBe("APPROVE");
    expect(GitHubReviewer.resolveReviewEvent(true, false, false)).toBe("COMMENT");
    expect(GitHubReviewer.resolveReviewEvent(false, true, false)).toBe("APPROVE");
  });

  it("carries a reused review as an approval unless a High stayed in its body", () => {
    const body = "## " + ROBIN_SIGNATURE;
    const bodyOnlyHigh = body + "\n\n### :page_facing_up: Findings Not Posted Inline\n\n:rotating_light: **1** — unsafe";
    const bodyOnlyLow = body + "\n\n### :page_facing_up: Findings Not Posted Inline\n\n:large_blue_circle: **1** — nit";
    expect(GitHubReviewer.carriedEvent({event: "COMMENT", body, counts: null})).toBe("APPROVE");
    expect(GitHubReviewer.carriedEvent({event: "COMMENT", body: bodyOnlyLow, counts: null})).toBe("APPROVE");
    expect(GitHubReviewer.carriedEvent({event: "COMMENT", body: bodyOnlyHigh, counts: null})).toBe("COMMENT");
    expect(GitHubReviewer.carriedEvent({event: "APPROVE", body: bodyOnlyHigh, counts: null})).toBe("COMMENT");
    expect(GitHubReviewer.carriedEvent({event: "REQUEST_CHANGES", body, counts: null})).toBe("REQUEST_CHANGES");
  });

  it("posts only High findings inline; Medium and Low stay in the body", async () => {
    const createReview = jest.fn().mockResolvedValue({ data: { id: 25, html_url: "u" } });
    const files = [{ filename: "src/a.ts", patch: "@@ -1 +1,2 @@\n-x\n+y\n+z" }];
    const octokit = {
      paginate: jest.fn().mockImplementation(async (method) => method === "files" ? files : []),
      rest: { pulls: { createReview, listFiles: "files", listReviews: "reviews", dismissReview: jest.fn() } },
    };
    const findings = {
      summary: "s", suggestions: [], rawResponse: "",
      high: [{ severity: "high", file: "src/a.ts", line: 1, description: "high one" }],
      medium: [{ severity: "medium", file: "src/a.ts", line: 2, description: "medium one" }],
      low: [{ severity: "low", file: "src/a.ts", line: 2, description: "low one" }],
    } as any;

    const posted = await new GitHubReviewer(octokit as any).postReview("o", "r", 7, findings, false, undefined, HEAD);

    const request = createReview.mock.calls[0][0];
    expect(request.event).toBe("APPROVE");
    expect(request.comments).toHaveLength(1);
    expect(request.comments[0].body).toContain("high one");
    expect(request.body).toContain("medium one");
    expect(request.body).toContain("low one");
    expect(GitHubReviewer.hasUnpostedHighFinding(request.body)).toBe(false);
    expect(posted.verdict).toBe("APPROVED");
  });

  it.each([
    ["has no location", { severity: "high", description: "unplaced" }, 25],
    ["exceeds max-comments", { severity: "high", file: "src/a.ts", line: 1, description: "over the cap" }, 0],
  ])("does not approve when a High %s", async (_case, high, maxComments) => {
    const createReview = jest.fn().mockResolvedValue({ data: { id: 26, html_url: "u" } });
    const octokit = {
      paginate: jest.fn().mockImplementation(async (method) => method === "files" ? [{ filename: "src/a.ts", patch: "@@ -1 +1 @@\n-x\n+y" }] : []),
      rest: { pulls: { createReview, listFiles: "files", listReviews: "reviews", dismissReview: jest.fn() } },
    };
    const findings = { summary: "s", medium: [], low: [], suggestions: [], rawResponse: "", high: [high] } as any;

    const posted = await new GitHubReviewer(octokit as any, maxComments).postReview("o", "r", 7, findings, false, "f".repeat(64), HEAD);

    expect(createReview.mock.calls[0][0].event).toBe("COMMENT");
    expect(createReview.mock.calls[0][0].body).toContain(cacheMarker("f".repeat(64), "COMMENT"));
    expect(posted.verdict).toBe("COMMENTED");
  });

  it("does not approve when GitHub rejects the inline High and the summary carries it", async () => {
    const createReview = jest.fn()
      .mockRejectedValueOnce({ status: 422, response: { data: { errors: [{ field: "comments.line", code: "invalid" }] } } })
      .mockResolvedValueOnce({ data: { id: 27, html_url: "u" } });
    const octokit = {
      paginate: jest.fn().mockImplementation(async (method) => method === "files" ? [{ filename: "src/a.ts", patch: "@@ -1 +1 @@\n-x\n+y" }] : []),
      rest: { pulls: { createReview, listFiles: "files", listReviews: "reviews", dismissReview: jest.fn() } },
    };
    const findings = { summary: "s", medium: [], low: [], suggestions: [], rawResponse: "",
      high: [{ severity: "high", file: "src/a.ts", line: 1, description: "rejected" }] } as any;

    const posted = await new GitHubReviewer(octokit as any).postReview("o", "r", 7, findings, false, "f".repeat(64), HEAD);

    expect(createReview.mock.calls[0][0].event).toBe("APPROVE");
    expect(createReview.mock.calls[1][0].event).toBe("COMMENT");
    expect(createReview.mock.calls[1][0].comments).toEqual([]);
    expect(createReview.mock.calls[1][0].body).toContain(cacheMarker("f".repeat(64), "COMMENT"));
    expect(posted.verdict).toBe("COMMENTED");
  });

  it("dismisses earlier Robin approvals when a newer review does not approve, and fails if it cannot", async () => {
    const robinBody = "## " + ROBIN_SIGNATURE;
    const bot = { type: "Bot" };
    const reviews = [
      { id: 10, state: "APPROVED", body: robinBody, user: bot },
      { id: 11, state: "APPROVED", body: "human", user: { type: "User" } },
      { id: 20, state: "COMMENTED", body: robinBody, user: bot },
    ];
    const dismissReview = jest.fn().mockResolvedValue({});
    const createReview = jest.fn().mockResolvedValue({ data: { id: 20, html_url: "u" } });
    const octokit = { paginate: jest.fn().mockResolvedValue(reviews), rest: { pulls: { createReview, listReviews: {}, dismissReview } } };

    await new GitHubReviewer(octokit as any).postFailureReview("o", "r", 7, "timeout", HEAD);
    expect(dismissReview).toHaveBeenCalledTimes(1);
    expect(dismissReview).toHaveBeenCalledWith(expect.objectContaining({ review_id: 10 }));

    dismissReview.mockRejectedValue(new Error("403"));
    await expect(new GitHubReviewer(octokit as any).postFailureReview("o", "r", 7, "timeout", HEAD)).rejects.toThrow("403");
  });

  it.each(["reviewed", "fallback", "reused", "skipped", "incomplete"])(
    "binds %s receipts to the reviewed commit when the PR advances before posting",
    async (outcome) => {
      const advancedHead = "c".repeat(40);
      const postedReviews: Array<{commit_id: string; body: string}> = [];
      const createReview = jest.fn().mockImplementation(async (request) => {
        if (outcome === "fallback" && request.comments?.length) {
          throw {status: 422, response: {data: {errors: [{field: "comments.line", code: "invalid"}]}}};
        }
        const review = {id: 30, html_url: "u", commit_id: request.commit_id || advancedHead, body: request.body};
        postedReviews.push(review);
        return {data: review};
      });
      const files = [{filename: "src/example.ts", patch: "@@ -1 +1 @@\n-before\n+after"}];
      const octokit = {
        paginate: jest.fn().mockResolvedValue(files),
        rest: {pulls: {createReview, listFiles: {}, listReviews: {}, dismissReview: jest.fn()}},
      };
      const reviewer = new GitHubReviewer(octokit as any);
      const findings = {
        summary: "Finding", medium: [], low: [], suggestions: [], rawResponse: "",
        high: [{severity: "high", file: "src/example.ts", line: 1, description: "Finding"}],
      } as any;
      if (outcome === "reviewed" || outcome === "fallback") {
        await reviewer.postReview("o", "r", 7, findings, false, undefined, HEAD);
      } else if (outcome === "reused") {
        await reviewer.postCachedReview("o", "r", 7, {
          event: "COMMENT", body: "## " + ROBIN_SIGNATURE, counts: null,
        }, HEAD);
      } else if (outcome === "skipped") {
        await reviewer.postSkippedReview("o", "r", 7, HEAD, "whitespace only");
      } else {
        await reviewer.postFailureReview("o", "r", 7, "timeout", HEAD);
      }
      expect(postedReviews).toHaveLength(1);
      expect(postedReviews[0].commit_id).toBe(HEAD);
      expect(parseOutcomeMarker(postedReviews[0].body)?.head).toBe(HEAD);
      if (outcome === "fallback") expect(createReview).toHaveBeenCalledTimes(2);
    }
  );

  it("identifies stale Robin CHANGES_REQUESTED reviews to dismiss", () => {
    const robinBody = "## :bow_and_arrow: Robin\n\nfindings…";
    const bot = { type: "Bot" };
    expect(
      GitHubReviewer.isStaleRobinReview({ id: 1, state: "CHANGES_REQUESTED", body: robinBody, user: bot }, 2, "APPROVE")
    ).toBe(true);
    // the review just posted
    expect(
      GitHubReviewer.isStaleRobinReview({ id: 2, state: "CHANGES_REQUESTED", body: robinBody, user: bot }, 2, "APPROVE")
    ).toBe(false);
    // non-blocking Robin review
    expect(
      GitHubReviewer.isStaleRobinReview({ id: 1, state: "COMMENTED", body: robinBody, user: bot }, 2, "COMMENT")
    ).toBe(false);
    // human review must never be dismissed — even one quoting Robin's signature
    expect(
      GitHubReviewer.isStaleRobinReview(
        { id: 1, state: "CHANGES_REQUESTED", body: robinBody, user: { type: "User" } },
        2,
        "APPROVE"
      )
    ).toBe(false);
    expect(
      GitHubReviewer.isStaleRobinReview({ id: 1, state: "CHANGES_REQUESTED", body: "LGTM-ish", user: bot }, 2, "APPROVE")
    ).toBe(false);
    expect(
      GitHubReviewer.isStaleRobinReview({ id: 1, state: "CHANGES_REQUESTED", body: null, user: bot }, 2, "APPROVE")
    ).toBe(false);
    expect(
      GitHubReviewer.isStaleRobinReview(
        {
          id: 1,
          state: "CHANGES_REQUESTED",
          body: `${robinBody}\n\n### :page_facing_up: Findings Not Posted Inline\n\n:rotating_light: **1** — unsafe operation`,
          user: bot,
        },
        2,
        "APPROVE"
      )
    ).toBe(false);
    expect(
      GitHubReviewer.isStaleRobinReview({ id: 1, state: "APPROVED", body: robinBody, user: bot }, 2, "APPROVE")
    ).toBe(false);
    expect(
      GitHubReviewer.isStaleRobinReview({ id: 1, state: "APPROVED", body: robinBody, user: bot }, 2, "COMMENT")
    ).toBe(true);
  });

  it("dismisses only stale Robin CHANGES_REQUESTED reviews after posting", async () => {
    const robinBody = "## :bow_and_arrow: Robin\n\nfindings…";
    const bot = { type: "Bot" };
    const reviews = [
      { id: 10, state: "CHANGES_REQUESTED", body: robinBody, user: bot }, // stale — dismiss
      { id: 11, state: "COMMENTED", body: robinBody, user: bot }, // non-blocking — keep
      { id: 12, state: "CHANGES_REQUESTED", body: "human review", user: { type: "User" } }, // human — keep
      { id: 20, state: "CHANGES_REQUESTED", body: robinBody, user: bot }, // the new review itself
    ];
    const dismissReview = jest.fn().mockResolvedValue({});
    const octokit = {
      paginate: jest.fn().mockResolvedValue(reviews),
      rest: { pulls: { listReviews: {}, dismissReview } },
    };

    const reviewer = new GitHubReviewer(octokit as any);
    await (reviewer as any).dismissStaleRobinReviews("o", "r", 1, 20, "APPROVE");

    expect(dismissReview).toHaveBeenCalledTimes(1);
    expect(dismissReview).toHaveBeenCalledWith(
      expect.objectContaining({ review_id: 10, pull_number: 1 })
    );
  });

  it("reports an incomplete review without pretending it blocks the PR", async () => {
    const createReview = jest.fn().mockResolvedValue({ data: { id: 20, html_url: "u" } });
    const octokit = {
      paginate: jest.fn().mockResolvedValue([]),
      rest: { pulls: { createReview, listReviews: {}, dismissReview: jest.fn() } },
    };

    const posted = await new GitHubReviewer(octokit as any).postFailureReview(
      "o", "r", 7, "provider timeout", HEAD
    );

    expect(createReview).toHaveBeenCalledWith(expect.objectContaining({
      pull_number: 7,
      event: "COMMENT",
      body: expect.stringContaining("provider timeout"),
    }));
    expect(createReview.mock.calls[0][0].body).toContain("was not reviewed");
    // The receipt must name the head it failed on; a consumer cannot otherwise
    // tell "incomplete at H" from "incomplete at some earlier head".
    expect(parseOutcomeMarker(createReview.mock.calls[0][0].body)).toEqual({
      outcome: "incomplete",
      head: HEAD,
      counts: { high: 0, medium: 0, low: 0, suggestions: 0 },
    });
    expect(posted).toEqual({ id: 20, url: "u", verdict: "COMMENTED", counts: { high: 0, medium: 0, low: 0, suggestions: 0 } });
  });

  it("stamps a skipped receipt for a head with nothing reviewable", async () => {
    const createReview = jest.fn().mockResolvedValue({ data: { id: 21, html_url: "u" } });
    const octokit = { rest: { pulls: { createReview } } };

    await new GitHubReviewer(octokit as any).postSkippedReview(
      "o", "r", 7, HEAD, "only whitespace changed."
    );

    expect(createReview.mock.calls[0][0].event).toBe("APPROVE");
    expect(createReview.mock.calls[0][0].body).toContain("only whitespace changed.");
    expect(parseOutcomeMarker(createReview.mock.calls[0][0].body)).toEqual({
      outcome: "skipped",
      head: HEAD,
      counts: { high: 0, medium: 0, low: 0, suggestions: 0 },
    });
  });

  it("stamps the reviewed head and counts on the posted review", async () => {
    const createReview = jest.fn().mockResolvedValue({ data: { id: 22, html_url: "u" } });
    const octokit = {
      paginate: jest.fn().mockResolvedValue([]),
      rest: { pulls: { createReview, listFiles: {}, listReviews: {}, dismissReview: jest.fn() } },
    };
    const findings = {
      summary: "Summary",
      high: [{ severity: "high", description: "one" }],
      medium: [],
      low: [{ severity: "low", description: "two" }],
      suggestions: [],
      rawResponse: "",
    } as any;

    const posted = await new GitHubReviewer(octokit as any).postReview(
      "o", "r", 7, findings, false, "f".repeat(64), HEAD
    );

    const body = createReview.mock.calls[0][0].body;
    expect(body).toContain(cacheMarker("f".repeat(64), "COMMENT"));
    expect(parseOutcomeMarker(body)).toEqual({
      outcome: "reviewed",
      head: HEAD,
      counts: { high: 1, medium: 0, low: 1, suggestions: 0 },
    });
    expect(posted).toEqual({
      id: 22,
      url: "u",
      verdict: "COMMENTED",
      counts: { high: 1, medium: 0, low: 1, suggestions: 0 },
    });
  });

  it("re-stamps a reused verdict at the new head, copying counts from the cached marker", async () => {
    const createReview = jest.fn().mockResolvedValue({ data: { id: 23, html_url: "u" } });
    const octokit = {
      paginate: jest.fn().mockResolvedValue([]),
      rest: { pulls: { createReview, listReviews: {}, dismissReview: jest.fn() } },
    };
    const cachedBody = [
      "## " + ROBIN_SIGNATURE,
      "",
      ":rotating_light: **2 High**",
      "",
      `<!-- robin-outcome: v1 reviewed head=${OLD_HEAD} high=2 medium=1 low=0 suggestions=3 -->`,
    ].join("\n");

    const posted = await new GitHubReviewer(octokit as any).postCachedReview(
      "o", "r", 7, { event: "REQUEST_CHANGES", body: cachedBody, counts: { high: 2, medium: 1, low: 0, suggestions: 3 } }, HEAD
    );

    const body = createReview.mock.calls[0][0].body;
    expect(body).toContain(cachedBody);
    expect(parseOutcomeMarker(body)).toEqual({
      outcome: "reused",
      head: HEAD,
      counts: { high: 2, medium: 1, low: 0, suggestions: 3 },
    });
    expect(posted.verdict).toBe("CHANGES_REQUESTED");
  });

  it("omits counts when reusing a body that predates outcome markers", async () => {
    const createReview = jest.fn().mockResolvedValue({ data: { id: 24, html_url: "u" } });
    const octokit = {
      paginate: jest.fn().mockResolvedValue([]),
      rest: { pulls: { createReview, listReviews: {}, dismissReview: jest.fn() } },
    };

    await new GitHubReviewer(octokit as any).postCachedReview(
      "o", "r", 7, { event: "APPROVE", body: "## " + ROBIN_SIGNATURE + "\n\n:white_check_mark: **No issues found**", counts: null }, HEAD
    );

    // Counts must never be invented from the verdict: an absent tail tells the
    // consumer to fall back to the stat blocks in the body.
    expect(parseOutcomeMarker(createReview.mock.calls[0][0].body)).toEqual({
      outcome: "reused",
      head: HEAD,
      counts: null,
    });
  });

  it("detects new-file line numbers present in the diff", () => {
    const reviewer = new GitHubReviewer({} as any);
    const isLineInNewDiff = (reviewer as any).isLineInNewDiff.bind(reviewer) as (
      patch: string,
      targetLine: number
    ) => boolean;

    const patch = [
      "@@ -1,3 +1,4 @@",
      " import value from './value';",
      "-const oldName = value;",
      "+const newName = value;",
      "+const enabled = true;",
      " export { newName };",
    ].join("\n");

    expect(isLineInNewDiff(patch, 2)).toBe(true);
    expect(isLineInNewDiff(patch, 3)).toBe(true);
    expect(isLineInNewDiff(patch, 4)).toBe(true);
    expect(isLineInNewDiff(patch, 99)).toBe(false);
  });

  it("uses line and side for inline review comments", () => {
    const reviewer = new GitHubReviewer({} as any);
    const buildReviewComments = (reviewer as any).buildReviewComments.bind(reviewer);

    const findings = {
      summary: "Summary",
      high: [
        {
          severity: "high",
          file: "src/example.ts",
          line: 3,
          description: "Finding",
        },
      ],
      medium: [],
      low: [],
      suggestions: [],
    };

    const files = [
      {
        filename: "src/example.ts",
        patch: [
          "@@ -1,2 +1,3 @@",
          " const first = true;",
          "+const second = true;",
          "+const third = true;",
        ].join("\n"),
      },
    ];

    const { comments } = buildReviewComments(findings, files);

    expect(comments).toEqual([
      expect.objectContaining({
        path: "src/example.ts",
        line: 3,
        side: "RIGHT",
      }),
    ]);
    expect(comments[0]).not.toHaveProperty("position");
  });

  it("retries inline comment coordinate errors using response details", () => {
    const reviewer = new GitHubReviewer({} as any);
    const shouldRetryWithoutInlineComments = (
      reviewer as any
    ).shouldRetryWithoutInlineComments.bind(reviewer) as (error: unknown) => boolean;

    expect(shouldRetryWithoutInlineComments({
      status: 422,
      response: {
        data: {
          errors: [{ field: "comments.line", code: "invalid" }],
        },
      },
    })).toBe(true);

    expect(shouldRetryWithoutInlineComments({ status: 403, message: "Forbidden" })).toBe(false);
  });
});


describe("content-addressed review reuse", () => {
  const base = {
    model: "gpt-5.6-luna",
    systemPrompt: "system",
    precisionPrompt: "precision",
    gatekeeper: true,
    diff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
  };

  it("is stable for identical inputs and sensitive to every field", () => {
    expect(reviewKey(base)).toBe(reviewKey({ ...base }));
    expect(reviewKey({ ...base, diff: base.diff.replace("+b", "+b ") })).not.toBe(reviewKey(base));
    expect(reviewKey({ ...base, model: "other" })).not.toBe(reviewKey(base));
    expect(reviewKey({ ...base, systemPrompt: "changed" })).not.toBe(reviewKey(base));
    expect(reviewKey({ ...base, precisionPrompt: "changed" })).not.toBe(reviewKey(base));
    expect(reviewKey({ ...base, gatekeeper: false })).not.toBe(reviewKey(base));
  });

  it("ignores line numbers and index lines but not whitespace", () => {
    const moved = { ...base, diff: "diff --git a/x b/x\nindex 1111111..2222222 100644\n--- a/x\n+++ b/x\n@@ -40 +40 @@ fn\n-a\n+b\n" };
    expect(reviewKey(moved)).toBe(reviewKey(base));
    expect(reviewKey({ ...base, diff: base.diff.replace("+b", "+ b") })).not.toBe(reviewKey(base));
  });

  it("refuses a diff git cannot identify", () => {
    expect(() => reviewKey({ ...base, diff: "@@ -1 +1 @@\n-a\n+b\n" })).toThrow("git patch-id produced no id");
  });

  it("cannot be spoofed by field concatenation", () => {
    // Fields are NUL-joined, so moving a boundary must change the digest.
    expect(reviewKey({ ...base, model: "a", systemPrompt: "b" }))
      .not.toBe(reviewKey({ ...base, model: "ab", systemPrompt: "" }));
  });

  const key = reviewKey(base);
  const robin = (event: "APPROVE" | "REQUEST_CHANGES", k = key) =>
    "## " + ROBIN_SIGNATURE + "\n\nfindings…\n\n" + cacheMarker(k, event);
  const bot = { login: "github-actions[bot]", type: "Bot" };

  it("reuses a matching verdict regardless of dismissal state", () => {
    // dismiss_stale_reviews marks exactly the reviews we want as DISMISSED,
    // so state must not be part of the match.
    expect(reuseDecision([{ body: robin("APPROVE"), user: bot }], base).carried)
      .toEqual({ event: "APPROVE", body: robin("APPROVE"), counts: null });
    expect(reuseDecision([{ body: robin("REQUEST_CHANGES"), user: bot }], base).carried?.event)
      .toBe("REQUEST_CHANGES");
  });

  it("returns the most recent matching review", () => {
    const reviews = [
      { body: robin("REQUEST_CHANGES"), user: bot },
      { body: robin("APPROVE"), user: bot },
    ];
    expect(reuseDecision(reviews, base).carried?.event).toBe("APPROVE");
  });

  it("misses on a different change", () => {
    expect(reuseDecision([{ body: robin("APPROVE"), user: bot }], { ...base, diff: base.diff.replace("+b", "+c") }).carried).toBeNull();
  });

  it("carries the verdict, body and counts to the new head and keys the review it posts", () => {
    const body = robin("REQUEST_CHANGES") + "\n<!-- robin-outcome: v1 reviewed head=" + OLD_HEAD + " high=1 medium=2 low=0 suggestions=0 -->";
    expect(reuseDecision([{ body, user: bot }], base)).toEqual({
      key,
      carried: { event: "REQUEST_CHANGES", body, counts: { high: 1, medium: 2, low: 0, suggestions: 0 } },
    });
  });

  it("rejects forged markers", () => {
    const body = robin("APPROVE");
    // A human pasting the marker into their own review must not yield a bot APPROVE.
    expect(reuseDecision([{ body, user: { login: "daydemir", type: "User" } }], base).carried).toBeNull();
    // A different bot must not qualify either.
    expect(reuseDecision([{ body, user: { login: "coderabbitai[bot]", type: "Bot" } }], base).carried).toBeNull();
    // Bot author, right marker, but not a Robin review body.
    expect(
      reuseDecision([{ body: "no signature here\n" + cacheMarker(key, "APPROVE"), user: bot }], base).carried
    ).toBeNull();
  });

  it("ignores reviews with no marker at all", () => {
    expect(reuseDecision([{ body: "## " + ROBIN_SIGNATURE + "\n\nold review", user: bot }], base).carried).toBeNull();
    expect(reuseDecision([{ body: null, user: bot }], base).carried).toBeNull();
  });
});
