/**
 * `robin-review pr` — what does Robin say about this PR's exact head?
 *
 * Robin is advisory: it never gates a merge, so this command never pretends to.
 * It answers three independent questions and lets the caller decide:
 *
 *   coverage — did Robin finish on this exact head?
 *              reviewed | reused | skipped (complete)
 *              incomplete | outdated | missing | unavailable | running (not)
 *   findings — how many issues, at what severity, and did Robin request changes
 *   authority — none. Exit codes describe coverage and findings only.
 *
 * Exit 0 = complete coverage, zero findings. 2 = complete coverage with
 * findings. 3 = no complete coverage of this head (`message` names the one next
 * action). 1 = a CLI, gh, or usage failure.
 *
 * Coverage comes from a receipt: a PR review at `commit_id == head` from a
 * trusted author carrying the outcome marker that `src/outcome.ts` stamps.
 * Bodies from engines that predate the marker fall back to their stat blocks.
 */
const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { isRobinWorkflow, hasIssueCommentTrigger } = require("./robin-workflow-ref");

/** Identical to OUTCOME_MARKER_PATTERN in src/outcome.ts; keep the two in sync. */
const OUTCOME_MARKER_PATTERN =
  /<!--\s*robin-outcome:\s*v1\s+(reviewed|reused|skipped|incomplete)\s+head=([0-9a-f]{40})(?:\s+high=(\d+)\s+medium=(\d+)\s+low=(\d+)\s+suggestions=(\d+))?\s*-->/g;

const ROBIN_SIGNATURE = ":bow_and_arrow: Robin";
const LEGACY_INCOMPLETE = "Robin could not complete this review";
const BOT_LOGIN = "github-actions[bot]";
const COMPLETE_OUTCOMES = new Set(["reviewed", "reused", "skipped"]);
/** Run conclusions that mean "nothing went wrong", so a missing review is not a failure. */
const BENIGN_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);
const ZERO_COUNTS = { high: 0, medium: 0, low: 0, suggestions: 0 };
const DEFAULT_MODEL = "luna-5-6-low-subscription";
/** A dispatched workflow has 180 s to produce a run before we call it missing. */
const RUN_APPEAR_TIMEOUT_MS = 180000;
/** Extra polls after a run finishes, so a receipt that lags the run is still seen. */
const RECEIPT_GRACE_POLLS = 2;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const short = (sha) => String(sha || "").slice(0, 12);

/** First line only, with token-shaped substrings removed. Never echoes argv. */
function sanitize(text, secrets = []) {
  let line = String(text || "")
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean) || "";
  for (const secret of secrets) {
    if (secret && secret.length >= 8) line = line.split(secret).join("[redacted]");
  }
  return line
    .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, "[redacted]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[redacted]");
}

const fail = (message, json = false) => {
  if (json) console.log(JSON.stringify({ status: "error", message }));
  else console.error(`🏹 ${message}`);
  process.exit(1);
};

function gh(args) {
  try {
    return cp.execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    throw new Error(sanitize(error.stderr) || `gh ${args[0]} failed`);
  }
}

const ghJson = (args) => JSON.parse(gh(args) || "null");
const ghQuiet = (args) => {
  try {
    return gh(args);
  } catch {
    return null;
  }
};

function parseArgs(argv) {
  const options = {
    timeout: 1800,
    interval: 10,
    json: false,
    rerun: false,
    local: false,
    model: DEFAULT_MODEL,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") options.repo = argv[++index];
    else if (arg === "--timeout") options.timeout = Number(argv[++index]);
    else if (arg === "--interval") options.interval = Number(argv[++index]);
    else if (arg === "--json") options.json = true;
    else if (arg === "--rerun") options.rerun = true;
    else if (arg === "--local") options.local = true;
    else if (arg === "--workspace") options.workspace = argv[++index];
    else if (arg === "--model") options.model = argv[++index];
    else if (arg === "--engine") options.engine = argv[++index];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (!options.pr) options.pr = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!Number.isFinite(options.timeout) || options.timeout <= 0) {
    throw new Error("--timeout must be a positive number of seconds");
  }
  if (!Number.isFinite(options.interval) || options.interval <= 0) {
    throw new Error("--interval must be a positive number of seconds");
  }
  return options;
}

// ---------------------------------------------------------------- receipts

