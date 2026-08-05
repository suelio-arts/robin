import { isPullRequestReviewEvent, validateExpectedHeadSha, workflowDispatchPrNumber } from "./events";

describe("isPullRequestReviewEvent", () => {
  it("supports trusted-base and ordinary pull-request reviews", () => {
    expect(isPullRequestReviewEvent("pull_request")).toBe(true);
    expect(isPullRequestReviewEvent("pull_request_target")).toBe(true);
    expect(isPullRequestReviewEvent("push")).toBe(false);
  });
});

describe("validateExpectedHeadSha", () => {
  const expected = "a".repeat(40);

  it("rejects malformed SHAs", () => {
    expect(() => validateExpectedHeadSha("ABC123", expected)).toThrow("full 40-character");
  });

  it("rejects an advanced pull request head", () => {
    expect(() => validateExpectedHeadSha(expected, "b".repeat(40))).toThrow(
      "Pull request head advanced",
    );
  });

  it("accepts an omitted or matching head", () => {
    expect(() => validateExpectedHeadSha("", expected)).not.toThrow();
    expect(() => validateExpectedHeadSha(expected, expected)).not.toThrow();
  });
});

describe("workflowDispatchPrNumber", () => {
  it("accepts only an exact positive PR number for workflow dispatch", () => {
    expect(workflowDispatchPrNumber("workflow_dispatch", "341")).toBe(341);
    expect(() => workflowDispatchPrNumber("workflow_dispatch", "0")).toThrow("positive integer");
    expect(() => workflowDispatchPrNumber("workflow_dispatch", "341x")).toThrow("positive integer");
    expect(workflowDispatchPrNumber("pull_request_target", "341")).toBeUndefined();
  });
});
