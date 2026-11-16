import { GitHubReviewer } from "./github-reviewer";
import { parseOutcomeMarker } from "./outcome";

const HEAD = "a".repeat(40);

describe("GitHubReviewer", () => {
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

    await new GitHubReviewer(octokit as any).postReview("o", "r", 7, findings, HEAD);

    const request = createReview.mock.calls[0][0];
    expect(request.event).toBe("COMMENT");
    expect(request.comments).toHaveLength(1);
    expect(request.comments[0].body).toContain("high one");
    expect(request.body).toContain("medium one");
    expect(request.body).toContain("low one");
  });

  it.each([
    ["has no location", { severity: "high", description: "unplaced" }, 25],
    ["exceeds max-comments", { severity: "high", file: "src/a.ts", line: 1, description: "over the cap" }, 0],
  ])("keeps a High in the body when it %s", async (_case, high, maxComments) => {
    const createReview = jest.fn().mockResolvedValue({ data: { id: 26, html_url: "u" } });
    const octokit = {
      paginate: jest.fn().mockImplementation(async (method) => method === "files" ? [{ filename: "src/a.ts", patch: "@@ -1 +1 @@\n-x\n+y" }] : []),
      rest: { pulls: { createReview, listFiles: "files", listReviews: "reviews", dismissReview: jest.fn() } },
    };
    const findings = { summary: "s", medium: [], low: [], suggestions: [], rawResponse: "", high: [high] } as any;

    await new GitHubReviewer(octokit as any, maxComments).postReview("o", "r", 7, findings, HEAD);

    expect(createReview.mock.calls[0][0].comments).toEqual([]);
    expect(createReview.mock.calls[0][0].body).toContain(high.description);
  });

  it("moves the High into the body when GitHub rejects its inline comment", async () => {
    const createReview = jest.fn()
      .mockRejectedValueOnce({ status: 422, response: { data: { errors: [{ field: "comments.line", code: "invalid" }] } } })
      .mockResolvedValueOnce({ data: { id: 27, html_url: "u" } });
    const octokit = {
      paginate: jest.fn().mockImplementation(async (method) => method === "files" ? [{ filename: "src/a.ts", patch: "@@ -1 +1 @@\n-x\n+y" }] : []),
      rest: { pulls: { createReview, listFiles: "files", listReviews: "reviews", dismissReview: jest.fn() } },
    };
    const findings = { summary: "s", medium: [], low: [], suggestions: [], rawResponse: "",
      high: [{ severity: "high", file: "src/a.ts", line: 1, description: "rejected" }] } as any;

    await new GitHubReviewer(octokit as any).postReview("o", "r", 7, findings, HEAD);

    expect(createReview.mock.calls[0][0].comments).toHaveLength(1);
    expect(createReview.mock.calls[1][0].comments).toEqual([]);
    expect(createReview.mock.calls[1][0].body).toContain("rejected");
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
    expect(posted).toEqual({ id: 20, url: "u", counts: { high: 0, medium: 0, low: 0, suggestions: 0 } });
  });

  it("stamps a skipped receipt for a head with nothing reviewable", async () => {
    const createReview = jest.fn().mockResolvedValue({ data: { id: 21, html_url: "u" } });
    const octokit = { rest: { pulls: { createReview } } };

    await new GitHubReviewer(octokit as any).postSkippedReview(
      "o", "r", 7, HEAD, "only whitespace changed."
    );

    expect(createReview.mock.calls[0][0].event).toBe("COMMENT");
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
      "o", "r", 7, findings, HEAD
    );

    const body = createReview.mock.calls[0][0].body;
    expect(parseOutcomeMarker(body)).toEqual({
      outcome: "reviewed",
      head: HEAD,
      counts: { high: 1, medium: 0, low: 1, suggestions: 0 },
    });
    expect(posted).toEqual({
      id: 22,
      url: "u",
      counts: { high: 1, medium: 0, low: 1, suggestions: 0 },
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
