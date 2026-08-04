# MIX Recent-PR Evaluation

`mix-recent-prs.json` freezes validated CodeRabbit, Greptile, and Luna root causes
from recent MIX pull requests plus rejected, stale, and withdrawn candidate comments.
Luna-sourced labels are scored only after independent exact-SHA adjudication;
model agreement alone never makes a candidate ground truth.
Candidate comments are labels only after their failure path is verified at the
reviewed SHA. Multi-commit snapshots use the PR merge base, not the reviewed
commit's parent. `unscoredHistoricalNotes` preserves old whole-PR notes but is
never evaluated because those records do not identify an exact candidate.

This is a development corpus, not an untouched holdout: prompts and tools were
tuned against some of these cases. Do not claim parity from it. Freeze the pipeline,
then adjudicate and score unseen PRs as a separate holdout before promotion.

`holdoutCases` and `holdoutNegativeControls` are the frozen unseen set. Negative
controls are specific stale candidate comments, not claims that their entire PRs
are defect-free. Do not count a different validated defect as a false positive.
Do not use holdout results to tune the prompt or pipeline; replace the set before
another iteration.

Run Luna at explicit high reasoning effort:

```bash
OPENAI_API_KEY=... npm run eval:mix -- /tmp/mix-review-results.json
EVAL_SET=holdout OPENAI_API_KEY=... npm run eval:mix -- /tmp/mix-holdout-results.json
```

Score a finding only when it matches the PR, file, and root cause. Generic advice
does not count. Bot agreement is not validation: incorrect bot findings belong in
the negative controls. Run each candidate prompt at least three times before
promotion; keep one locked holdout set out of prompt iteration.
