const cp = require("child_process");

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const fail = (message, json = false) => {
  if (json) console.log(JSON.stringify({ status: "error", message }));
  else console.error(`🏹 ${message}`);
  process.exit(1);
};

function gh(args) {
  try {
    return cp.execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    const stderr = error.stderr?.toString().trim();
    throw new Error(stderr || `gh ${args[0]} failed`);
  }
}

function parseArgs(argv) {
  const options = { timeout: 1800, interval: 10, json: false, rerun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") options.repo = argv[++index];
    else if (arg === "--timeout") options.timeout = Number(argv[++index]);
    else if (arg === "--interval") options.interval = Number(argv[++index]);
    else if (arg === "--json") options.json = true;
    else if (arg === "--rerun") options.rerun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (!options.pr) options.pr = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!Number.isFinite(options.timeout) || options.timeout < 1) throw new Error("--timeout must be a positive number of seconds");
  if (!Number.isFinite(options.interval) || options.interval < 1) throw new Error("--interval must be a positive number of seconds");
  return options;
}

function exactHeadRun(repo, head) {
  const payload = JSON.parse(gh([
    "api",
    `repos/${repo}/commits/${head}/check-runs?check_name=review&per_page=100`,
  ]));
  return payload.check_runs
    .filter((run) => run.name === "review" && run.app?.slug === "github-actions")
    .sort((left, right) => new Date(right.started_at || right.created_at) - new Date(left.started_at || left.created_at))[0];
}

function exactHeadVerdict(repo, number, head) {
  const reviews = JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${number}/reviews?per_page=100`])).flat();
  return reviews
    .filter((review) =>
      review.commit_id === head
      && review.user?.login === "github-actions[bot]"
      && (review.body || "").includes(":bow_and_arrow: Robin")
    )
    .sort((left, right) => new Date(right.submitted_at) - new Date(left.submitted_at))[0];
}

function printResult(options, result) {
  if (options.json) console.log(JSON.stringify(result));
  else {
    console.log(`🏹 PR #${result.pr} @ ${result.head.slice(0, 12)}`);
    console.log(`   check: ${result.check} (${result.runUrl})`);
    console.log(`   verdict: ${result.verdict}`);
  }
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    fail(error.message);
  }
  if (options.help) {
    console.log("Usage: robin-review pr [number|url] [--repo owner/repo] [--rerun] [--timeout seconds] [--interval seconds] [--json]");
    return;
  }

  try {
    const selector = options.pr || "";
    const viewArgs = ["pr", "view"];
    if (selector) viewArgs.push(selector);
    if (options.repo) viewArgs.push("--repo", options.repo);
    viewArgs.push("--json", "number,headRefOid,url");
    const pr = JSON.parse(gh(viewArgs));
    const repo = options.repo || gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
    let run = exactHeadRun(repo, pr.headRefOid);
    if (!run) fail(`No Robin review check exists on exact head ${pr.headRefOid}. Push/open the PR with synchronize reviews enabled first.`, options.json);
    if (options.rerun) {
      gh(["run", "rerun", String(run.id), "--repo", repo]);
      sleep(1000);
    }

    const deadline = Date.now() + options.timeout * 1000;
    do {
      run = exactHeadRun(repo, pr.headRefOid);
      if (run?.status === "completed") break;
      if (Date.now() >= deadline) fail(`Timed out waiting for Robin check on ${pr.headRefOid}.`, options.json);
      sleep(options.interval * 1000);
    } while (true);

    let verdict;
    do {
      verdict = exactHeadVerdict(repo, pr.number, pr.headRefOid);
      if (verdict) break;
      if (Date.now() >= deadline) fail(`Robin check completed without an exact-head review verdict.`, options.json);
      sleep(options.interval * 1000);
    } while (true);

    const result = {
      status: verdict.state === "APPROVED" && run.conclusion === "success" ? "clean" : "blocked",
      repo,
      pr: pr.number,
      head: pr.headRefOid,
      check: run.conclusion,
      runUrl: run.html_url,
      verdict: verdict.state,
      reviewUrl: verdict.html_url,
    };
    printResult(options, result);
    process.exit(result.status === "clean" ? 0 : 2);
  } catch (error) {
    fail(error.message, options.json);
  }
}

module.exports = { exactHeadRun, exactHeadVerdict, main, parseArgs };
