import { GitHubReviewer, reviewKey, cacheMarker, findCachedVerdict, ROBIN_SIGNATURE } from "./github-reviewer";

describe("GitHubReviewer", () => {
  it("resolves review event from high findings and request-changes mode", () => {
    expect(GitHubReviewer.resolveReviewEvent(true, true)).toBe("REQUEST_CHANGES");
    expect(GitHubReviewer.resolveReviewEvent(true, false)).toBe("COMMENT");
    expect(GitHubReviewer.resolveReviewEvent(false, true)).toBe("APPROVE");
    expect(GitHubReviewer.resolveReviewEvent(false, false)).toBe("COMMENT");
  });

  it("identifies stale Robin CHANGES_REQUESTED reviews to dismiss", () => {
    const robinBody = "## :bow_and_arrow: Robin\n\nfindings…";
    const bot = { type: "Bot" };
    expect(
      GitHubReviewer.isStaleRobinReview({ id: 1, state: "CHANGES_REQUESTED", body: robinBody, user: bot }, 2)
    ).toBe(true);
    // the review just posted
    expect(
      GitHubReviewer.isStaleRobinReview({ id: 2, state: "CHANGES_REQUESTED", body: robinBody, user: bot }, 2)
    ).toBe(false);
    // non-blocking Robin review
    expect(
      GitHubReviewer.isStaleRobinReview({ id: 1, state: "COMMENTED", body: robinBody, user: bot }, 2)
    ).toBe(false);
    // human review must never be dismissed — even one quoting Robin's signature
    expect(
      GitHubReviewer.isStaleRobinReview(
        { id: 1, state: "CHANGES_REQUESTED", body: robinBody, user: { type: "User" } },
        2
      )
    ).toBe(false);
    expect(
      GitHubReviewer.isStaleRobinReview({ id: 1, state: "CHANGES_REQUESTED", body: "LGTM-ish", user: bot }, 2)
    ).toBe(false);
    expect(
      GitHubReviewer.isStaleRobinReview({ id: 1, state: "CHANGES_REQUESTED", body: null, user: bot }, 2)
    ).toBe(false);
    expect(
      GitHubReviewer.isStaleRobinReview(
        {
          id: 1,
          state: "CHANGES_REQUESTED",
          body: `${robinBody}\n\n### :page_facing_up: Findings Not Posted Inline\n\n:rotating_light: **1** — unsafe operation`,
          user: bot,
        },
        2
      )
    ).toBe(false);
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
    await (reviewer as any).dismissStaleRobinReviews("o", "r", 1, 20);

    expect(dismissReview).toHaveBeenCalledTimes(1);
    expect(dismissReview).toHaveBeenCalledWith(
      expect.objectContaining({ review_id: 10, pull_number: 1 })
    );
  });

  it("blocks a PR when review execution fails", async () => {
    const createReview = jest.fn().mockResolvedValue({ data: { id: 20 } });
    const octokit = {
      paginate: jest.fn().mockResolvedValue([]),
      rest: { pulls: { createReview, listReviews: {}, dismissReview: jest.fn() } },
    };

    await new GitHubReviewer(octokit as any).postFailureReview("o", "r", 7, "provider timeout");

    expect(createReview).toHaveBeenCalledWith(expect.objectContaining({
      pull_number: 7,
      event: "REQUEST_CHANGES",
      body: expect.stringContaining("provider timeout"),
    }));
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
      high: [],
      medium: [
        {
          severity: "medium",
          file: "src/example.ts",
          line: 3,
          description: "Finding",
        },
      ],
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
    diff: "@@ -1 +1 @@\n-a\n+b\n",
  };

  it("is stable for identical inputs and sensitive to every field", () => {
    expect(reviewKey(base)).toBe(reviewKey({ ...base }));
    expect(reviewKey({ ...base, diff: base.diff + " " })).not.toBe(reviewKey(base));
    expect(reviewKey({ ...base, model: "other" })).not.toBe(reviewKey(base));
    expect(reviewKey({ ...base, systemPrompt: "changed" })).not.toBe(reviewKey(base));
    expect(reviewKey({ ...base, precisionPrompt: "changed" })).not.toBe(reviewKey(base));
    expect(reviewKey({ ...base, gatekeeper: false })).not.toBe(reviewKey(base));
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
    expect(findCachedVerdict([{ body: robin("APPROVE"), user: bot }], key))
      .toEqual({ event: "APPROVE", body: robin("APPROVE") });
    expect(findCachedVerdict([{ body: robin("REQUEST_CHANGES"), user: bot }], key)?.event)
      .toBe("REQUEST_CHANGES");
  });

  it("returns the most recent matching review", () => {
    const reviews = [
      { body: robin("REQUEST_CHANGES"), user: bot },
      { body: robin("APPROVE"), user: bot },
    ];
    expect(findCachedVerdict(reviews, key)?.event).toBe("APPROVE");
  });

  it("misses on a different key", () => {
    const other = reviewKey({ ...base, diff: "different" });
    expect(findCachedVerdict([{ body: robin("APPROVE"), user: bot }], other)).toBeNull();
  });

  it("rejects forged markers", () => {
    const body = robin("APPROVE");
    // A human pasting the marker into their own review must not yield a bot APPROVE.
    expect(findCachedVerdict([{ body, user: { login: "daydemir", type: "User" } }], key)).toBeNull();
    // A different bot must not qualify either.
    expect(findCachedVerdict([{ body, user: { login: "coderabbitai[bot]", type: "Bot" } }], key)).toBeNull();
    // Bot author, right marker, but not a Robin review body.
    expect(
      findCachedVerdict([{ body: "no signature here\n" + cacheMarker(key, "APPROVE"), user: bot }], key)
    ).toBeNull();
  });

  it("ignores reviews with no marker at all", () => {
    expect(findCachedVerdict([{ body: "## " + ROBIN_SIGNATURE + "\n\nold review", user: bot }], key)).toBeNull();
    expect(findCachedVerdict([{ body: null, user: bot }], key)).toBeNull();
  });
});