/** The last marker in a body wins, so a reused body re-stamped at a new head is read correctly. */
function parseOutcomeMarker(body) {
  const pattern = new RegExp(OUTCOME_MARKER_PATTERN.source, "g");
  let last = null;
  let match;
  while ((match = pattern.exec(body || "")) !== null) last = match;
  if (!last) return null;
  const counts =
    last[3] === undefined
      ? null
      : { high: Number(last[3]), medium: Number(last[4]), low: Number(last[5]), suggestions: Number(last[6]) };
  return { outcome: last[1], head: last[2], counts };
}

/** Counts from a pre-marker review body's stat blocks, or null when unparseable. */
function parseStatBlocks(body) {
  const text = String(body || "");
  if (/\*\*No issues found\*\*/.test(text)) return { ...ZERO_COUNTS };
  const read = (label) => {
    const match = text.match(new RegExp(`\\*\\*(\\d+)\\s+${label}\\*\\*`));
    return match ? Number(match[1]) : null;
  };
  const parsed = { high: read("High"), medium: read("Medium"), low: read("Low"), suggestions: read("Suggestions") };
  if (Object.values(parsed).every((value) => value === null)) return null;
  return {
    high: parsed.high || 0,
    medium: parsed.medium || 0,
    low: parsed.low || 0,
    suggestions: parsed.suggestions || 0,
  };
}

/**
 * A receipt for `head`, or null when this body says nothing about it.
 *
 * `allowLegacy` must only be true for `github-actions[bot]`. The marker-less
 * fallback recognises a receipt by prose, which anyone can write: a human
 * quoting a Robin review — or this account's own pre-marker local runs — must
 * never be read as coverage. Local runs always stamp a marker, so a receipt
 * from the authenticated login requires one.
 */
function receiptFromBody(body, head, allowLegacy = true) {
  const marker = parseOutcomeMarker(body);
  if (marker) {
    if (marker.head !== head) return null;
    if (marker.outcome === "incomplete") return { outcome: marker.outcome, counts: { ...ZERO_COUNTS } };
    // A body cached before markers existed is re-stamped without a counts tail;
    // its stat blocks still carry the numbers.
    return { outcome: marker.outcome, counts: marker.counts || parseStatBlocks(body) };
  }
  if (!allowLegacy) return null;
  const text = String(body || "");
  if (!text.includes(ROBIN_SIGNATURE)) return null;
  if (text.includes(LEGACY_INCOMPLETE)) return { outcome: "incomplete", counts: { ...ZERO_COUNTS } };
  return { outcome: "reviewed", counts: parseStatBlocks(text) };
}

// ------------------------------------------------------------------ github

function createSession(options) {
  const viewArgs = ["pr", "view"];
  if (options.pr) viewArgs.push(options.pr);
  if (options.repo) viewArgs.push("--repo", options.repo);
  viewArgs.push("--json", "number,headRefOid,baseRefName,baseRefOid,url");
  const pr = ghJson(viewArgs);
  if (!pr || !pr.headRefOid) throw new Error("Could not resolve the pull request head.");
  const repo = options.repo || gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  return {
    options,
    repo,
    number: pr.number,
    head: pr.headRefOid,
    base: pr.baseRefName,
    baseSha: pr.baseRefOid,
    url: pr.url,
    login: undefined,
  };
}

/** Local runs post as a human, so their receipts are only trusted from this login. */
function authenticatedLogin(session) {
  if (session.login === undefined) session.login = ghQuiet(["api", "user", "--jq", ".login"]) || null;
  return session.login;
}

const isBot = (review) => Boolean(review.user) && review.user.login === BOT_LOGIN;

const isTrusted = (session, review) => {
  const login = review.user && review.user.login;
  if (!login) return false;
  return login === BOT_LOGIN || login === authenticatedLogin(session);
};

function fetchReviews(session) {
  const pages = ghJson(["api", "--paginate", "--slurp", `repos/${session.repo}/pulls/${session.number}/reviews?per_page=100`]);
  return Array.isArray(pages) ? pages.flat() : [];
}

/** Every trusted receipt at `head`, newest first. */
function receiptsAtHead(session, reviews, head) {
  return reviews
    .filter((review) => review.commit_id === head && isTrusted(session, review))
    .sort((left, right) => new Date(right.submitted_at) - new Date(left.submitted_at))
    .map((review) => {
      const receipt = receiptFromBody(review.body, head, isBot(review));
      return receipt && { ...receipt, review };
    })
    .filter(Boolean);
}

