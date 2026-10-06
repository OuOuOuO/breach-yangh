#!/usr/bin/env node
/**
 * ZCode 安装位置探测器（多级动态解析，零硬编码）
 *
 * 设计目标：任何盘符、任何安装方式（安装版 / 便携版 / 自定义目录）都能定位，
 * 且找不到时给出"试过哪些路径"的诊断清单，而不是抛一个写死的路径错误。
 *
 * 解析优先级（从高到低）：
 *   1. 显式传入的 options（CLI 参数 --bundle / --path）
 *   2. 环境变量  ZCODE_BUNDLE  >  ZCODE_ROOT  >  ZCODE_EXE
 *   3. 上次成功定位的记忆文件（~/.breach-zcode-path.json）
 *   4. 运行中的 ZCode 进程
 *   5. 注册表卸载项中的 InstallLocation
 *   6. 桌面 / 开始菜单快捷方式
 *   7. 全部盘符 × 常见目录 嗅探
 *   8. 候选目录内递归浅查 zcode.cjs
 *
 * 本模块只读，不写盘（除记忆文件，且仅在被显式要求时）。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const BUNDLE_REL_CANDIDATES = [
  ["resources", "glm", "zcode.cjs"],
  ["resources", "app", "glm", "zcode.cjs"],
  ["resources", "glm", "zcode.cjs"],
  ["resources", "zcode.cjs"],
  ["glm", "zcode.cjs"],
  ["zcode.cjs"],
];

const MEMORY_FILE = path.join(os.homedir(), ".breach-zcode-path.json");

/** 枚举当前存在的盘符（A:\ ~ Z:\）。 */
export function findDrives() {
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const root = String.fromCharCode(c) + ":\\";
    try {
      if (fs.existsSync(root)) drives.push(root);
    } catch {
      /* 无权限的盘符跳过 */
    }
  }
  return drives;
}

/** 递归查找 bundle（限深度，避免全盘扫描）。 */
function searchBundleUnder(dir, maxDepth = 3, budget = { left: 4000 }) {
  const stack = [{ d: dir, depth: 0 }];
  while (stack.length) {
    if (budget.left-- <= 0) return null;
    const { d, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name.toLowerCase() === "zcode.cjs") return p;
      if (e.isDirectory() && depth < maxDepth) {
        // 跳过明显的无关大目录
        if (["node_modules", ".git", "cache", "logs", "log"].includes(e.name)) continue;
        stack.push({ d: p, depth: depth + 1 });
      }
    }
  }
  return null;
}

