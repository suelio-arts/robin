# Robin fixture benchmark decision — 2026-10-05

Keep MIX's current production reviewer: `suelio-arts/robin@f6ab9388c57d9c907c1fd87e413f31c8c53c2f0a`, `gpt-6-luna`, medium reasoning effort. No configuration switch is justified by these older fixtures. Deniz authorized consolidating and closing the 36 draft fixture PRs; fixture code must never be merged.

## What was benchmarked

The PRs in [`fixture-inventory-2026-10-05.json`](fixture-inventory-2026-10-05.json) are input cases, not 36 Robin releases. They isolate persistence/crash safety, listener cleanup, path confinement, async response ordering, tenant cache isolation, CLI parsing, delivery logs, lease execution, generated contracts, and cross-file state/transport changes. They include successive generations and revised controls.

The portable [`eval/sandbox-prs.json`](../../eval/sandbox-prs.json) scores only PRs 2–6: five initial bug heads, five corrected heads, five stale-candidate negative checks, and five before/after pairs. Its denominators must not be expanded to 36. [`eval/mix-recent-prs.json`](../../eval/mix-recent-prs.json) is exposed development data; [`eval/mix-coderabbit-holdout.json`](../../eval/mix-coderabbit-holdout.json) is a separate promotion corpus. Labels require exact-head root-cause evidence; provider agreement alone is not truth.

## PR comments, checks, and provider variants

All 36 current heads have zero GitHub check runs and zero associated Actions runs. Their single green legacy status is **CodeRabbit**, not Robin: 26 say review completed; PRs 32–41 say draft review skipped. No Robin reviews or sandbox Actions artifacts were found on these PRs. Comments include CodeRabbit findings, walkthroughs, manual requests, and draft skips. A green status alone is not validated review quality.

| Fixtures | Observed configuration and coverage | Limits |
| --- | --- | --- |
| #1 | CodeRabbit CHILL/defaults; atomic persistence finding | Single COMMENTED review |
| #2–6 | CodeRabbit ASSERTIVE, `.coderabbit.yaml`; five positive/fixed snapshot pairs also scored by local Robin | Initial CR caught 4/5 intended roots; search overwrite approved; tenant-cache finding outside diff followed by same-head approval; some current fix heads lack review objects |
| #7–11 and #13–17 | CHILL/defaults versus ASSERTIVE; each pair has the **same head SHA** | Scope query, pause epoch, boolean parsing, log writes, lease release; epoch regression approved by both; query finding concerned test contract; severity/approval policy differ, so request-changes count is not recall |
| #22–31 | ASSERTIVE/Pro with repo config | Lease cleanup, UTF-8 frame length, containment, pagination, response contract, required gates, authorization audit, search provenance, publish confirmation, history preservation; #26 approved with no inline finding; remaining reports require independent root adjudication |
| #32–41 | CodeRabbit draft skip, no reviews or inline comments | Key rotation, heartbeat shutdown, immutable ledger data, confirmation parsing, frame bounds, config crash safety, concurrent reservation, archive confinement, paused access, token expiry; expected failures inferred from code/assertions, not scored reviewer outputs |

CodeRabbit bodies expose profiles, config names, and provider run IDs, but no model/prompt identity, native token usage, bill, or consistent runtime. CHILL versus ASSERTIVE therefore has observational paired evidence, not a defensible cost/speed winner. The full fixture ID/base/head inventory is preserved beside this document. No unadjudicated CodeRabbit comment is counted as a true positive merely because the provider emitted it.

## Ranking the comparable recorded variants

Source: [`eval/development-runs.json`](../../eval/development-runs.json), with exact artifact hashes and pipeline/prompt identities. Costs below are the ledger's historical API-equivalent estimates for subscription runs, not billed API spend or today's model prices. Its `durationMs` is a recorded duration statistic; the ledger does not establish total serial corpus runtime. Never compare differently scoped rows as one aggregate score.

