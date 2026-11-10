# Robin

Robin is an AI pull-request review action and reusable workflow. `src/` owns implementation, `dist/` the bundled runtime, `bin/` and `scripts/` installers, `skills/` the companion skill, and `.github/workflows/` review, self-test and release workflows. See `README.md`, `CONTRIBUTING.md` and `docs/ADVANCED.md` for setup, development and operation.

For adding Robin to another repository, follow `docs/AGENT-CONSUMER-SETUP.md`. Never check out or execute pull-request code under `pull_request_target`; its API-only path requires a pinned trusted base workflow.
