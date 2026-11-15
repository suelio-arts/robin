# Trusted review admission

Pin `suelio-arts/robin/trigger@<full commit SHA>` in both the hosted admission
job and the self-hosted review job of `.github/workflows/robin.yml`.
The action uses the calling repository from GitHub context; no checkout is
needed to run it. Pass `github-token: ${{ github.token }}` and, in the review
job, the earlier `pr-number` and `expected-head-sha` outputs.

The hosted job needs actions write, contents read and pull-requests read. Review
revalidation needs pull-requests read only. Open/reopened/ready same-repository
main PRs, pushes that merge or rebase onto main or reach a PR without a
standing Robin approval (`synchronize`; a plain push of the author's own commits
to an approved PR does not) and write-authorized `/robin` comments dispatch
`robin.yml` on main. A head is covered when Robin's approval of it stands. A dispatched review whose change and prompts match
an earlier review on the PR reuses it without a model call. Main dispatches
revalidate the live head, bot receipts and three-head cap before admission.
Forks, drafts, closed PRs and moved heads are skipped. Permission lookup failures
fail closed. This action does not check out or execute PR code or invoke models.
The runner owner remains responsible for repository and workflow access policy.

Run `node --test trigger/robin-review-trigger.test.mjs` to verify admission.
