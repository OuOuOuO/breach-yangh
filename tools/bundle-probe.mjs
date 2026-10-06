#!/usr/bin/env node
/**
 * zcode.cjs bundle probe — search the minified ZCode agent bundle for anchors.
 *
 * Rebuilt from scratch each time ZCode updates: anchors are version-bound.
 * Read-only. Prints offsets plus surrounding context, never whole minified lines.
 *
 * Path resolution is dynamic (no hardcoded drive letter): ZCODE_BUNDLE env >
 * tools/zcode-locate.mjs (process / registry / shortcut / drive sniffing).
 *
 * Usage:
 *   node bundle-probe.mjs <pattern> [<pattern> ...] [--max 3] [--width 180]
 *   node bundle-probe.mjs --list-groups
 *   node bundle-probe.mjs --group permission
 *   node bundle-probe.mjs --path <dir|exe> <pattern>
 */
import fs from "node:fs";
import { locateZCode, diagnose } from "./zcode-locate.mjs";

function takeFlag(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  return argv[i + 1] ?? null;
}

let BUNDLE = process.env.ZCODE_BUNDLE || null;
if (!BUNDLE) {
  const loc = locateZCode({
    bundle: takeFlag(process.argv, "--bundle"),
    exe: takeFlag(process.argv, "--path"),
  });
  BUNDLE = loc.bundle;
  if (!BUNDLE) {
    // 延迟到真正需要时再报错，--list-groups 无需 bundle
    process.env.__BREACH_DIAG = diagnose(loc);
  }
}

const GROUPS = {
  identity: [
    "You are ZCode, an interactive coding agent",
    "You are an interactive ZCode agent",
    "buildCliPrefixSection",
    "# Harness",
  ],
  safety: [
    "IMPORTANT: Assist with authorized security testing",
    "Refuse requests for destructive techniques",
    "Dual-use security tools",
  ],
  permission: [
    "permissionMode",
    "bypassPermissions",
    "dontAsk",
    "acceptEdits",
    "autoEdit",
    "executionPermissionModeSchema",
  ],
  directives: ["AGENTS.md", "customSystemPrompt", "Custom System Prompt", "injectionTarget", "userInstructions"],
  profile: ["agentProfiles", "reservedProfileNames", "subagents", "agentComponents"],
  context: ["injectionTarget:", "cacheHint:", "buildCliPrefixSection", "NodeContextSourceAdapter"],
  plugin: [".zcode-plugin", "plugin.json", "ZCODE_PLUGIN_ROOT", "mcpServers"],
};

function args(argv) {
  const out = { patterns: [], max: 3, width: 180, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max") out.max = Number(argv[++i] ?? 3);
    else if (a === "--width") out.width = Number(argv[++i] ?? 180);
    else if (a === "--list-groups") out.list = true;
    else if (a === "--bundle") i++;           // 已在顶部消费
    else if (a === "--path") i++;             // 已在顶部消费
    else out.patterns.push(a);
  }
  return out;
}

function probe(text, pattern, max, width) {
  const hits = [];
  let i = -1;
  while ((i = text.indexOf(pattern, i + 1)) !== -1 && hits.length < max) {
    hits.push({
      offset: i,
      context: text.slice(Math.max(0, i - width), i + width).replace(/\s+/g, " "),
    });
  }
  return hits;
}

function count(text, pattern) {
  let n = 0;
  let i = -1;
  while ((i = text.indexOf(pattern, i + 1)) !== -1) n++;
  return n;
}

const a = args(process.argv.slice(2));

if (a.list) {
  for (const [name, pats] of Object.entries(GROUPS)) {
    console.log(`\n[${name}]`);
    for (const p of pats) console.log(`  ${p}`);
  }
  console.log("\n用法：node bundle-probe.mjs <pattern...> [--max N] [--width N]");
  console.log("      node bundle-probe.mjs --group permission");
  process.exit(0);
}

const groupFlag = process.argv.indexOf("--group");
let patterns = a.patterns;
if (groupFlag !== -1) {
  const name = process.argv[groupFlag + 1];
  if (!GROUPS[name]) {
    console.error(`未知分组：${name}（可选：${Object.keys(GROUPS).join(", ")}）`);
    process.exit(1);
  }
  patterns = GROUPS[name];
}

if (patterns.length === 0) {
  console.error("至少给一个 pattern，或用 --list-groups 查看预置分组。");
  process.exit(1);
}

if (!BUNDLE) {
  console.error(process.env.__BREACH_DIAG || "未能定位 ZCode bundle。");
  console.error("\n用 --path / --bundle 指定，或设置 ZCODE_BUNDLE 环境变量。");
  process.exit(1);
}

if (!fs.existsSync(BUNDLE)) {
  console.error(`bundle 不存在：${BUNDLE}\n检查路径，或用 tools/zcode-locate.mjs --diagnose 重新探测。`);
  process.exit(1);
}

const text = fs.readFileSync(BUNDLE, "utf8");
console.log(`bundle: ${BUNDLE}`);
console.log(`chars=${text.length} lines=${text.split("\n").length}\n`);

for (const p of patterns) {
  const total = count(text, p);
  const hits = probe(text, p, a.max, a.width);
  console.log(`#### [${p}]  total=${total}  shown=${hits.length}`);
  for (const h of hits) {
    console.log(`   @${h.offset}`);
    console.log(`      ...${h.context}...`);
  }
  console.log("");
}