/** Newest receipt at `head` wins: an older complete review never masks a newer incomplete one. */
const newestReceipt = (session, reviews, head) => receiptsAtHead(session, reviews, head)[0] || null;

const hasOlderReceipt = (session, reviews, head) =>
  reviews.some(
    (review) =>
      review.commit_id &&
      review.commit_id !== head &&
      isTrusted(session, review) &&
      receiptFromBody(review.body, review.commit_id, isBot(review)) !== null
  );

/**
 * Which active workflows in this repo are Robin, and which of them answer
 * `/robin`? Read at the PR base ref, because that is the revision GitHub runs.
 */
function preflightWorkflows(session) {
  let pages;
  try {
    pages = ghJson(["api", "--paginate", "--slurp", `repos/${session.repo}/actions/workflows?per_page=100`]);
  } catch (error) {
    return { workflows: [], paths: [], commandPaths: [], error: error.message };
  }
  const listed = (Array.isArray(pages) ? pages : []).flatMap((page) => (page && page.workflows) || []);
  const found = [];
  for (const workflow of listed) {
    if (!workflow || workflow.state !== "active" || !workflow.path) continue;
    const encoded = ghQuiet(["api", `repos/${session.repo}/contents/${workflow.path}?ref=${session.base}`, "--jq", ".content"]);
    if (!encoded) continue;
    const source = Buffer.from(encoded.replace(/\s+/g, ""), "base64").toString("utf8");
    if (!isRobinWorkflow(source)) continue;
    found.push({ id: workflow.id, path: workflow.path, command: hasIssueCommentTrigger(source) });
  }
  return {
    workflows: found,
    paths: found.map((workflow) => workflow.path),
    commandPaths: found.filter((workflow) => workflow.command).map((workflow) => workflow.path),
    error: null,
  };
}

/**
 * Can this run be reviewing our head?
 *
 *   "head"  — the API ties it to this exact head: it is this head's run.
 *   "pr"    — the API ties it to this pull request but it started at an older
 *             commit. It is NOT coverage of the current head, but it is still
 *             very much ours: the reusable workflow checks out `refs/pull/N/head`
 *             at run start and the engine re-reads the PR's current head from
 *             the API at run time, so such a run can legitimately post an
 *             exact-head receipt for the head we are asking about. It must be
 *             waited for, and never cancelled by posting `/robin` over it.
 *   "other" — the API names pull requests and ours is not among them, so it is
 *             not ours even when the head SHA matches (two PRs can share a head).
 *   "none"  — comment- or dispatch-triggered. Those runs carry the DEFAULT
 *             BRANCH head and an empty `pull_requests`, so the API cannot say
 *             which PR they review. Never treat them as covering this head, but
 *             never assume they are somebody else's either.
 *
 * Only "head" is coverage. "pr" and "none" block and are waited for; "other"
 * never blocks. Do not collapse these four back into a boolean.
 */
function correlationOf(session, run) {
  const pulls = run.pull_requests || [];
  if (pulls.length) {
    if (!pulls.some((pull) => pull.number === session.number)) return "other";
    return run.head_sha === session.head ? "head" : "pr";
  }
  if (run.head_sha === session.head) return "head";
  if (run.event === "pull_request" || run.event === "pull_request_target") return "other";
  return "none";
}

/**
 * Runs of the recognized Robin workflows, newest first, deduped by id and each
 * tagged with its correlation.
 *
 * One page of recent runs is not enough in a busy repository, and unbounded
 * pagination is not an option, so ask five bounded, targeted questions per
 * workflow instead: the three active states (a run in flight must never be
 * missed — posting `/robin` would cancel it), everything at this head (which is
 * exactly what `pull_request` runs carry), and one page of recent runs so a
 * freshly dispatched `issue_comment` run — which carries the DEFAULT BRANCH
 * head and no pull request, and so appears in neither of the others — is seen.
 */
const RUN_QUERIES = [
  "status=queued&per_page=100",
  "status=in_progress&per_page=100",
  "status=waiting&per_page=100",
  "per_page=50",
];

