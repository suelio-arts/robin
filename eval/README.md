# MIX Recent-PR Evaluation

`mix-recent-prs.json` freezes validated CodeRabbit, Greptile, and Luna root causes
from recent MIX pull requests plus rejected, stale, and withdrawn candidate comments.
Luna-sourced labels are scored only after independent exact-SHA adjudication;
model agreement alone never makes a candidate ground truth.
Candidate comments are labels only after their failure path is verified at the
reviewed SHA. Multi-commit snapshots use the PR merge base, not the reviewed
commit's parent. `unscoredHistoricalNotes` preserves old whole-PR notes; only
generation-2 records are exact exposed development cases and are evaluated.

This is a development corpus, not an untouched holdout: prompts and tools were
tuned against some of these cases. Do not claim parity from it. Freeze the pipeline,
then adjudicate and score unseen PRs as a separate holdout before promotion.

`holdoutCases` and `holdoutNegativeControls` are the frozen unseen set. Cases
tagged generation 3 are exposed development cases and the evaluator excludes
them from holdout runs. Negative
controls are specific stale candidate comments, not claims that their entire PRs
are defect-free. Do not count a different validated defect as a false positive.
Do not use holdout results to tune the prompt or pipeline; replace the set before
another iteration.

The frozen synthetic generation-5 holdout caught all six seeded regressions
(6/6) after generation 4 was promoted to development. Synthetic commits remain
machine-local and are not part of this portable historical manifest.

Run Luna high through the local subscription transport; API keys are neither required nor supported:

```bash
npm run eval:mix -- /tmp/mix-review-results.json
EVAL_SET=holdout npm run eval:mix -- /tmp/mix-holdout-results.json
```

For a focused rerun, select exact snapshots/files with `EVAL_HEADS` and
`EVAL_FILES`; `EVAL_CHUNKS=2,3` selects one-based chunks after file filtering.
File filters also constrain negative controls. Chunk filters skip negative controls because those cases are file-level, not chunked.

Score a finding only when it matches the PR, file, and root cause. Generic advice
does not count. Bot agreement is not validation: incorrect bot findings belong in
the negative controls. Run each candidate prompt at least three times before
promotion; keep one locked holdout set out of prompt iteration.
