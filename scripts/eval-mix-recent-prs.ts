import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import OpenAI from "openai";
import { annotateDiffWithLineNumbers } from "../src/diff-annotate";
import { chunkDiffByFile, splitDiffIntoFiles } from "../src/diff-filter";
import { getReviewPrompt } from "../src/prompts/review-prompts";

type EvalCase = { pr: number; base: string; head: string };

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("OPENAI_API_KEY is required");

const mixRepo = process.env.MIX_REPO || "/Users/rolly/Build/mix/mix-mono";
const output = resolve(process.argv[2] || "eval/mix-recent-prs-results.json");
const manifest = JSON.parse(
  readFileSync(resolve("eval/mix-recent-prs.json"), "utf8")
) as { cases: EvalCase[]; negativeControls: EvalCase[] };
const client = new OpenAI({ apiKey });
const selectedPrs = new Set(
  (process.env.EVAL_PRS || "").split(",").filter(Boolean).map(Number)
);
const selectedHeads = new Set(
  (process.env.EVAL_HEADS || "").split(",").filter(Boolean)
);
const selectedFiles = new Set(
  (process.env.EVAL_FILES || "").split(",").filter(Boolean)
);

async function review(systemPrompt: string, userContent: string) {
  return client.chat.completions.create({
    model: "gpt-5.6-luna",
    reasoning_effort: "high",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  });
}

function fileContext(chunk: string, base: string, head: string): string {
  let remaining = 50000;
  const sections = [];
  for (const file of splitDiffIntoFiles(chunk)) {
    if (remaining <= 0) break;
    const priorVersion = file.path.replace(/-v(\d+)(?=\.[^.]+$)/, (_, value) => `-v${Number(value) - 1}`);
    for (const [label, ref, path] of [
      ["HEAD", head, file.path],
      ["BASE", base, file.path],
      ...(priorVersion === file.path ? [] : [["BASE PREVIOUS VERSION", base, priorVersion]]),
    ]) {
      if (remaining <= 0) break;
      let content: string;
      try {
        content = execFileSync("git", ["show", `${ref}:${path}`], {
          cwd: mixRepo,
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
        });
      } catch {
        continue;
      }
      const budget = Math.min(remaining, 20000);
      const excerpt = content.length <= budget
        ? content
        : `${content.slice(0, Math.floor(budget * 0.75))}\n[... middle omitted ...]\n${content.slice(-Math.floor(budget * 0.25))}`;
      sections.push(`${label} FILE: ${path}\n${excerpt}`);
      remaining -= excerpt.length;
    }
  }
  return sections.join("\n\n");
}