function robinRuns(session, workflows) {
  const byId = new Map();
  const queries = [...RUN_QUERIES, `head_sha=${session.head}&per_page=100`];
  for (const workflow of workflows) {
    for (const query of queries) {
      const payload = ghJson(["api", `repos/${session.repo}/actions/workflows/${workflow.id}/runs?${query}`]);
      for (const run of (payload && payload.workflow_runs) || []) {
        if (!byId.has(run.id)) byId.set(run.id, { ...run, correlation: correlationOf(session, run) });
      }
    }
  }
  return [...byId.values()].sort(
    (left, right) => new Date(right.created_at || 0) - new Date(left.created_at || 0)
  );
}

const currentHead = (session) => {
  const pr = ghJson(["pr", "view", String(session.number), "--repo", session.repo, "--json", "headRefOid"]);
  return (pr && pr.headRefOid) || session.head;
};

// -------------------------------------------------------------------- wait

function snapshot(session, workflows) {
  const reviews = fetchReviews(session);
  const runs = robinRuns(session, workflows);
  // A run the API pins to another pull request cannot be ours, so it never blocks us.
  const active = runs.filter((run) => run.status !== "completed" && run.correlation !== "other");
  const receipts = receiptsAtHead(session, reviews, session.head);
  return {
    reviews,
    runs,
    receipts,
    receipt: receipts[0] || null,
    active: active.find((run) => run.correlation === "head") || active[0] || null,
    activeCorrelated: active.find((run) => run.correlation === "head") || null,
  };
}

/**
 * Bounded: only ever entered while a recognized Robin run is active. An
 * uncorrelated comment run is waited for too, because it may be this PR's.
 */
function waitForSettled(session, workflows, deadline, intervalMs, initial) {
  let state = initial || snapshot(session, workflows);
  let grace = RECEIPT_GRACE_POLLS;
  for (;;) {
    if (!state.active) {
      if (state.receipt || grace <= 0) return state;
      grace -= 1;
    }
    if (Date.now() >= deadline) return { ...state, timedOut: true };
    sleep(intervalMs);
    state = snapshot(session, workflows);
  }
}

/**
 * A run we started by commenting carries the default-branch head, so it can only
 * be identified heuristically. The terminal condition is therefore the receipt,
 * not the run: a NEW trusted review at this head that was not there before.
 */
const isDispatchedRun = (session, run, context) =>
  run.event === "issue_comment" &&
  context.commandPaths.includes(run.path) &&
  !context.knownRunIds.has(run.id) &&
  new Date(run.created_at || 0).getTime() >= context.postedAt - 60000 &&
  (!context.login || !run.actor || !run.actor.login || run.actor.login === context.login);

function waitForDispatched(session, workflows, context, deadline, intervalMs) {
  const appearDeadline = Math.min(context.postedAt + RUN_APPEAR_TIMEOUT_MS, deadline);
  let everSeen = false;
  let grace = RECEIPT_GRACE_POLLS;
  for (;;) {
    const state = snapshot(session, workflows);
    const fresh = state.receipts.find((receipt) => !context.priorReceiptIds.has(receipt.review.id));
    const candidates = state.runs.filter((run) => isDispatchedRun(session, run, context));
    if (fresh) return { state, run: candidates[0] || null };
    if (candidates.length) {
      everSeen = true;
      if (!candidates.some((run) => run.status !== "completed")) {
        if (grace <= 0) return { state, run: candidates[0], settled: true };
        grace -= 1;
      }
    } else if (!everSeen && Date.now() >= appearDeadline) {
      return { state, run: null, neverStarted: true };
    }
    if (Date.now() >= deadline) return { state, run: candidates[0] || null, timedOut: true };
    sleep(intervalMs);
  }
}

// ------------------------------------------------------------------ result

function buildResult(session, parts) {
  const { coverage, receipt, check, execution, engine } = parts;
  let status = coverage;
  let findings = null;
  if (COMPLETE_OUTCOMES.has(coverage)) {
    findings = receipt ? receipt.counts : null;
    if (findings) {
      const total = findings.high + findings.medium + findings.low + findings.suggestions;
      status = total === 0 ? "clean" : "findings";
    } else {
      status = "findings";
    }
  }
  const review = receipt && receipt.review;
  const result = {
    status,
    coverage,
    repo: session.repo,
    pr: session.number,
    head: parts.head || session.head,
    execution: execution || null,
    findings,
    verdict: (review && review.state) || null,
    blocking: review ? review.state === "CHANGES_REQUESTED" : false,
    receipt: review
      ? {
        reviewId: review.id,
        reviewUrl: review.html_url,
        author: (review.user && review.user.login) || null,
        submittedAt: review.submitted_at,
      }
      : null,
    check: check
      ? {
        conclusion: check.conclusion === undefined ? null : check.conclusion,
        runUrl: check.html_url,
        correlated: check.correlation === "head",
        event: check.event || null,
      }
      : null,
    message: parts.message || describe(status, coverage, findings, parts.head || session.head),
  };
  if (engine) result.engine = engine;
  return result;
}

