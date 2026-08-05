export function isPullRequestReviewEvent(eventName: string): boolean {
  return eventName === "pull_request" || eventName === "pull_request_target";
}

export function workflowDispatchPrNumber(eventName: string, input: string): number | undefined {
  if (eventName !== "workflow_dispatch") return undefined;
  if (!/^[1-9][0-9]*$/.test(input)) {
    throw new Error("workflow_dispatch requires a positive integer pr-number input");
  }
  return Number(input);
}

export function validateExpectedHeadSha(input: string, currentHeadSha: string): void {
  if (!input) return;
  if (!/^[0-9a-f]{40}$/.test(input)) {
    throw new Error("expected-head-sha must be a full 40-character lowercase hexadecimal SHA");
  }
  if (input !== currentHeadSha) {
    throw new Error(`Pull request head advanced: expected ${input}, current ${currentHeadSha}`);
  }
}
