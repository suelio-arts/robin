import { isPullRequestReviewEvent, workflowDispatchPrNumber } from "./events";

describe("isPullRequestReviewEvent", () => {
  it("supports trusted-base and ordinary pull-request reviews", () => {
    expect(isPullRequestReviewEvent("pull_request")).toBe(true);
    expect(isPullRequestReviewEvent("pull_request_target")).toBe(true);
    expect(isPullRequestReviewEvent("push")).toBe(false);
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