function focusedContext(context: string): string {
  const lines = context.split("\n");
  const selected = new Set<number>();
  const pattern = /setRuntime|errorLabel|split\(|parts\[0\]|UserDefaults|qualifiedAt|make_client|assert-autopilot|localization|create_version|pending|mirrored/i;
  lines.forEach((line, index) => {
    if (!pattern.test(line)) return;
    for (let nearby = Math.max(0, index - 4); nearby <= Math.min(lines.length - 1, index + 4); nearby += 1) {
      selected.add(nearby);
    }
  });
  return [...selected].sort((left, right) => left - right).map((index) => lines[index]).join("\n").slice(0, 20000);
}

async function main() {
  const results = [];
  for (const testCase of [...manifest.cases, ...manifest.negativeControls].filter(
    (candidate) =>
      (selectedPrs.size === 0 || selectedPrs.has(candidate.pr))
      && (selectedHeads.size === 0 || selectedHeads.has(candidate.head))
  )) {
    const diff = execFileSync(
      "git",
      ["diff", "--no-ext-diff", "--unified=3", testCase.base, testCase.head],
      { cwd: mixRepo, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
    );
    const reviewChunks = splitDiffIntoFiles(diff)
      .filter(({ path }) => selectedFiles.size === 0 || selectedFiles.has(path))
      .flatMap(({ content }) => chunkDiffByFile(content, 50000));
    const responses = [];
    console.log(`PR ${testCase.pr}: ${reviewChunks.length} chunk(s)`);
    for (const [index, chunk] of reviewChunks.entries()) {
      console.log(`PR ${testCase.pr}: reviewing chunk ${index + 1}/${reviewChunks.length}`);
      const context = fileContext(chunk, testCase.base, testCase.head);
      const reviewInput = [
        "Review this file-aware chunk from a historical pull request.",
        "Return only the strict JSON object described in the system prompt.",
        "Each line is prefixed with its NEW-file line number.",
        "```diff",
        annotateDiffWithLineNumbers(chunk),
        "```",
        "UNCHANGED HEAD-FILE CONTEXT (evidence only; never anchor a comment here):",
        "```",
        context,
        "```",
        "FOCUSED CONTRACT EVIDENCE:",
        "```",
        focusedContext(context),
        "```",
      ].join("\n");
      const discoveryPrompts = [
        "Audit only inputs, parsing, validation, authorization, identity, roles, and route dispatch. Trace every changed boundary end to end. For each credential/client construction, prove the complete route and arguments are validated first. For each unattended privileged CLI invocation, prove the canonical machine identity and role are asserted first.",
        "Audit only lifecycle and mutable state across success, failure, retry, duplicate callback, concurrency, cancellation, relaunch, and corrupt persisted data. Map UI state-setter arguments to their destination elements so failure text reaches the error surface. Treat an async read-modify-write of an entire persisted collection as unsafe unless the whole operation is serialized or atomic.",
        "Audit only external API and persistence contracts: exact fields, masks, units, currency, mutation targets, partial success, idempotency, readback, and recovery.",
        "Audit only build/platform compatibility and changed tests. Report a test only when its assertion can pass while the intended changed behavior is broken.",
        "Run the MIX regression checklist only: map failure text to the error element rather than status; reject valueless options coerced to true; check persisted-string split before index zero; detect whole-collection read-modify-write races; skip already-stamped qualification scans; enforce autopilot assertions and validation-before-client; verify field-mask casing and currency; and ensure a remote create followed by child creates can resume after any child failure.",
      ];
      discoveryPrompts.push(discoveryPrompts.at(-1)!, discoveryPrompts.at(-1)!);
      const discovery = await Promise.all(discoveryPrompts.map((instructions) =>
        review(getReviewPrompt(instructions), reviewInput)
      ));
      const candidates = discovery.map((candidate) =>
        JSON.parse(candidate.choices[0]?.message.content || "{}")
      );
      const verification = await review(getReviewPrompt([
        "This is the final evidence-verification pass.",
        "Do not add findings. Keep only candidates whose exact trigger, introduced changed line, failing path, and material impact are directly proven by the diff.",
        "Remove pre-existing behavior, explicit product behavior, unseen-caller assumptions, standalone test gaps, style, and speculative concerns.",
        "Keep directly evidenced async read-modify-write races where concurrent snapshots can overwrite one another.",
        "Keep directly evidenced violations of the repository contracts in the system prompt, including authenticated client construction before complete route validation.",
        "Keep partial-operation findings when an earlier remote resource is committed, a later changed operation can concretely fail, and retry rejects or cannot resume that resource.",
        "Reject a candidate unless the changed input path can reach it through an actual caller shown in context. Reject arbitrary internal-helper arguments, absurd provider-limit inputs, wrong pinned assets, unsupported build targets, and concurrency when the real caller serializes the method.",
        "Reject behavior copied unchanged from a previous version, missing optional configurations not used by this repository, external transient/server-contract hypotheticals, and retry-policy requests without a repository contract.",
        "When the same root cause appears independently in at least two candidate objects, keep it unless the supplied code directly disproves it.",
      ].join("\n")), [
        reviewInput,
        "CANDIDATE FINDINGS:",
        JSON.stringify(candidates),
      ].join("\n\n"));
      const consensus = await review(getReviewPrompt([
        "This is a consensus-only pass. Do not add findings.",
        "Keep a root cause only when it appears independently in at least two candidate objects and the supplied code does not directly disprove it.",
        "Repeated concrete persisted-index crashes and whole-collection read-modify-write races must be preserved.",
      ].join("\n")), [reviewInput, "CANDIDATE FINDINGS:", JSON.stringify(candidates)].join("\n\n"));
      const verified = JSON.parse(verification.choices[0]?.message.content || "{}");
      const agreed = JSON.parse(consensus.choices[0]?.message.content || "{}");
      for (const severity of ["high", "medium", "low", "suggestions"]) {
        verified[severity] = [...(verified[severity] || []), ...(agreed[severity] || [])];
      }
      responses.push({
        candidates,
        response: verified,
        usage: [...discovery.map(({ usage }) => usage), verification.usage, consensus.usage],
      });
    }
    results.push({
      pr: testCase.pr,
      head: testCase.head,
      chunks: responses,
    });
    writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`);
  }
  writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`Wrote ${results.length} Luna-high reviews to ${output}`);
}

main();
