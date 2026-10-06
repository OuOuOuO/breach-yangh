#!/usr/bin/env node
/**
 * Relative-link checker for markdown docs.
 *
 * Extracts `[label](target)` links, skips external URLs / anchors / mailto, and
 * verifies that every relative target exists on disk. Reports file:line so you
 * can fix them. Run this after any file move or rename.
 *
 * Usage:
 *   node tools/link-check.mjs [--root <dir>]
 *
 * Exit 0 = all links resolve, 2 = broken links, 1 = bad input.
 * ASCII-only output: Windows PowerShell 5.1 turns UTF-8 console text into mojibake.
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const rootIdx = argv.indexOf("--root");
const ROOT = path.resolve(rootIdx >= 0 ? argv[rootIdx + 1] : process.cwd());

const SKIP_DIRS = new Set(["node_modules", ".git", ".vscode", "__pycache__"]);
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;

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
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      out.push(p);
    }
  }
  return out;
}

const files = walk(ROOT);
const broken = [];
let checked = 0;
let skipped = 0;

for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  const lines = text.split("\n");

  lines.forEach((line, i) => {
    LINK_RE.lastIndex = 0;
    let m;
    while ((m = LINK_RE.exec(line)) !== null) {
      let target = m[1].trim();
      if (!target) continue;
      if (/^(https?:|mailto:|tel:|data:)/i.test(target)) { skipped++; continue; }
      if (target.startsWith("#")) { skipped++; continue; }

      const anchor = target.indexOf("#");
      if (anchor >= 0) target = target.slice(0, anchor);
      if (!target) { skipped++; continue; }

      let decoded = target;
      try { decoded = decodeURIComponent(target); } catch { /* keep raw */ }

      const resolved = path.resolve(path.dirname(file), decoded.split("/").join(path.sep));
      checked++;
      if (!fs.existsSync(resolved)) {
        broken.push({ rel, line: i + 1, target, resolved: path.relative(ROOT, resolved) });
      }
    }
  });
}

console.log(`root   : ${ROOT}`);
console.log(`files  : ${files.length} markdown file(s)`);
console.log(`links  : ${checked} relative checked, ${skipped} external/anchor skipped\n`);

if (broken.length === 0) {
  console.log("OK - every relative link resolves.");
  process.exit(0);
}

console.log("broken links:");
for (const b of broken) {
  console.log(`  ${b.rel}:${b.line}`);
  console.log(`      -> ${b.target}`);
  console.log(`      resolves to: ${b.resolved}`);
}
console.log(`\n${broken.length} broken link(s).`);
process.exit(2);
