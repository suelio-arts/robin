import { isPullRequestReviewEvent } from "./events";

describe("isPullRequestReviewEvent", () => {
  it("supports trusted-base and ordinary pull-request reviews", () => {
    expect(isPullRequestReviewEvent("pull_request")).toBe(true);
    expect(isPullRequestReviewEvent("pull_request_target")).toBe(true);
    expect(isPullRequestReviewEvent("push")).toBe(false);
  });
});
