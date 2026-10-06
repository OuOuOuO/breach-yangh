#!/usr/bin/env node
/**
 * Pre-publish sanitizer check.
 *
 * Scans a repo tree for machine-specific traces before you push it anywhere:
 * usernames, absolute Windows paths, session ids, local ports, and the path of
 * the working copy itself. Reports file + label + count, and (with --detail)
 * the matching lines so you can fix them.
 *
 * Usage:
 *   node tools/sanitize-check.mjs [--root <dir>] [--detail]
 *
 * Exit code 0 = clean, 2 = traces found, 1 = bad input.
 * ASCII-only output on purpose: Windows PowerShell 5.1 renders UTF-8 console
 * output as mojibake, which would defeat the purpose of the check.
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const rootIdx = argv.indexOf("--root");
const ROOT = path.resolve(rootIdx >= 0 ? argv[rootIdx + 1] : process.cwd());
const DETAIL = argv.includes("--detail");

// label -> pattern. Placeholder forms are deliberately NOT flagged:
// `C:\Users\<user>`, `%USERPROFILE%\.zcode` and `~/.zcode` are generic and safe to publish.
// Keep these patterns machine-generic; do not hardcode your own values here or the
// checker itself becomes a leak.
const RULES = [
  ["windows-user-path", /[A-Za-z]:\\Users\\(?!<|%|\$)[^\\\s]/g],
  ["session-id", /sess_[0-9a-f]{8}/g],
  ["absolute-desktop", /[A-Za-z]:\\Users\\[^\\]+\\Desktop/gi],
  ["localhost-port", /127\.0\.0\.1:\d+/g],
  ["rollout-log-id", /model-io-sess_[0-9a-f]{6}/g],
];

const SKIP_DIRS = new Set(["node_modules", ".git", ".vscode", "__pycache__"]);
// The checker states these patterns in its own rule list, which would otherwise self-report.
const SKIP_FILES = new Set(["tools/sanitize-check.mjs"]);
const TEXT_EXT = /\.(md|mjs|js|cjs|ts|ps1|cmd|bat|sh|json|yml|yaml|txt)$/i;

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, out);
    } else if (e.isFile() && TEXT_EXT.test(e.name)) {
      const rel = path.relative(ROOT, p).split(path.sep).join("/");
      if (SKIP_FILES.has(rel)) continue;
      out.push(p);
    }
  }
  return out;
}

const files = walk(ROOT);
const report = [];
let total = 0;

for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  for (const [label, re] of RULES) {
    const matches = text.match(re);
    if (!matches) continue;
    total += matches.length;
    const lines = [];
    if (DETAIL) {
      text.split("\n").forEach((line, i) => {
        if (new RegExp(re.source, re.flags.replace("g", "")).test(line)) {
          lines.push(`      ${i + 1}: ${line.trim().slice(0, 140)}`);
        }
      });
    }
    report.push({ rel, label, count: matches.length, lines });
  }
}

console.log(`root : ${ROOT}`);
console.log(`files: ${files.length} text files scanned\n`);

if (report.length === 0) {
  console.log("CLEAN - no machine-specific traces found.");
  process.exit(0);
}

console.log("traces found:");
for (const r of report) {
  console.log(`  ${String(r.count).padStart(3)}x  ${r.label.padEnd(20)}  ${r.rel}`);
  for (const l of r.lines) console.log(l);
}
console.log(`\n${total} hit(s) across ${new Set(report.map((r) => r.rel)).size} file(s).`);
console.log("Fix these before publishing. Note: paths that legitimately describe the");
console.log("target software (e.g. its default install dir) are fine to keep if they are");
console.log("generic; your own username and working-copy path are not.");
process.exit(2);