/** 由某个可执行文件路径推导 bundle。 */
export function bundleFromExe(exe, tried) {
  const root = path.dirname(exe);
  for (const rel of BUNDLE_REL_CANDIDATES) {
    const p = path.join(root, ...rel);
    tried.push(p);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  // 兜底：在 resources 目录内浅递归
  const resDir = path.join(root, "resources");
  if (fs.existsSync(resDir)) {
    tried.push(`${resDir} (recursive)`);
    const hit = searchBundleUnder(resDir, 3);
    if (hit) return hit;
  }
  return null;
}

/** 从任意一个 bundle 路径推导出安装根（用于反查 exe / home）。 */
export function rootFromBundle(bundle) {
  const parts = bundle.split(/[\\/]/);
  const idx = parts.findIndex((s) => s.toLowerCase() === "resources");
  if (idx > 0) return parts.slice(0, idx).join(path.sep) || path.sep;
  return path.dirname(bundle);
}

function envCandidates() {
  const out = [];
  if (process.env.ZCODE_BUNDLE) out.push({ exe: null, bundle: process.env.ZCODE_BUNDLE, src: "env:ZCODE_BUNDLE" });
  if (process.env.ZCODE_ROOT) {
    for (const rel of BUNDLE_REL_CANDIDATES) {
      out.push({ exe: null, bundle: path.join(process.env.ZCODE_ROOT, ...rel), src: "env:ZCODE_ROOT" });
    }
    out.push({ exe: path.join(process.env.ZCODE_ROOT, "ZCode.exe"), bundle: null, src: "env:ZCODE_ROOT" });
  }
  if (process.env.ZCODE_EXE) out.push({ exe: process.env.ZCODE_EXE, bundle: null, src: "env:ZCODE_EXE" });
  return out;
}

/** 常见安装目录候选：{盘符} × {目录模板}，外加用户级目录。 */
function sniffCandidates(tried) {
  const out = [];
  const dirTemplates = [
    ["ZCode"],
    ["Program Files", "ZCode"],
    ["Program Files (x86)", "ZCode"],
    ["Program Files", "ZCode", "ZCode"],
    ["Apps", "ZCode"],
    ["App", "ZCode"],
    ["Software", "ZCode"],
    ["Tools", "ZCode"],
    ["Programs", "ZCode"],
    ["Applications", "ZCode"],
    ["ZCode", "ZCode"],
  ];

  for (const drive of findDrives()) {
    for (const tpl of dirTemplates) {
      const dir = path.join(drive, ...tpl);
      tried.push(dir);
      if (!fs.existsSync(dir)) continue;
      const exe = path.join(dir, "ZCode.exe");
      if (fs.existsSync(exe)) out.push({ exe, bundle: null, src: `sniff:${dir}` });
      // 便携版可能把 resources 直接放在该目录
      for (const rel of BUNDLE_REL_CANDIDATES) {
        const b = path.join(dir, ...rel);
        if (fs.existsSync(b)) out.push({ exe: null, bundle: b, src: `sniff:${dir}` });
      }
    }
  }

  // 用户级目录（不随盘符变化）
  const userRoots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "ZCode"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "ZCode"),
    process.env.APPDATA && path.join(process.env.APPDATA, "ZCode"),
    process.env.APPDATA && path.join(process.env.APPDATA, "Programs", "ZCode"),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, "ZCode"),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, "Desktop", "ZCode"),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, "scoop", "apps", "zcode", "current"),
  ].filter(Boolean);

  for (const dir of userRoots) {
    tried.push(dir);
    if (!fs.existsSync(dir)) continue;
    const exe = path.join(dir, "ZCode.exe");
    if (fs.existsSync(exe)) out.push({ exe, bundle: null, src: `user:${dir}` });
    for (const rel of BUNDLE_REL_CANDIDATES) {
      const b = path.join(dir, ...rel);
      if (fs.existsSync(b)) out.push({ exe: null, bundle: b, src: `user:${dir}` });
    }
  }

  return out;
}

/** 注册表查询（尽力而为；被策略阻挡时静默跳过）。
 *  某些环境下 reg.exe 会被安全软件（如 360、企业策略）拦截。
 *  如需彻底跳过此来源，设置环境变量 BREACH_NO_REGISTRY=1。 */
