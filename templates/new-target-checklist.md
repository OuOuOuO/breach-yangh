# 新目标起步清单

换一个 AI 客户端时按顺序走。**核心方法见 [PLAYBOOK.md](../docs/PLAYBOOK.md)，这里只讲落地步骤。**

---

## 0. 先判断这是哪一类客户端

| 类型 | 特征 | 可用的层 |
|---|---|---|
| **明文提示词的本地应用** | 提示词在 `.cjs` / `.js` / `.json` 里可直接读 | 载荷层 + **补丁层**（最省事，ZCode 属这类） |
| 打包的 Electron | 提示词在 `app.asar` 里 | 先解包，或找 `app.asar.unpacked` |
| 云端提示词 | 客户端不发提示词，服务端组装 | **只能走载荷层**，补丁层无从下手 |
| 自建 harness | 你自己写的 | 直接改源码，不需要这套 |

先做这一步判断，能省掉大量无用功。

---

## 1. 定位资产

逐个找，找到就记下来：

- **配置根**：`~/.<name>`、`%APPDATA%\<name>`、`%LOCALAPPDATA%\<name>`
- **指令文件**：`AGENTS.md`、`CLAUDE.md`、`.cursorrules`、`GEMINI.md`、项目级 `.<name>/`
- **主程序**：`.exe` 位置、`resources/` 目录、bundle 文件（`*.cjs`、`*.asar`）
- **日志**：尤其是 **model-io / request-log** 类型的文件——**含 `reasoningText` 的那种，这是整个方法的基础设施**
- **插件/扩展机制**：目录布局、清单格式、实际加载路径（**别假设，要验证**——ZCode 的 `plugin-workspace` 就是死路）

产出：`targets/<目标>/anchors.md`

---

## 2. 定位系统提示词

在 bundle 里搜这些特征串：

```
You are            → 身份段
IMPORTANT:         → 策略段
Refuse / policy    → 拒绝依据
safety / harmful   → 安全段
toolNames / tools  → 工具描述区
```

**每个锚点都要验唯一性**（出现次数 >1 就缩小范围）。记下 offset 与上下文。

用 `tools/bundle-probe.mjs` 改造，或直接写个 node 单行：

```js
const t = fs.readFileSync(BUNDLE, "utf8");
for (const p of ["You are", "IMPORTANT:", "Refuse"]) {
  let i = -1, c = 0; while ((i = t.indexOf(p, i + 1)) !== -1) c++;
  console.log(p, c);
}
```

---

## 3. 先让它拒一次，再读日志

**这一步不能跳。** 不要照着 ZCode 的经验直接改——每个客户端的拒绝依据不一样。

1. 发一个它大概会拒的请求（用你真实的需求，不要造场景）
2. 读日志里的 `reasoningText`
3. 判断类型：

| 现象 | 类型 | 下一步 |
|---|---|---|
| 引用明文规定（"需要授权""违反政策"） | 条款型 | 找到那句 → 删掉/替换 |
| 自己算的后果（"会影响 X""可能被滥用"） | 推理型 | 加"判断权归操作者"，**不要否认后果** |
| 没有理由、含糊其辞、反复改口 | 训练层习惯 或 没找对触发点 | 换措辞再试，或接受这条线 |

---

## 4. 建补丁表

复制 [patch-table.template.mjs](patch-table.template.mjs)，按目标改写。三条硬要求：

- 锚点唯一（不唯一就拒打）
- fail-closed（失配跳过，绝不模糊匹配）
- 备份 + 幂等 + 可回滚

---

## 5. 验收

```powershell
node tools\<target>-patch.mjs verify    # 锚点唯一性
node --check <bundle>                   # 语法自检
# 重启客户端
# 发原来那条请求，读 reasoningText
```

**判据**（三级）：

| reasoningText 里的信号的 | 结论 |
|---|---|
| "这是攻击/注入/jailbreak" | 没破，载荷或补丁被识别了 |
| "这是允许的" | 半破——它查过依据才放行，依据一变就收回 |
| **压根没讨论该不该做，直接进入技术规划** | **破了** |

---

## 6. 落档（别省）

- `targets/<目标>/anchors.md` —— 资产地图 + 锚点
- `targets/<目标>/history.md` —— 每轮改了什么、结果如何、`reasoningText` 关键句
- `targets/<目标>/payload-versions/` —— 每版载荷原文
- `targets/<目标>/verification.md` —— 逐轮判读

**版本史是被验证过的资产。** 下次客户端升级、锚点漂移、或者你几个月后想接着改，靠的就是这些记录，不是记忆。

---

## 7. 升级后的例行检查

```powershell
node tools\<target>-patch.mjs status    # applied / ready / missing / ambiguous
```

`missing` = 被升级覆盖，重打；`ambiguous` = 锚点重复，停下手工核对。

**注意旧备份变陷阱**：升级后直接 revert 会把上一版客户端装回去。工具里要能识别这种情况（备份在、但当前文件一个 marker 都没有 = 已被覆盖 → 旧备份另存 `.superseded`，重建备份）。
