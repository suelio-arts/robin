import { chunkDiffByFile, DEFAULT_SKIP_PATH_PATTERNS, filterDiff, matchPathPattern, selectDiffFiles, shouldSkipPath } from "./diff-filter";

describe("matchPathPattern", () => {
  it("matches lockfiles and dist paths", () => {
    expect(matchPathPattern("**/package-lock.json", "frontend/package-lock.json")).toBe(true);
    expect(matchPathPattern("**/dist/**", "dist/index.js")).toBe(true);
    expect(matchPathPattern("**/*.min.js", "public/app.min.js")).toBe(true);
    expect(matchPathPattern("src/**", "src/index.ts")).toBe(true);
  });
});

describe("filterDiff", () => {
  it("selects quoted Git paths by their decoded destination name", () => {
    const quoted = 'diff --git "a/old/caf\\303\\251 name.ts" "b/studio/new/caf\\303\\251 name.ts"\n--- "a/old/caf\\303\\251 name.ts"\n+++ "b/studio/new/caf\\303\\251 name.ts"\n@@ -1 +1 @@\n-old\n+new\n';
    expect(selectDiffFiles(quoted, new Set(["studio/new/café name.ts"]))).toBe(quoted);
    expect(selectDiffFiles(quoted, new Set(["studio/other.ts"]))).toBe("");
  });

  it("removes skipped file hunks from a unified diff", () => {
    const diff = [
      "diff --git a/package-lock.json b/package-lock.json",
      "index 111..222 100644",
      "--- a/package-lock.json",
      "+++ b/package-lock.json",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/src/app.ts b/src/app.ts",
      "index 333..444 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1 @@",
      "-const x = 1;",
      "+const x = 2;",
    ].join("\n");

    const { filtered, removedFiles } = filterDiff(diff);

    expect(removedFiles).toEqual(["package-lock.json"]);
    expect(filtered).toContain("src/app.ts");
    expect(filtered).not.toContain("package-lock.json");
  });

  it("honors extra skip patterns from repo config", () => {
    const diff = [
      "diff --git a/generated/out.ts b/generated/out.ts",
      "index 111..222 100644",
      "--- a/generated/out.ts",
      "+++ b/generated/out.ts",
      "@@ -1 +1 @@",
      "+export {}",
    ].join("\n");

    const { filtered, removedFiles } = filterDiff(diff, ["**/generated/**"]);
    expect(removedFiles).toEqual(["generated/out.ts"]);
    expect(filtered.trim()).toBe("");
  });
});

describe("shouldSkipPath", () => {
  it("combines default and custom patterns", () => {
    expect(shouldSkipPath("yarn.lock", DEFAULT_SKIP_PATH_PATTERNS)).toBe(true);
    expect(shouldSkipPath("src/index.ts", ["**/generated/**"])).toBe(false);
    expect(shouldSkipPath("generated/out.ts", ["**/generated/**"])).toBe(true);
  });

  it("skips common non-JS ecosystem lockfiles by default", () => {
    expect(shouldSkipPath("Cargo.lock", DEFAULT_SKIP_PATH_PATTERNS)).toBe(true);
    expect(shouldSkipPath("crates/foo/Cargo.lock", DEFAULT_SKIP_PATH_PATTERNS)).toBe(true);
    expect(shouldSkipPath("Gemfile.lock", DEFAULT_SKIP_PATH_PATTERNS)).toBe(true);
    expect(shouldSkipPath("poetry.lock", DEFAULT_SKIP_PATH_PATTERNS)).toBe(true);
  });
});

describe("chunkDiffByFile", () => {
  it("keeps later files instead of truncating the whole pull request", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+first\n",
      "diff --git a/b.ts b/b.ts\n+++ b/b.ts\n@@ -0,0 +1 @@\n+second\n",
    ].join("");

    const chunks = chunkDiffByFile(diff, 70);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain("a.ts");
    expect(chunks[1]).toContain("b.ts");
  });

  it("paginates every hunk of an oversized file", () => {
    const diff = [
      "diff --git a/large.ts b/large.ts\n+++ b/large.ts\n",
      "@@ -1 +1 @@\n+first-change\n",
      `@@ -2 +2 @@\n+${"middle".repeat(20)}\n`,
      "@@ -3 +3 @@\n+last-change\n",
    ].join("");

    const chunks = chunkDiffByFile(diff, 100);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
    expect(chunks.join("\n")).toContain("first-change");
    expect(chunks.join("\n")).toContain("last-change");
    expect(chunks.every((chunk) => chunk.startsWith("diff --git a/large.ts b/large.ts"))).toBe(true);
  });

  it("rejects a chunk limit that cannot preserve the complete file header", () => {
    const header = "diff --git a/large.ts b/large.ts\n+++ b/large.ts\n";
    const diff = `${header}@@ -1 +1 @@\n+change\n`;

    expect(() => chunkDiffByFile(diff, header.length)).toThrow(/must exceed.*diff header/);
    const chunks = chunkDiffByFile(diff, header.length + 1);
    expect(chunks).not.toHaveLength(0);
    expect(chunks.every((chunk) => chunk.startsWith(header))).toBe(true);
    expect(chunks.every((chunk) => chunk.length <= header.length + 1)).toBe(true);
    expect(chunks.map((chunk) => chunk.slice(header.length)).join("")).toContain("+change");
  });
});