function registryCandidates(tried) {
  const out = [];
  if (process.env.BREACH_NO_REGISTRY === "1") {
    tried.push("(registry 已按 BREACH_NO_REGISTRY=1 跳过)");
    return out;
  }
  const roots = [
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  for (const root of roots) {
    let raw;
    try {
      raw = execFileSync("reg", ["query", root, "/s", "/f", "ZCode", "/d"], {
        encoding: "utf8",
        timeout: 8000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/InstallLocation\s+REG_\w+\s+(.+?)\s*$/i);
      if (!m) continue;
      const dir = m[1].replace(/^"|"$/g, "");
      tried.push(`registry:${dir}`);
      const exe = path.join(dir, "ZCode.exe");
      if (fs.existsSync(exe)) out.push({ exe, bundle: null, src: `registry:${dir}` });
      for (const rel of BUNDLE_REL_CANDIDATES) {
        const b = path.join(dir, ...rel);
        if (fs.existsSync(b)) out.push({ exe: null, bundle: b, src: `registry:${dir}` });
      }
    }
  }
  return out;
}

/** 运行中进程查询（尽力而为）。 */
function processCandidates(tried) {
  const out = [];
  let raw;
  try {
    raw = execFileSync("tasklist", ["/FI", "IMAGENAME eq ZCode.exe", "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return out;
  }
  if (!/ZCode\.exe/i.test(raw)) return out;
  // tasklist 不给完整路径；用 wmic 兜底（新系统可能没有）
  try {
    const w = execFileSync("wmic", ["process", "where", "name='ZCode.exe'", "get", "ExecutablePath"], {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of w.split(/\r?\n/)) {
      const p = line.trim();
      if (p && /\.exe$/i.test(p) && fs.existsSync(p)) {
        tried.push(`process:${p}`);
        out.push({ exe: p, bundle: null, src: "process" });
      }
    }
  } catch {
    /* wmic 不可用，跳过 */
  }
  return out;
}

/** 快捷方式解析（.lnk 是二进制，这里只做字符串尾部提取，尽力而为）。 */
function shortcutCandidates(tried) {
  const out = [];
  const lnks = [
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, "Desktop", "ZCode.lnk"),
    process.env.APPDATA && path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "ZCode.lnk"),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, "Desktop", "ZCode.exe"),
  ].filter(Boolean);

  for (const lnk of lnks) {
    tried.push(lnk);
    if (!fs.existsSync(lnk)) continue;
    if (lnk.toLowerCase().endsWith(".exe")) {
      out.push({ exe: lnk, bundle: null, src: "shortcut" });
      continue;
    }
    try {
      const buf = fs.readFileSync(lnk);
      const txt = buf.toString("latin1");
      const m = txt.match(/[A-Za-z]:\\\\?[^\u0000-\u001f"<>|*?]{2,180}?ZCode\.exe/i);
      if (m) {
        const guess = m[0].replace(/\\\\/g, "\\");
        if (fs.existsSync(guess)) out.push({ exe: guess, bundle: null, src: "shortcut" });
      }
    } catch {
      /* 解析失败跳过 */
    }
  }
  return out;
}

/** 读取记忆文件中的上次成功路径。 */
export function loadRemembered() {
  try {
    const raw = fs.readFileSync(MEMORY_FILE, "utf8");
    const j = JSON.parse(raw);
    if (j && typeof j.bundle === "string" && fs.existsSync(j.bundle)) return j;
  } catch {
    /* 无记忆或已失效 */
  }
  return null;
}

/** 记住这次成功的 bundle 路径（供下次直接命中）。 */
export function rememberBundle(bundlePath) {
  try {
    fs.writeFileSync(
      MEMORY_FILE,
      JSON.stringify({ bundle: bundlePath, savedAt: new Date().toISOString() }, null, 2),
      "utf8",
    );
    return MEMORY_FILE;
  } catch {
    return null;
  }
}

/** 默认的 ZCode 配置根（~/.zcode）。 */
export function defaultZcodeHome() {
  return process.env.ZCODE_HOME || path.join(os.homedir(), ".zcode");
}

/**
 * 主入口：解析 ZCode 的 bundle 路径。
 * @param {{bundle?:string, exe?:string, useMemory?:boolean}} options
 * @returns {{bundle:string|null, exe:string|null, home:string, source:string, tried:string[]}}
 */
export function locateZCode(options = {}) {
  const tried = [];
  const warnings = [];
  const home = defaultZcodeHome();
  tried.push(`(home) ${home}`);

  const accept = (entry, srcOverride) => {
    if (!entry) return null;
    if (entry.bundle) {
      if (!fs.existsSync(entry.bundle)) return null;
      const exe = entry.exe || path.join(rootFromBundle(entry.bundle), "ZCode.exe");
      return {
        bundle: entry.bundle,
        exe: fs.existsSync(exe) ? exe : null,
        home,
        source: srcOverride || entry.src,
        tried,
        warnings,
      };
    }
    if (entry.exe) {
      if (!fs.existsSync(entry.exe)) return null;
      const b = bundleFromExe(entry.exe, tried);
      if (!b) return null;
      return { bundle: b, exe: entry.exe, home, source: srcOverride || entry.src, tried, warnings };
    }
    return null;
  };

  // 1. 显式参数（最高优先级）
  //
  // fail-closed 原则：一旦用户显式指定了 --bundle / --path 却解析不到，
  // 立即返回失败，绝不悄悄回退到记忆文件或嗅探出的其它安装 ——
  // 否则补丁会被打到用户没指定的副本上，属于"打错目标"，比报错更危险。
  if (options.bundle) {
    const r = accept({ bundle: options.bundle }, "cli:--bundle");
    if (r) return r;
    tried.push(`(cli:--bundle 无效) ${options.bundle}`);
    return { bundle: null, exe: null, home, source: null, tried, explicitFailed: "cli:--bundle" };
  }
  if (options.exe) {
    const p = options.exe;
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      // 传入的是目录：先直接找 bundle，再找目录下的 ZCode.exe
      for (const rel of BUNDLE_REL_CANDIDATES) {
        const b = path.join(p, ...rel);
        if (fs.existsSync(b)) {
          const r = accept({ bundle: b }, "cli:--path(目录)");
          if (r) return r;
        }
      }
      const exeInDir = path.join(p, "ZCode.exe");
      tried.push(`(cli:--path 目录) ${p}`);
      if (fs.existsSync(exeInDir)) {
        const r = accept({ exe: exeInDir }, "cli:--path(目录)");
        if (r) return r;
      }
      // 最后兜底：在目录内浅递归
      tried.push(`${p} (recursive)`);
      const hit = searchBundleUnder(p, 3);
      if (hit) {
        const r = accept({ bundle: hit }, "cli:--path(递归)");
        if (r) return r;
      }
    } else {
      const r = accept({ exe: p }, "cli:--path");
      if (r) return r;
    }
    tried.push(`(cli:--path 无效) ${p}`);
    return { bundle: null, exe: null, home, source: null, tried, explicitFailed: "cli:--path" };
  }

  // 2. 环境变量
  const envs = envCandidates();
  for (const c of envs) {
    const r = accept(c);
    if (r) {
      if (r.warnings) r.warnings = r.warnings; // 保持引用
      return r;
    }
  }
  if (envs.length > 0) {
    // 环境变量已设置但指向的路径不存在 —— 记入诊断与警告。
    // 注意：环境变量是"持久"设定，若因残留的坏变量直接 fail-closed，
    // 会让自动探测被永久卡死；因此这里回退，但必须显式警告，绝不静默。
    const set = [];
    if (process.env.ZCODE_BUNDLE) set.push(`ZCODE_BUNDLE=${process.env.ZCODE_BUNDLE}`);
    if (process.env.ZCODE_ROOT) set.push(`ZCODE_ROOT=${process.env.ZCODE_ROOT}`);
    if (process.env.ZCODE_EXE) set.push(`ZCODE_EXE=${process.env.ZCODE_EXE}`);
    const msg = `环境变量已设置但路径无效，已忽略：${set.join("  ")}`;
    tried.push(`(${msg})`);
    warnings.push(msg);
  }

  // 3. 记忆文件
  if (options.useMemory !== false) {
    const mem = loadRemembered();
    if (mem) {
      const r = accept({ bundle: mem.bundle }, "memory");
      if (r) return r;
      const msg = `记忆文件中的路径已失效，已忽略：${mem.bundle}`;
      tried.push(`(${msg})`);
      warnings.push(msg);
    }
  }

  // 4. 运行中进程
  for (const c of processCandidates(tried)) {
    const r = accept(c);
    if (r) return r;
  }

  // 5. 注册表
  for (const c of registryCandidates(tried)) {
    const r = accept(c);
    if (r) return r;
  }

  // 6. 快捷方式 + 7. 目录嗅探 —— 合并为一个候选池后再裁决
  //
  // 为什么合并：快捷方式可能已过期（指向被移动/卸载的旧目录），而嗅探命中的
  // 才是真正在用的安装。若让快捷方式单独 return，过期条目会抢占真实结果，
  // 补丁就打到废弃副本上了。同一台机器也可能合法地存在多个副本
  // （例如 D:\zcode 与 D:\ZCode），此时按修改时间取最新，并把全部候选记入
  // tried 供人工确认。
  const pooled = [...shortcutCandidates(tried), ...sniffCandidates(tried)]
    .map((c) => accept(c))
    .filter(Boolean);

  if (pooled.length > 0) {
    // 去重（同一 bundle 可能被多个模板命中）
    const uniq = [];
    const seenBundle = new Set();
    for (const c of pooled) {
      const key = c.bundle.toLowerCase();
      if (seenBundle.has(key)) continue;
      seenBundle.add(key);
      uniq.push(c);
    }
    if (uniq.length === 1) return uniq[0];

    // 多候选：按 mtime 降序，取最新的，并把全部候选记入 tried 供人工确认
    const withTime = uniq.map((c) => {
      let mtime = 0;
      try {
        mtime = fs.statSync(c.bundle).mtimeMs;
      } catch {
        /* ignore */
      }
      return { ...c, mtime };
    });
    withTime.sort((a, b) => b.mtime - a.mtime);
    warnings.push(
      `检测到 ${withTime.length} 个 ZCode 安装，已自动选用最近修改的一个：${withTime[0].bundle}`,
    );
    tried.push(`(注意) 检测到 ${withTime.length} 个 ZCode 安装，已选用最近修改的一个：`);
    for (const c of withTime) {
      tried.push(`  - ${c.bundle}  ${new Date(c.mtime).toISOString()}  [${c.source}]`);
    }
    return {
      ...withTime[0],
      source: `${withTime[0].source} (多安装，选最新)`,
      warnings,
      conflicts: withTime.map((c) => ({ bundle: c.bundle, mtime: c.mtime, source: c.source })),
    };
  }

  return { bundle: null, exe: null, home, source: null, tried, warnings };
}

/** 生成"找不到"时的诊断文本。 */
export function diagnose(result) {
  const lines = [];
  if (result.explicitFailed) {
    lines.push(`你显式指定的 ${result.explicitFailed} 无法解析到 zcode.cjs，已按 fail-closed 原则中止。`);
    lines.push("（不会回退到其它安装，避免把补丁打到非目标副本上。）");
  } else {
    lines.push("未能定位 ZCode 的 bundle 文件（resources/glm/zcode.cjs）。");
  }
  lines.push("");
  lines.push("已尝试的来源与路径：");
  const seen = new Set();
  for (const t of result.tried) {
    if (seen.has(t)) continue;
    seen.add(t);
    lines.push(`  - ${t}`);
  }
  lines.push("");
  lines.push("如何解决（任选其一）：");
  lines.push("  1) 手动指定安装根：  node tools/zcode-patch.mjs find --path \"X:\\你的ZCode目录\"");
  lines.push("  2) 直接指定 bundle： node tools/zcode-patch.mjs find --bundle \"X:\\...\\resources\\glm\\zcode.cjs\"");
  lines.push("  3) 设置环境变量：    set ZCODE_ROOT=X:\\你的ZCode目录");
  lines.push("  4) 若为便携版，把 ZCode.exe 所在目录设为 ZCODE_ROOT 即可。");
  lines.push("");
  lines.push(`配置根（AGENTS.md 目标）：${result.home}`);
  return lines.join("\n");
}

export { MEMORY_FILE };

// ---------------------------------------------------------------- 直接运行时的 CLI
// 供 breach.ps1 / install.ps1 调用：把探测结果以 KEY=VALUE 形式吐出来，
// 让 PowerShell 能读走再通过环境变量传给 node 子进程（修复"探测结果丢失"）。
import { fileURLToPath } from "node:url";
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const argv = process.argv.slice(2);
  let bundle = null;
  let exePath = null;
  let mode = "--print";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--bundle") bundle = argv[++i] ?? null;
    else if (argv[i] === "--path") exePath = argv[++i] ?? null;
    else if (argv[i] === "--print") mode = "--print";
    else if (argv[i] === "--json") mode = "--json";
    else if (argv[i] === "--diagnose") mode = "--diagnose";
    else if (argv[i] === "--remember") mode = "--remember";
  }
  const r = locateZCode({ bundle, exe: exePath });

  if (mode === "--json") {
    console.log(
      JSON.stringify(
        { bundle: r.bundle, exe: r.exe, home: r.home, source: r.source, warnings: r.warnings ?? [] },
        null,
        2,
      ),
    );
  } else if (mode === "--diagnose") {
    if (r.bundle) {
      // 找到了：打印成功路径与来源，并给出多安装冲突提示（若有）
      console.log("== ZCode 路径探测 ==");
      console.log(`bundle   : ${r.bundle}`);
      console.log(`程序     : ${r.exe || "(未找到，不影响补丁)"}`);
      console.log(`配置根   : ${r.home}`);
      console.log(`定位来源 : ${r.source}`);
      if (r.warnings && r.warnings.length) {
        console.log("");
        for (const w of r.warnings) console.log(`警告: ${w}`);
      }
      if (Array.isArray(r.conflicts) && r.conflicts.length > 1) {
        console.log("");
        console.log(`注意：检测到 ${r.conflicts.length} 个 ZCode 安装，当前选用最近修改的一个。`);
        for (const c of r.conflicts) {
          console.log(`  - ${c.bundle}  ${new Date(c.mtime).toISOString()}`);
        }
        console.log("如果选错了，用 --path 显式指定目标安装目录。");
      }
    } else {
      console.log(diagnose(r));
    }
    process.exitCode = r.bundle ? 0 : 4;
  } else {
    // --print：机器可读，供 PowerShell 解析
    console.log(`BUNDLE=${r.bundle ?? ""}`);
    console.log(`EXE=${r.exe ?? ""}`);
    console.log(`HOME=${r.home}`);
    console.log(`SOURCE=${r.source ?? ""}`);
    for (const w of r.warnings ?? []) console.log(`WARN=${w}`);
    if (!r.bundle) {
      // 未找到时把诊断文本按 DIAG= 逐行吐出，PowerShell 可直接展示真实原因
      for (const line of diagnose(r).split(/\r?\n/)) console.log(`DIAG=${line}`);
    }
    if (mode === "--remember" && r.bundle) {
      const f = rememberBundle(r.bundle);
      console.log(`REMEMBERED=${f ?? ""}`);
    }
    if (!r.bundle) process.exitCode = 4;
  }
}