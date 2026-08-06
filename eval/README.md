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

`blindHoldoutSnapshots` and `blindNegativeSnapshots` are the authoritative frozen
unseen allowlists. Other records in `holdoutCases` and `holdoutNegativeControls`
are exposed development corpus, regardless of their historical name or generation.
The current portable blind set has only the two independently run PR 318/320 labels
and no blind negative controls, so it is intentionally insufficient for promotion.
Freeze a candidate pipeline before adding fresh snapshots; promotion requires at
least ten blind roots, ten blind negative candidates, and three blind update heads.
Update heads must be frozen as explicit `blindUpdatePairs`; the evaluator proves each
predecessor is a Git ancestor of its paired update before making any model call.
Each ten-case minimum must include at least five CodeRabbit and five Greptile
examples; both source-specific recall and rejection rates must independently hit 90%.
Negative
controls are specific stale candidate comments, not claims that their entire PRs
are defect-free. Do not count a different validated defect as a false positive.
Do not use holdout results to tune the prompt or pipeline; replace the set before
another iteration.

The frozen synthetic generation-5 holdout caught all six seeded regressions
(6/6) after generation 4 was promoted to development. Synthetic commits remain
machine-local and are not part of this portable historical manifest.

Use subscription transport for prompt development without API spend. Promotion
requires API transport so cost is recomputed from native per-call usage at the
pinned [official Luna rate](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
($1 input, $0.10 cached input, $6 output per million tokens):

```bash
npm run eval:mix -- /tmp/mix-review-results.json
EVAL_AGENT=luna-5-6-low-subscription npm run eval:mix -- /tmp/mix-review-results-low.json
EVAL_SET=holdout EVAL_AGENT=luna-5-6-high-api npm run eval:mix -- /tmp/mix-holdout-results.json
```

Every result records the exact model/effort/transport, Robin commit, prompt SHA-256,
manifest SHA-256, native session IDs, per-PR wall time, call count, token usage,
dollar cost, and the equivalent CodeRabbit
overage price at $0.25 per reviewed file. Filtered runs and unpriced subscription
runs are development evidence only and cannot pass promotion.

Adjudicate every emitted finding into the grade schema in `src/eval-score.ts`.
The scorer hashes the raw artifact and rejects omitted, invented, or duplicate findings:

```bash
npm run eval:score -- --inventory /path/to/run-1.json
npm run eval:score -- eval/mix-recent-prs.json \
  /path/to/run-1.json /path/to/grade-1.json \
  /path/to/run-2.json /path/to/grade-2.json \
  /path/to/run-3.json /path/to/grade-3.json
```

Label IDs are deterministic: `<pr>:<head>:label:<one-based index>`. Negative-control
IDs use `<pr>:<head>:negative:<one-based index>`. Additional real findings require
exact-head evidence. Promotion requires three distinct runs of the same prompt and
pipeline configuration and distinct raw artifact hashes, each with at least 90% blind-union recall, 70% precision,
zero blocking false positives, at least 90% negative-control rejection, no more than
one suggestion per reviewed snapshot, at most 0.25 update-noise findings per update,
under five minutes per PR snapshot, and under half the equivalent CodeRabbit overage cost.

For a focused rerun, select exact snapshots/files with `EVAL_HEADS` and
`EVAL_FILES`; `EVAL_CHUNKS=2,3` selects one-based chunks after file filtering.
File filters also constrain negative controls. Chunk filters skip negative controls because those cases are file-level, not chunked.

Score a finding only when it matches the PR, file, and root cause. Generic advice
does not count. Bot agreement is not validation: incorrect bot findings belong in
the negative controls. Run each candidate prompt at least three times before
promotion; keep one locked holdout set out of prompt iteration.