| Variant | Verified roots and noise | Recorded duration | Historical API equivalent | Decision |
| --- | --- | --- | --- | --- |
| `0dff72dc…`, high, prompt `09d8a6ac…`, three repeats | Each 5/5 roots, 5/5 negatives rejected; 0 false positives, duplicates, suggestions, update noise | 76.8 / 88.8 / 82.0s | $1.149 / $1.116 / $1.123 per recorded run | Best repeatable five-root sandbox candidate |
| Same pipeline/prompt, low, one control | 5/5 roots, 5/5 negatives; same zero-noise score | 68.7s | $1.203 | Faster single result; insufficient repeatability; not cheaper here |
| `9f6b3afc…`, high, prompt `5d80311e…`, three repeats | Each 5/5 roots, 5/5 negatives; recorded zero noise | 81.7–87.3s | $1.076–$1.083 | Retired: key aliasing treated as proof could create false positives |
| `e8a11435…` initial / `893d57a1…` updates, high, prompt `ea99c44c…` | 5/5 initial roots; corrected heads 5/5 rejected, no update noise | 66.6 / 50.7s | $0.624 / $0.502 | Retired after development exposed nonrepeatable cache/confinement misses |
| Earlier `bd56ea25…` / `bf4b6ff1…` prompt families | Missed reference roots, duplicate findings or collapsed distinct roots; scopes differ from sandbox | 102.9–219.9s for completed examples | $0.278–$1.839 | Rejected; cheap runs still missed the intended bugs |

The complete selected candidate SHA is `0dff72dc08af980cf014b0be8b5a11bf0c74f026`; its prompt SHA-256 is `09d8a6acc6b0717a03f43567714dd4d758c05dfac7950e2485d53d9cd1df9976`. The matched grade files are [`frozen-high-subscription-4.json`](../../eval/grades/frozen-high-subscription-4.json), [`-5.json`](../../eval/grades/frozen-high-subscription-5.json), [`-6.json`](../../eval/grades/frozen-high-subscription-6.json), and the single [`frozen-low-subscription-2.json`](../../eval/grades/frozen-low-subscription-2.json). Each records five matched findings and an immutable raw artifact hash. These are historical Luna 5.6 results, not measurements of Luna 6.

## Later evidence and its limits

Local `~/Build/robin-eval-artifacts/daily/2026-08-14-evidence-loop-sandbox-high.json` and its grade tested the same five positive/five corrected-head set using GPT-5.6 Luna high, subscription transport. Raw metadata pins pipeline `3452277f5d0c04759d30fb1a88044c3169e70535` and prompt `daa7d935270d285fc141aab9c507d691c6231bee0d67b8e1066c846483d9007c`; the rollout note associates the packaged production change with `d2e0dcacadf64952845e93d0e5e8d0dce1407156`.

That run had 5/5 recall and precision, 5/5 corrected-head rejection, zero blocking false positives/suggestions/update noise, and 17–52s per reviewed head. Raw total corpus time was 374.2s including negative checks. Production calls: 25; input 582,525, cached input 286,464, output 4,972. Raw artifact SHA-256 `010586c208b80f58856dec9027bb7a59cc7ef61f687ef1f88230a8e5702c74a1` matches its grade; all five emitted findings are matched. Raw `costUsd=0` means subscription-unpriced. The rollout note's ~$0.071 API equivalent is an estimate; it is not a bill.

Separate historical real MIX evidence shows why sandbox perfection is insufficient. `fourth-holdout-luna-blind/score.json` for Robin `d9245a0038ea97f79e868f8c7dd69b37f6956436` records **1/13 reference roots recalled**, 12 validated true findings/14 emitted (85.7% precision including novel roots), 2 false findings, and 14/14 negative controls rejected. The 2026-08-14 production comparison recorded 52 valid/12 rejected human-dispositioned Robin roots (81.3% precision) across 94 paired heads, with weak reference overlap; later eight pairs supported an advisory cutover. These have different pipelines, samples, and historical pricing and cannot rank today's model.

Retained MIX Actions artifacts were downloaded and inspected:

