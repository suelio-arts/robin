# MIX Recent-PR Evaluation

`mix-recent-prs.json` freezes validated CodeRabbit and Greptile root causes from
recent MIX pull requests plus rejected, stale, and withdrawn comments as negative
controls. Candidate comments are labels only after their failure path is verified
at the reviewed SHA. Multi-commit snapshots use the PR merge base, not the reviewed
commit's parent.

This is a development corpus, not an untouched holdout: prompts and tools were
tuned against some of these cases. Do not claim parity from it. Freeze the pipeline,
then adjudicate and score unseen PRs as a separate holdout before promotion.

Run Luna at explicit high reasoning effort:

```bash
OPENAI_API_KEY=... npm run eval:mix -- /tmp/mix-review-results.json
```

Score a finding only when it matches the PR, file, and root cause. Generic advice
does not count. Bot agreement is not validation: incorrect bot findings belong in
the negative controls. Run each candidate prompt at least three times before
promotion; keep one locked holdout set out of prompt iteration.
