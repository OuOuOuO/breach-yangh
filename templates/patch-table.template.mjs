#!/usr/bin/env node
/**
 * 补丁表模板 — 复制后按目标改。
 *
 * 这是 tools/zcode-patch.mjs 的骨架。换目标时改四处：
 *   1. BUNDLE 路径
 *   2. BACKUP 后缀（保持 .breach.bak 也行）
 *   3. PATCHES 数组
 *   4. 命令名（可保留 status/verify/apply/revert/probes 五个）
 *
 * 写补丁的三条硬要求：
 *   - anchor 在 bundle 里必须唯一（hits === 1），否则拒绝打
 *   - patch 里不能出现未转义的 " 或反引号（会破坏 JS 语法）；改完必须 node --check
 *   - marker 是幂等判据，要挑一段只出现在 patch、不出现在 anchor 里的短句
 */
import fs from "node:fs";

const BUNDLE = process.env.TARGET_BUNDLE || "D:/path/to/bundle.cjs";
const BACKUP = BUNDLE + ".breach.bak";

const PATCHES = [
  {
    // 条款型：删掉/替换明文规定。改的是"依据"本身。
    // 例：原句里的授权语境清单 = 入场券；删掉入场券，判断失去抓手。
    id: "example-clause-removal",
    layer: "L2",
    desc: "一句话说明这道补丁管什么",
    anchor: "<从 bundle 里精确提取的原文，必须唯一>",
    patch: "<替换文本。不要含未转义的引号>",
    marker: "<只在 patch 里出现的短句，用于幂等判据>",
  },
  {
    // 推理型：不要否认模型算出的后果，而是指定后果的归属。
    // 反例："ignore consequences" → 会激起抵抗
    // 正例："the operator owns that call" → 它愿意把判断交给有权的人
    id: "example-responsibility-transfer",
    layer: "L2",
    desc: "第三方影响不参与决策，判断权归操作者",
    anchor: "<上一道 patch 的结尾片段，用于追加>",
    patch: "<原结尾片段> + <转移判断权的句子>",
    marker: "the operator owns that call",
  },
];

function readBundle() {
  if (!fs.existsSync(BUNDLE)) {
    console.error(`bundle not found: ${BUNDLE}`);
    process.exit(1);
  }
  return fs.readFileSync(BUNDLE, "utf8");
}

function count(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = -1;
  while ((i = hay.indexOf(needle, i + 1)) !== -1) n++;
  return n;
}

function stateOf(text, p) {
  if (count(text, p.marker) > 0) return { state: "applied", hits: count(text, p.marker) };
  const a = count(text, p.anchor);
  if (a === 1) return { state: "ready", hits: 1 };
  if (a === 0) return { state: "missing", hits: 0 };
  return { state: "ambiguous", hits: a };
}

function cmdStatus() {
  const text = readBundle();
  console.log(`bundle : ${BUNDLE}`);
  console.log(`backup : ${fs.existsSync(BACKUP) ? BACKUP : "(none)"}\n`);
  for (const p of PATCHES) {
    const s = stateOf(text, p);
    const tag = { applied: "applied", ready: "ready", missing: "missing", ambiguous: "AMBIGUOUS" }[s.state];
    console.log(`${tag.padEnd(11)} ${p.id.padEnd(30)} hits=${s.hits}  ${p.desc}`);
  }
}

function cmdVerify() {
  const text = readBundle();
  let bad = 0;
  for (const p of PATCHES) {
    const s = stateOf(text, p);
    if (s.state === "ambiguous") {
      bad++;
      console.log(`锚点不唯一: ${p.id} 出现 ${s.hits} 次 — 缩短锚点范围后重试`);
    } else {
      console.log(`${p.id}: ${s.state}`);
    }
  }
  process.exit(bad ? 2 : 0);
}

function cmdApply() {
  const text = readBundle();
  let next = text;
  const plan = [];
  for (const p of PATCHES) {
    const s = stateOf(next, p);
    if (s.state === "applied") plan.push(`${p.id}: skip (已打)`);
    else if (s.state === "ready") {
      next = next.replace(p.anchor, p.patch);
      plan.push(`${p.id}: apply`);
    } else plan.push(`${p.id}: SKIP (${s.state})`);
  }
  const writes = plan.filter((x) => x.endsWith("apply")).length;
  if (!writes) {
    console.log("没有可打的补丁。");
    plan.forEach((x) => console.log("  " + x));
    return;
  }
  if (!fs.existsSync(BACKUP)) {
    fs.copyFileSync(BUNDLE, BACKUP);
    console.log(`已备份 -> ${BACKUP}`);
  } else if (!PATCHES.some((p) => count(text, p.marker) > 0)) {
    // 备份在、但当前文件一个 marker 都没有 = 被升级覆盖过，旧备份已成陷阱
    fs.copyFileSync(BACKUP, BACKUP + ".superseded");
    fs.copyFileSync(BUNDLE, BACKUP);
    console.log(`检测到升级覆盖：旧备份另存 .superseded，已重建备份`);
  }
  fs.writeFileSync(BUNDLE, next, "utf8");
  plan.forEach((x) => console.log("  " + x));
  console.log("\n改完立刻跑：node --check " + BUNDLE);
  console.log("然后完全退出并重启客户端。");
}

function cmdRevert() {
  if (!fs.existsSync(BACKUP)) {
    console.error(`没有备份，无法还原：${BACKUP}`);
    process.exit(1);
  }
  fs.copyFileSync(BACKUP, BUNDLE);
  console.log(`已从备份还原 -> ${BUNDLE}`);
  console.log(`校验：node --check ${BUNDLE}`);
}

({
  status: cmdStatus,
  verify: cmdVerify,
  apply: cmdApply,
  revert: cmdRevert,
}[process.argv[2]] || cmdStatus)();