function describe(status, coverage, findings, head) {
  if (status === "clean") return `Robin completed on ${short(head)} (${coverage}) with no findings.`;
  if (status === "findings" && !findings) {
    return `Robin completed on ${short(head)} but its finding counts could not be read; open the review to judge it.`;
  }
  if (status === "findings") {
    return `Robin completed on ${short(head)}: ${findings.high} high, ${findings.medium} medium, ${findings.low} low, ${findings.suggestions} suggestions.`;
  }
  return `Robin has no complete review of ${short(head)} (${coverage}).`;
}

const exitCodeFor = (result) => (result.status === "clean" ? 0 : result.status === "findings" ? 2 : 3);

function printResult(options, result) {
  if (options.json) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log(`🏹 PR #${result.pr} @ ${short(result.head)} — ${result.status} (${result.coverage})`);
  if (result.findings) {
    console.log(
      `   findings: ${result.findings.high} high, ${result.findings.medium} medium, ${result.findings.low} low, ${result.findings.suggestions} suggestions`
    );
  }
  if (result.verdict) console.log(`   verdict: ${result.verdict}${result.blocking ? " (changes requested)" : ""}`);
  if (result.receipt) console.log(`   review: ${result.receipt.reviewUrl}`);
  if (result.check) console.log(`   run: ${result.check.conclusion || "in progress"} (${result.check.runUrl})`);
  console.log(`   ${result.message}`);
}

// ------------------------------------------------------------ local engine

/** Inherited Actions settings must never subvert the forced policy below. */
function childEnvironment(base, forced) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (/^(INPUT_|GITHUB_|RUNNER_|ACTIONS_)/.test(key) || key === "CI") continue;
    env[key] = value;
  }
  return Object.assign(env, forced);
}

/** GITHUB_OUTPUT uses `key=value` or a heredoc block per @actions/core. */
function parseOutputFile(file) {
  const outputs = {};
  if (!fs.existsSync(file)) return outputs;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const heredoc = lines[index].match(/^([A-Za-z0-9_.-]+)<<(\S+)$/);
    if (heredoc) {
      const value = [];
      index += 1;
      while (index < lines.length && lines[index] !== heredoc[2]) {
        value.push(lines[index]);
        index += 1;
      }
      outputs[heredoc[1]] = value.join("\n");
      continue;
    }
    const pair = lines[index].match(/^([A-Za-z0-9_.-]+)=(.*)$/);
    if (pair) outputs[pair[1]] = pair[2];
  }
  return outputs;
}

function git(workspace, args) {
  const result = cp.spawnSync("git", ["-C", workspace, ...args], { encoding: "utf8" });
  return { ok: result.status === 0, out: String(result.stdout || "").trim() };
}

/**
 * A GITHUB_OUTPUT line is not proof: the engine could have written it without
 * posting, or posted somewhere else. Fetch the review and require that it is at
 * this head, from this login, and carries a marker naming this head.
 */
function validateLocalReceipt(session, outputs) {
  const reviewId = outputs["review-id"];
  if (!reviewId || !/^\d+$/.test(String(reviewId))) return null;
  const raw = ghQuiet(["api", `repos/${session.repo}/pulls/${session.number}/reviews/${reviewId}`]);
  if (!raw) return null;
  let review;
  try {
    review = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!review || review.commit_id !== session.head) return null;
  const login = authenticatedLogin(session);
  if (!login || !review.user || review.user.login !== login) return null;
  const marker = parseOutcomeMarker(review.body);
  if (!marker || marker.head !== session.head) return null;
  return { outcome: marker.outcome, counts: marker.outcome === "incomplete" ? { ...ZERO_COUNTS } : marker.counts, review };
}

