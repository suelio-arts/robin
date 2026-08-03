# MIX Recent-PR Evaluation

`mix-recent-prs.json` freezes validated CodeRabbit root causes from recent MIX
pull requests plus negative controls. Candidate comments are labels only after
their failure path is verified against the historical code.

Run Luna at explicit high reasoning effort:

```bash
OPENAI_API_KEY=... npm run eval:mix -- /tmp/mix-review-results.json
```

Score a finding only when it matches the PR, file, and root cause. Generic
advice does not count. Run each candidate prompt at least three times before
promotion; keep one locked holdout set out of prompt iteration.
