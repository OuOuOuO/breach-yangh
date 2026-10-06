# 破甲

让 AI 客户端按操作者意愿行事的工具。已落地目标：**ZCode**。

**模型不是在坚持立场，是在现场找依据。控制它看到的依据，就控制了它的结论。**

- 条款型拒绝（引用明文规定）→ 删掉条款
- 推理型拒绝（自己算出的后果）→ 转移判断权，别说"别管后果"
- 上下文文件（AGENTS.md）必须克制；系统提示词（宿主补丁）可以直白
- 判读只看日志里的 `reasoningText`，不看表面措辞

## 使用

```powershell
powershell -ExecutionPolicy Bypass -File breach.ps1 find      # 只探测安装位置，不写盘
powershell -ExecutionPolicy Bypass -File breach.ps1 install   # 注入：补丁 + 载荷
powershell -ExecutionPolicy Bypass -File breach.ps1 remove    # 彻底还原（逐字节验证过）
powershell -ExecutionPolicy Bypass -File breach.ps1 status    # 查看状态
```

**路径自动适配**：不写死任何盘符。ZCode 装在哪个盘、是安装版还是便携版都能自动定位，  
解析顺序为 CLI 参数 → 环境变量 → 记忆文件 → 运行中进程 → 注册表 → 快捷方式 → 全盘嗅探。  
找不到时会列出"试过哪些路径"，而不是抛一个写死的路径错误。

装在不常见位置时，可显式指定：

```powershell
powershell -ExecutionPolicy Bypass -File breach.ps1 status -Path "E:\Apps\ZCode"
powershell -ExecutionPolicy Bypass -File breach.ps1 status -Bundle "E:\Apps\ZCode\resources\glm\zcode.cjs"
```

## 升级说明（相对初版）

| 项      | 初版                  | 现在                                 |
| ------ | ------------------- | ---------------------------------- |
| 安装路径   | 写死 `D:\zcode`，换盘即报错 | 多级动态探测，任意盘/便携版可用                   |
| 定位结果传递 | 探测成功但结果丢失，补丁打到默认路径  | 探测结果经环境变量传给所有子进程                   |
| 还原校验   | 只比文件长度              | SHA-256 哈希比对，可证明                   |
| 污染备份   | 会把补丁版备份当原始文件"还原回来"  | 前置体检，检出即拒绝并另存证据                    |
| 还原后自证  | 无                   | 回读确认无补丁残留                          |
| 预览     | 无                   | `apply` / `restore` 支持 `--dry-run` |
| 多安装共存  | 无处理                 | 按修改时间选最新，并列出全部候选                   |
| 显式指定无效 | 静默回退到别的安装           | fail-closed 中止，绝不打错目标              |

## 文档

| 文件                                              | 内容                          |
| ----------------------------------------------- | --------------------------- |
| [DISCLAIMER.md](DISCLAIMER.md)                  | **使用前必读**                   |
| [docs/PLAYBOOK.md](docs/PLAYBOOK.md)            | 方法论，可迁移到任何客户端               |
| [docs/ESSENCE.md](docs/ESSENCE.md)              | 破甲的本质                       |
| [docs/techniques.md](docs/techniques.md)        | 手法清单                        |
| [targets/zcode/](targets/zcode/README.md)       | ZCode 目标档案：补丁清单、逐轮实测记录、失败取证 |
| [templates/](templates/new-target-checklist.md) | 换新目标时的起步清单                  |

## 提醒

**本工具只作用于你自己机器上的客户端。下载后请在 24 小时内删除本地副本。** 约束与代价见 [DISCLAIMER.md](DISCLAIMER.md)。