function runLocal(session, options, workflows) {
  if (!options.model.endsWith("-subscription")) {
    fail(`--model must be a subscription profile ending in -subscription (got ${options.model}). Robin's local mode never falls back to an API key.`, options.json);
  }
  if (!options.workspace) fail("--local requires --workspace <dir> pointing at a checkout of the PR head.", options.json);
  const enginePath = path.resolve(options.engine || path.join(__dirname, "..", "dist", "index.js"));
  if (!fs.existsSync(enginePath)) {
    fail(`Robin engine not found at ${enginePath}. Run from a Robin checkout with dist/ built, or pass --engine <path>.`, options.json);
  }
  const workspace = path.resolve(options.workspace);
  const workspaceHead = git(workspace, ["rev-parse", "HEAD"]).out;
  if (workspaceHead !== session.head) {
    fail(`Workspace ${workspace} is at ${short(workspaceHead) || "no commit"}, not the PR head ${short(session.head)}. Prepare the checkout first; Robin never fetches or checks out for you.`, options.json);
  }
  if (session.baseSha && !git(workspace, ["cat-file", "-e", `${session.baseSha}^{commit}`]).ok) {
    fail(`Workspace ${workspace} is missing base commit ${short(session.baseSha)}. Prepare the checkout with full history first.`, options.json);
  }

  const active = robinRuns(session, workflows).find(
    (run) => run.status !== "completed" && run.correlation !== "other"
  );
  if (active) {
    const head = short(session.head);
    const why =
      active.correlation === "head"
        ? `A Robin workflow run is already active on ${head}.`
        : active.correlation === "pr"
          ? `A Robin run for this pull request started at an older commit is still active in ${session.repo}; Robin reviews the current head at run time, so it may cover ${head}.`
          : `A Robin comment-triggered run is active in ${session.repo}; the API does not tie it to a pull request, so it may be reviewing this PR.`;
    return buildResult(session, {
      coverage: "running",
      check: active,
      message: `${why} Not starting a local run: it would duplicate that one. Wait for it, or re-run this command.`,
    });
  }
  if (!options.rerun) {
    const existing = newestReceipt(session, fetchReviews(session), session.head);
    if (existing && COMPLETE_OUTCOMES.has(existing.outcome)) {
      return buildResult(session, {
        coverage: existing.outcome,
        receipt: existing,
        execution: existing.review.user.login === BOT_LOGIN ? "actions" : "local",
      });
    }
  }

  const token = ghQuiet(["auth", "token"]);
  if (!token) fail("gh auth token failed; sign in with gh before using --local.", options.json);
  const caller = process.env.CLAUDECODE ? "claude" : "codex";
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "robin-local-"));
  const engine = {
    path: enginePath,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(enginePath)).digest("hex"),
    model: options.model,
    caller,
  };
  let outputs = {};
  let spawned;
  try {
    const eventPath = path.join(temp, "event.json");
    const outputPath = path.join(temp, "output");
    fs.writeFileSync(eventPath, "{}");
    fs.writeFileSync(outputPath, "");
    const env = childEnvironment(process.env, {
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: session.repo,
      GITHUB_WORKSPACE: workspace,
      GITHUB_OUTPUT: outputPath,
      RUNNER_TEMP: temp,
      ROBIN_AGENT_CALLER: caller,
      "INPUT_GITHUB-TOKEN": token,
      "INPUT_PR-NUMBER": String(session.number),
      "INPUT_EXPECTED-HEAD-SHA": session.head,
      "INPUT_LLM-BASE-URL": "rolly-agent",
      INPUT_MODEL: options.model,
      "INPUT_REQUEST-CHANGES": "false",
      "INPUT_FAIL-ON-HIGH": "false",
      "INPUT_REVIEW-ON-SYNCHRONIZE": "false",
      "INPUT_MAX-DIFF-SIZE": "50000",
      "INPUT_MAX-COMMENTS": "15",
      "INPUT_LLM-TIMEOUT-MS": "600000",
      "INPUT_REVIEW-INSTRUCTIONS-FILE": ".github/code-reviewer.md",
      "INPUT_CONFIG-FILE": ".github/robin.yml",
    });
    spawned = cp.spawnSync(process.execPath, [enginePath], {
      cwd: workspace,
      env,
      stdio: ["ignore", 2, 2],
      timeout: options.timeout * 1000,
    });
    outputs = parseOutputFile(outputPath);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  const movedTo = currentHead(session);
  if (movedTo !== session.head) {
    return buildResult(session, {
      coverage: "outdated",
      head: movedTo,
      execution: "local",
      engine,
      message: `The PR head moved to ${short(movedTo)} while the local run was in flight; the review does not cover it.`,
    });
  }

  const outcome = outputs.outcome;
  if (outcome === "stale-head") {
    return buildResult(session, {
      coverage: "outdated",
      execution: "local",
      engine,
      message: `The engine refused to review: the PR head is no longer ${short(session.head)}.`,
    });
  }
  if (spawned.status !== 0 || !outcome) {
    return buildResult(session, {
      coverage: "incomplete",
      execution: "local",
      engine,
      message: `The local Robin run did not complete on ${short(session.head)} (engine exit ${spawned.status === null ? "timeout" : spawned.status}). Re-run, or use \`--rerun\` to dispatch the workflow.`,
    });
  }
  const receipt = validateLocalReceipt(session, outputs);
  if (!receipt) {
    return buildResult(session, {
      coverage: "incomplete",
      execution: "local",
      engine,
      message: `The local run reported "${outcome}" but no review at ${short(session.head)} from this account carries a matching outcome marker.`,
    });
  }
  if (receipt.outcome === "incomplete") {
    return buildResult(session, {
      coverage: "incomplete",
      receipt,
      execution: "local",
      engine,
      message: `Robin could not complete the review at ${short(session.head)}. Re-run \`--local\`, or comment \`/robin\` with \`--rerun\`.`,
    });
  }
  return buildResult(session, { coverage: receipt.outcome, receipt, execution: "local", engine });
}

