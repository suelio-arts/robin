import { formatPriorFindings } from "./main";

describe("formatPriorFindings", () => {
  const comment = (id: number, reviewId: number, body: string) => ({
    id,
    path: "a.ts",
    line: id,
    body,
    pull_request_review_id: reviewId,
  });

  it("drops findings whose thread a human resolved", () => {
    // The ratchet: a finding the author explicitly rejected with evidence and
    // resolved was replayed into the final gate every round and re-kept, so no
    // amount of fixing could ever clear the verdict.
    const comments = [comment(1, 10, "real finding"), comment(2, 10, "rejected with evidence")];
    const out = formatPriorFindings(comments, new Set([10]), new Set([2]));
    expect(out).toContain("real finding");
    expect(out).not.toContain("rejected with evidence");
  });

  it("keeps unresolved findings so genuine regressions still carry forward", () => {
    const comments = [comment(1, 10, "still broken")];
    expect(formatPriorFindings(comments, new Set([10]), new Set())).toContain("still broken");
  });

  it("ignores comments from reviews that are not Robin's", () => {
    const comments = [comment(1, 10, "robin"), comment(2, 99, "someone else")];
    const out = formatPriorFindings(comments, new Set([10]), new Set());
    expect(out).toContain("robin");
    expect(out).not.toContain("someone else");
  });

  it("returns empty when every finding is resolved", () => {
    const comments = [comment(1, 10, "a"), comment(2, 10, "b")];
    expect(formatPriorFindings(comments, new Set([10]), new Set([1, 2]))).toBe("");
  });
});