- [Run 30996926736](https://github.com/suelio-arts/mix-mono/actions/runs/30996926736): PR 301 at `fa9cc6eedfe2822646c92d86f8acd6cd2a44bcf3`, candidate/final review arrays.
- [Run 30996382534](https://github.com/suelio-arts/mix-mono/actions/runs/30996382534): PR 300 at `be75f8b24d9dc839abb772f4f9040dd3607d551e`, candidate/final review arrays.
- [Run 30996380779](https://github.com/suelio-arts/mix-mono/actions/runs/30996380779): PR 300 at `d0f111fe29b042347b260f37369aba99b4eddf86`, candidate/final review arrays.

They contain raw findings, not native usage/scoring sufficient to compare cost, speed and validated quality against Luna 6 medium. Failed runs 31295910487 and 31295853645 retain no artifacts. The separate MIX benchmark workflow still uses Robin `01372e58c9199bafaf7dea9cb913d8554d9f49ee` and `luna-5-6-high-api`; its pin is not the production reviewer pin.

## Production decision and cost guardrails

Remote MIX `main` was inspected directly; local base and prior memory were stale. [`robin.yml`](https://github.com/suelio-arts/mix-mono/blob/main/.github/workflows/robin.yml) already uses Luna 6 medium at `f6ab938…`. None of the scored historical rows supplies a controlled, repeated comparison with that exact production pipeline, model, effort, and repository instructions. Keep it. No switch PR; recurring review cost change from this consolidation: **$0**.

Keep the current review policy: ready same-repository PRs on opened/reopened/ready-for-review and explicit `/robin`; automatic draft skip; no synchronize reviews; write-permission command guard; nonblocking `continue-on-error`, `fail-on-high=false`, `request-changes=false`; 10 inline comments; 30-minute workflow/300-second call timeouts; ARM runner; no cancellation of an already-spent review. No benchmark rerun or GitHub Robin review was triggered by this consolidation.

## Closing fixtures and retaining source refs

Close only inventory PRs 1–11, 13–17, 22–41 with a one-line link to this conclusion. Preserve all fixture head/base branches. The evaluator loads immutable Git snapshots, and `src/mix-eval-manifest.test.ts` validates the sandbox manifest. Closing PRs does not remove those inputs. The fixture repo's default tree contains only README, AGENTS and CodeRabbit config; it has no rerun workflow. Other generations lack a complete portable adjudicated manifest, so absence of a textual branch-name match is insufficient proof of safe deletion. Retaining source refs preserves these old inputs while removing them from the open delivery queue.

Workflow/script checks covered both Robin checkouts' evaluator/manifest tests, fixture default-tree scripts/workflows, and MIX's remote benchmark workflow. The MIX benchmark dispatch evaluates **MIX** history; its PR-number input must not be mistaken for a sandbox-repository PR number.

## How to rerun

For the Luna 6 commands below, use a clean isolated Robin evaluator checkout pinned to `164b252` (the inspected current evaluator; resolve and verify the exact commit before use). Historical candidate reproduction is a separate run using that candidate's historical evaluator and supported transports. The retained fixture refs must be fetched into an isolated `robin-benchmark` checkout; verify every manifest base/head exists with `git cat-file -e <sha>^{commit}`. Closed PRs need not be reopened. Use the manifest's exact SHAs, including earlier positive heads that differ from today's corrected PR heads.

```bash
# Run from a clean current Robin checkout; transport/model/effort are explicit.
# Substitute the actual isolated fixture checkout path below.
git -C /path/to/robin-benchmark fetch origin
MIX_REPO=/path/to/robin-benchmark EVAL_MANIFEST=eval/sandbox-prs.json EVAL_SET=holdout \
  EVAL_AGENT=luna-6-high-subscription npm run eval:mix -- /tmp/sandbox-high-1.json
MIX_REPO=/path/to/robin-benchmark EVAL_MANIFEST=eval/sandbox-prs.json EVAL_SET=holdout \
  EVAL_AGENT=luna-6-medium-subscription npm run eval:mix -- /tmp/sandbox-medium-1.json
MIX_REPO=/path/to/robin-benchmark EVAL_MANIFEST=eval/sandbox-prs.json EVAL_SET=holdout \
  EVAL_AGENT=luna-6-low-subscription npm run eval:mix -- /tmp/sandbox-low-1.json
npm run eval:score -- --inventory /tmp/sandbox-high-1.json
```

Adjudicate every emitted finding at its exact head into the grade schema, preserve raw SHA-256, then score three distinct runs of each identical candidate configuration:

```bash
npm run eval:score -- eval/sandbox-prs.json \
  /tmp/sandbox-high-1.json /tmp/grade-high-1.json \
  /tmp/sandbox-high-2.json /tmp/grade-high-2.json \
  /tmp/sandbox-high-3.json /tmp/grade-high-3.json
```

For historical reproduction, use the matching historical candidate checkout and its supported agent/model transport; do not rename an old Luna 5.6 result as Luna 6. To cover the remaining generations, first freeze exact base/head labels and independent negative/update controls from the retained inventory; the existing sandbox manifest covers only PRs 2–6.

Before promotion, use a fresh unseen MIX holdout, three distinct OpenAI-direct API runs with native usage and model-specific prices, and the criteria in [`eval/README.md`](../../eval/README.md). Subscription runs are development evidence. The current evaluator supports high/low API transports and medium subscription; measuring medium API requires an explicit supported evaluator change before promotion. Do not silently substitute high or low for medium. Load credentials through an existing scoped consumer without printing them.