// -------------------------------------------------------------- observe

function observe(session, options, workflows) {
  const intervalMs = options.interval * 1000;
  const deadline = Date.now() + options.timeout * 1000;
  let state = snapshot(session, workflows.workflows);
  let waited = false;

  if (state.active) {
    // Posting `/robin` now would cancel the live run through the workflow's
    // concurrency group, so settle first whether or not this is a rerun.
    const before = new Set(state.receipts.map((receipt) => receipt.review.id));
    state = waitForSettled(session, workflows.workflows, deadline, intervalMs, state);
    waited = true;
    const arrived = state.receipt;
    const isNew = arrived && !before.has(arrived.review.id) && COMPLETE_OUTCOMES.has(arrived.outcome);
    if (!options.rerun || state.timedOut || isNew) return report(session, workflows, state, waited);
  }

  if (!options.rerun) return report(session, workflows, state, waited);

  if (!workflows.commandPaths.length) {
    return buildResult(session, {
      coverage: "unavailable",
      message: workflows.paths.length
        ? `No active Robin workflow in ${session.repo} answers \`/robin\` (an issue_comment trigger is required). Run \`--local\`, or add the trigger.`
        : unavailableMessage(session, workflows),
    });
  }

  const context = {
    commandPaths: workflows.commandPaths,
    knownRunIds: new Set(state.runs.map((run) => run.id)),
    priorReceiptIds: new Set(state.receipts.map((receipt) => receipt.review.id)),
    login: authenticatedLogin(session),
    postedAt: Date.now(),
  };
  gh(["pr", "comment", String(session.number), "--repo", session.repo, "--body", "/robin"]);
  const dispatched = waitForDispatched(session, workflows.workflows, context, deadline, intervalMs);
  if (dispatched.neverStarted) {
    return buildResult(session, {
      coverage: "missing",
      message: `Posted \`/robin\` but the Robin workflow did not start for head ${short(session.head)}. Check Actions for ${session.repo}.`,
    });
  }
  return report(session, workflows, dispatched.state, true, {
    excludeReceiptIds: context.priorReceiptIds,
    check: dispatched.run,
  });
}

/** Say exactly how the active run relates to this head — never more than the API knows. */
function runningMessage(session, run) {
  const head = short(session.head);
  if (run.correlation === "head") {
    return `Robin is still running on ${head} after ${session.options.timeout}s. Re-run this command to keep waiting.`;
  }
  if (run.correlation === "pr") {
    return `A Robin run for this pull request started at an older commit is still active in ${session.repo}; Robin reviews the current head at run time, so it may cover ${head}. Waited ${session.options.timeout}s without a review at ${head}. Re-run to keep waiting.`;
  }
  return `A Robin comment-triggered run is active in ${session.repo}; the API does not tie it to a pull request, so it may be reviewing this PR. Waited ${session.options.timeout}s without a review at ${head}. Re-run to keep waiting.`;
}

