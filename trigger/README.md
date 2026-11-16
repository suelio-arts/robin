# Trusted review admission

Pin `suelio-arts/robin/trigger@<full commit SHA>` in both the hosted admission
job and the self-hosted review job of `.github/workflows/robin.yml`.
The action uses the calling repository from GitHub context; no checkout is
needed to run it. Pass `github-token: ${{ github.token }}` and, in the review
job, the earlier `pr-number` and `expected-head-sha` outputs.

The hosted job needs actions write, contents read and pull-requests read. Review
revalidation needs pull-requests read only. Every subscribed `pull_request_target`
event on a same-repository main PR (subscribe to `opened` and `ready_for_review`
for one review per PR) and every write-authorized `/robin` comment dispatches
`robin.yml` on main. Main dispatches revalidate the live head before admission.
Forks, drafts, closed PRs and moved heads are skipped. Permission lookup failures
fail closed. This action does not check out or execute PR code or invoke models.
The runner owner remains responsible for repository and workflow access policy.

Run `node --test trigger/robin-review-trigger.test.mjs` to verify admission.
