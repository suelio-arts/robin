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