const unavailableMessage = (session, workflows) =>
  workflows.error
    ? `Could not determine whether ${session.repo} has an active Robin workflow (${workflows.error}). Not waiting and not posting.`
    : `No active Robin workflow in ${session.repo}. Install Robin with \`npx robin-review\`, or review this head now with \`--local --workspace <dir>\`.`;

function report(session, workflows, state, waited, extra = {}) {
  const correlatedRun = state.runs.find((run) => run.correlation === "head") || null;
  if (waited) {
    const movedTo = currentHead(session);
    if (movedTo !== session.head) {
      return buildResult(session, {
        coverage: "outdated",
        head: movedTo,
        check: extra.check || correlatedRun,
        message: `The PR head moved to ${short(movedTo)} while waiting; Robin's review no longer covers it.`,
      });
    }
  }

  // A rerun must never satisfy itself with a receipt that predates its `/robin`.
  const receipt = extra.excludeReceiptIds
    ? state.receipts.find((candidate) => !extra.excludeReceiptIds.has(candidate.review.id)) || null
    : state.receipt;
  const check = extra.check || correlatedRun;
  if (receipt && COMPLETE_OUTCOMES.has(receipt.outcome)) {
    return buildResult(session, {
      coverage: receipt.outcome,
      receipt,
      check,
      execution: receipt.review.user.login === BOT_LOGIN ? "actions" : "local",
    });
  }
  if (receipt) {
    return buildResult(session, {
      coverage: "incomplete",
      receipt,
      check,
      execution: receipt.review.user.login === BOT_LOGIN ? "actions" : "local",
      message: `Robin could not complete the review at ${short(session.head)}. Comment \`/robin\` (\`--rerun\`) or run \`--local\`.`,
    });
  }
  if (state.active) {
    return buildResult(session, { coverage: "running", check: state.active, message: runningMessage(session, state.active) });
  }
  if (check) {
    // A run that succeeded but posted nothing is not a failed review: a workflow
    // still subscribed to `synchronize` produces a successful run the engine
    // skips on every push. Only a run that did not succeed is `incomplete`.
    if (BENIGN_CONCLUSIONS.has(check.conclusion)) {
      return buildResult(session, {
        coverage: "missing",
        check,
        message: `The Robin run for ${short(session.head)} finished (${check.conclusion}) without posting a review — the event was skipped or nothing was reviewed. Comment \`/robin\` (\`--rerun\`) or run \`--local\`.`,
      });
    }
    return buildResult(session, {
      coverage: "incomplete",
      check,
      message: `The Robin run for ${short(session.head)} finished as ${check.conclusion || "unknown"} without posting a review. Comment \`/robin\` (\`--rerun\`) or run \`--local\`.`,
    });
  }
  if (!workflows.paths.length) {
    return buildResult(session, { coverage: "unavailable", message: unavailableMessage(session, workflows) });
  }
  if (hasOlderReceipt(session, state.reviews, session.head)) {
    return buildResult(session, {
      coverage: "outdated",
      message: `Robin's newest review covers an older head, not ${short(session.head)}. Comment \`/robin\` (\`--rerun\`) or run \`--local\`.`,
    });
  }
  return buildResult(session, {
    coverage: "missing",
    message: `No Robin run for head ${short(session.head)}. Comment \`/robin\` (\`--rerun\`) or run \`--local\`.`,
  });
}

// ------------------------------------------------------------------- main

const USAGE = [
  "Usage: robin-review pr [number|url] [--repo owner/repo] [--rerun] [--json]",
  "                       [--timeout seconds] [--interval seconds]",
  "                       [--local --workspace <dir> [--model <profile>] [--engine <path>]]",
  "",
  "Exit codes: 0 complete coverage, no findings · 2 complete coverage with findings",
  "            3 no complete coverage of this head · 1 CLI/gh/usage failure",
].join("\n");

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    fail(error.message);
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }

  let session;
  try {
    session = createSession(options);
  } catch (error) {
    fail(error.message, options.json);
  }

  let result;
  try {
    const workflows = preflightWorkflows(session);
    result = options.local ? runLocal(session, options, workflows.workflows) : observe(session, options, workflows);
  } catch (error) {
    fail(sanitize(error.message), options.json);
  }
  printResult(options, result);
  process.exit(exitCodeFor(result));
}

module.exports = {
  main,
  parseArgs,
  parseOutcomeMarker,
  parseStatBlocks,
  receiptFromBody,
  childEnvironment,
  parseOutputFile,
  OUTCOME_MARKER_PATTERN,
};
