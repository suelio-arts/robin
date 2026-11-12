/** Safe, actionable failure category from `darma t3 run`. */
export class SubscriptionLimitError extends Error {
  constructor(provider: string, kind: "quota" | "rate-limit") {
    super(`${provider} subscription ${kind === "quota" ? "quota exhausted" : "rate limit reached"}. ` +
      "Review incomplete; re-request with /robin after the allowance is restored. No API fallback was attempted.");
    this.name = "SubscriptionLimitError";
  }
}

export function subscriptionLimitFromStderr(stderr: string): SubscriptionLimitError | undefined {
  const match = /^ROBIN_SUBSCRIPTION_LIMIT:(claude|codex|antigravity):(quota|rate-limit)$/m.exec(stderr);
  return match ? new SubscriptionLimitError(match[1], match[2] as "quota" | "rate-limit") : undefined;
}
