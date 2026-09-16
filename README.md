# dsh-git-panel

![dsh-git-panel：会话页里多出一个 Git 页；左侧是未暂存 / 已暂存的改动，右侧是带行级操作条（暂存 / 丢弃）的 diff 预览](docs/git-panel.png)

DSH Web GUI 的 **Git 面板**插件：在会话界面的标签栏里，紧挨「对话 / 轨迹」再加一个 **Git** 页，
用来完成日常的查看改动、暂存、提交、看 diff、翻历史、切分支和推拉。

- 仓库：<https://github.com/fengbinmov/dsh-git-panel>（仓库根即 npm 包根）· npm：`@fengbinmov/dsh-git-panel`
- 形态：一个自包含的 DSH profile bundle —— 宿主半（`exports "."`）+ 浏览器半（`exports "./client"`）
- 依赖：`dsh >= 0.1.5-rc.1`、Node `^22.19.0 || >=24.0.0`、`react ^18.2.0`（peer）
- 边界：所有 git 操作都由**界面触发**；插件不注册任何工具、不写 system prompt，模型可见面上看不到它

```text
┌─ 会话页 ────────────────────────────────────────────────┐
│  对话 │ 轨迹 │ Git          ← conversation.view 槽位       │
├─────────────────────────────────────────────────────────┤
│  更改 │ 历史               ← 面板内部的两个标签页          │
│  ┌───────────────┬──────────────────────────────────┐    │
│  │ 未暂存的更改   │                                  │    │
│  │ 已暂存的更改   │           预览 / 提交详情          │    │
│  ├───────────────┤                                  │    │
│  │ 提交信息 [提交]│                                  │    │
│  └───────────────┴──────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

## 目录

- [功能](#功能)
- [数据流与性能](#数据流与性能)
- [HTTP 接口](#http-接口)
- [安全模型](#安全模型)
- [目录结构](#目录结构)
- [安装与启用](#安装与启用)
- [开发](#开发)
- [已知限制与设计取舍](#已知限制与设计取舍)

## 功能

### 更改页（Changes）

- **两个区域**：上方「未暂存的更改」、下方「已暂存的更改」。一个文件同时有两侧改动时会两边都出现
  （`AM` 这类状态两侧各一行，各自带自己那一侧的增删行数）。
- **拖拽即操作**：把行从一个区域拖到另一个区域就是暂存 / 取消暂存；拖动组标题可以整组移动。
  `Ctrl` 点击多选、`Shift` 点击范围选择。
- **行内没有按钮**：列表保持干净，动作全部通过拖拽和键盘完成。
- **`Delete` 键**：未暂存行 = 丢弃改动（**立即执行，无二次确认**）；已暂存行 = 取消暂存。
- **底部提交框**：提交信息输入框 + **右对齐**的提交按钮。界面上没有 amend 勾选（宿主侧仍保留该能力）。
- **行级操作**：在**左侧行号栏**按下并拖动，可选中若干行，浮出操作条（暂存 / 取消暂存 / 丢弃）——
  客户端会用被选中的行重建一个补丁片段交给宿主。在**代码文字上**拖动则完全是浏览器原生的划词选择，
  两个手势互不干扰。

### 预览（diff 渲染器）

- 左右行号 + 标记列 + 补丁体，等宽字体；更改页和历史页**共用同一个渲染器**，不存在两套样式。
- 二进制文件、被截断的补丁、重命名、文件头等都有明确提示，不会把二进制内容伪装成文本。
- 预览头部显示的增删行数与左侧列表行**取自同一份数据**，两者不可能对不上。

### 历史页（History）

- **三栏**：提交列表 / 该提交包含的文件 / 选中文件的补丁。分隔条可拖动、双击复位，
  且与更改页的分隔条位置对齐、可以互相拖回。

### 分支与远端

- 工具栏显示当前分支、上游、ahead/behind 计数；下拉菜单切换本地分支，或在菜单里对某个分支执行
  `merge` / `rebase`。
- 有未解决冲突或已有进行中的操作时，切换/合并会被拦住并给出可读原因，而不是丢一个退出码。
- 一旦检测到进行中的 merge/rebase（`.git` 里的操作标记文件），面板顶部会出现一条警告条，
  带一个「中止」按钮（`abort`）。
- `fetch` / `pull` / `push`；当前分支没有上游时，推送自动带 `--set-upstream origin <branch>`。

### 实时刷新

- `/gitpanel/events`（SSE）：分支、HEAD 或文件摘要（一个 spawn 的 digest）变化时通知浏览器重新拉取。
- 浏览器侧**跨标签页只开一条 EventSource**（Web Locks 选 leader + BroadcastChannel 转发）。
  Chrome 对同源 HTTP/1.1 连接池有 6 条上限且跨标签页共享，每个标签页各开一条流会把普通请求全部排队。

### 乐观 UI

面板里每个动作都是「先在本地动，再等 git 答复」：

1. 点击/拖拽的**同一帧**内，用预测函数改出新的视图（行移动、行数变化、区域计数变化）；
2. 宿主答复到达后（通常几百毫秒）用真实结果替换；
3. 失败则回滚到真实状态并给出错误提示（行级操作失败会额外保留错误通知）。

预测全是 `core/types.ts` 里的纯函数：`predictStaged` / `predictDiscarded` / `predictCommitted` /
`predictLineSelection`，都有单测覆盖。

## 数据流与性能

### 一次列表请求带回一切

打开 Git 页只发 **1 个请求**。`/gitpanel/status-files` 在宿主侧用**一波 3 个 git 进程**同时拿到：

| 内容 | 命令 |
|---|---|
| 文件列表 + 分支 + 上游 + ahead/behind | `status --porcelain=v2 -z --branch` |
| 工作区侧的每文件行数与补丁 | `diff --numstat -z --no-renames -p` |
| 索引侧的每文件行数与补丁 | 同上 + `--cached` |

两侧补丁随列表一起送到浏览器（每侧上限 400k 字符，超出标记 `truncated`），
所以**点开一个已跟踪文件是 0 个请求、0 个 git 进程、0 帧等待** —— 直接从批量结果里做一次字符串扫描。
只有三种情况回退到单文件 `/gitpanel/diff`：未跟踪文件（`git diff` 对它们无输出）、
批量补丁里找不到该文件的区段、以及补丁被上限截断后缺失的最后一个区段。

### 本机热态实测

| 场景 | 结果 |
|---|---|
| `git rev-parse --show-toplevel` 单次 | ~56 ms |
| `status-files`（3 进程一波） | ~89 ms（优化前 7 进程 ~177 ms） |
| 打开 Git 页（首屏） | 1 请求 / 3 进程 / ~82 ms，并有预热缓存让首次打开也能直接画 |
| 点击一个已跟踪文件 | 0 请求 / 0 进程 |
| 点击未跟踪文件（回退路径） | 1 请求 / 1 进程 / ~61 ms |

（以上为本机测量值，用作回归基线；换机器/换仓库会有差异。）

另外宿主侧还做了：仓库根解析结果缓存 60 s、远端列表随状态一起带回、分支/HEAD 摘要用单进程 digest、
`useSlowFlag` 让「加载中」只在真的慢时才出现（避免快速宿主上闪一下提示）。

## HTTP 接口

全部注册在共享 webServer 上：`/gitpanel` 前缀（JSON 操作）+ `/gitpanel/events`（SSE）。

**约定**

- 所有 JSON 操作都是 `POST`，请求体是 JSON，响应是 `200` + 信封：
  - 成功 `{ "ok": true, "value": ... }`
  - 失败 `{ "ok": false, "error": { "code": "...", "message": "..." } }`
- 业务错误也用 HTTP `200` 返回，靠 `code` 区分；客户端**按 `code` 映射本地化文案**，不直接显示宿主英文。
- 请求体上限 1 MB（`application/json` 之外的内容类型一律 `415`，见「安全模型」）。

| 路径 | 请求体 | 作用 |
|---|---|---|
| `/gitpanel/status-files` | `{ path }` | 文件列表 + 分支/上游/ahead-behind/remotes + 两侧行数与补丁 |
| `/gitpanel/branches` | `{ path }` | 本地分支列表（含当前分支） |
| `/gitpanel/switch` | `{ path, branch }` | 切换分支 |
| `/gitpanel/diff` | `{ path, file, staged }` | 单文件补丁（未跟踪 / 区段缺失 / 被上限截断时的回退路径） |
| `/gitpanel/stage` | `{ path, paths[] }` | 暂存 |
| `/gitpanel/unstage` | `{ path, paths[] }` | 取消暂存（不动工作区） |
| `/gitpanel/discard` | `{ path, paths[] }` | 丢弃改动（未跟踪文件走 clean 分支） |
| `/gitpanel/apply-selection` | `{ path, file, direction, fragment }` | 行级操作：客户端重建的补丁片段，`direction` 为 `stage`/`unstage`/`discard` |
| `/gitpanel/commit` | `{ path, message, amend? }` | 提交（`amend` 宿主侧支持，界面目前不传） |
| `/gitpanel/history` | `{ path, limit?, skip? }` | 提交分页（`limit` 夹到 1–500，`skip` 夹到 0–100000） |
| `/gitpanel/commit-detail` | `{ path, oid }` | 单个提交的文件与补丁 |
| `/gitpanel/remote` | `{ path }` | 分支/上游/ahead-behind/remote 行 |
| `/gitpanel/fetch` · `/pull` · `/push` | `{ path }` | 远端操作（超时 120 s） |
| `/gitpanel/merge` · `/rebase` | `{ path, branch }` | 合并 / 变基 |
| `/gitpanel/abort` | `{ path }` | 中止进行中的 merge/rebase |
| `/gitpanel/events` | — | SSE：分支/HEAD/文件摘要变化时推送（30 s 轮询、15 s 心跳） |

行级操作的安全链路：

```text
客户端按已解析的行重建片段
      ↓ POST /gitpanel/apply-selection
宿主 selectionFragmentError() 严格校验（只允许它声称的那一个文件、拒绝重命名/二进制/删除）
      ↓ 写临时补丁文件（tmpdir + randomUUID）
git apply --recount --whitespace=nowarn [--cached] -- <patchfile>
      ↓ finally 删除临时文件
```

子进程层 `stdin` 被设为 `ignore`（凭据提示无法回答），所以补丁只能走临时文件，不能走管道。

## 安全模型

| 关卡 | 规则 |
|---|---|
| 信任栅栏 | 只允许 loopback 请求；若加载了 remote-web-ui 且有有效的已配对设备 cookie，则额外放行。否则 `403` |
| CSRF | 只接受 `POST` + `Content-Type: application/json`（跨站表单无法在不触发预检的情况下设置该类型）；否则 `405`/`415` |
| 工作区闸门 | 请求路径先 `realpath`，必须**等于某个已注册工作区**，否则 `workspace-unknown`。浏览器无法让宿主动任意目录 |
| 路径 | `isSafeRepoPath` 拒绝绝对路径、盘符、`..` 越界；破坏性命令一律带 `--` 分隔符 |
| 行片段 | 客户端提交的补丁片段在宿主侧二次校验（见上）；校验不过不会到达 git |
| 引用 | 分支名过 `git check-ref-format`，且不接受以 `-` 开头（防止被当成 git 选项） |
| 仓库操作 | 进行中操作 / 冲突 / 分支已在其他 worktree 检出，都在门禁阶段拦下 |
| 模型可见面 | 不注册工具、不写 system prompt；对宿主的唯一接触面就是 webServer 路由 |

所有输出路径的命令都带 `-c core.quotePath=false`，避免非 ASCII 路径被 git 转义成八进制。

## 目录结构

仓库根就是 npm 包根：`package.json`、`cordis.patch.yml`、`tsdown.config.ts`、`tsdown.prepare.config.ts`、
`tsconfig*.json`、`vitest.config.ts`、`src/`、`tests/`、`docs/`（README 里的截图）都在根下；`lib/` 是构建产物，由 `pnpm build` 生成、不入库。

```text
src/
├─ index.ts                宿主半入口：工作区闸门 + 挂载服务与路由（mountOnce 保证单实例）
├─ mount-once.ts           同一包的第二个宿主实例变成 no-op（避免重复注册路由导致启动失败）
├─ core/                   两侧共享的纯逻辑，无 IO
│  ├─ types.ts             线上词汇表：视图类型、解析器、守卫、乐观预测函数
│  └─ git-command.ts       命令词汇表：argv 构造器（含 -- 分隔与 core.quotePath=false）
├─ host/                   宿主半：只在 Node 里跑
│  ├─ git-service.ts       工作区维度的 git 服务（每个动词的编排、门禁、缓存）
│  ├─ routes.ts            /gitpanel/* 路由 + SSE 流
│  ├─ git-runner.ts        子进程封印（spawn 规格、输出上限、degrade 模式）
│  ├─ access.ts            信任栅栏（loopback / 已配对设备）
│  ├─ loopback.ts          共享的 loopback 判定
│  ├─ pair-access.ts       共享的配对判定
│  ├─ http.ts              JSON 读体 / 写响应
│  └─ poll-guard.ts        单飞（in-flight）守卫，避免重叠轮询
└─ client/                 浏览器半：只依赖注入的动词，自己不懂 git
   ├─ index.ts             注册 conversation.view（id: git-panel, order: 20）+ 注入动词 + 预热
   ├─ api.ts               /gitpanel/* 的类型化客户端
   ├─ locales.ts           git-panel 命名空间的中英文案
   ├─ error-copy.ts        错误 code → 本地化文案
   ├─ sse-leader.ts        跨标签页共用一条 SSE（Web Locks + BroadcastChannel）
   └─ git/
      ├─ GitView.tsx       视图外壳：标签页、工具栏、两个页签、分隔条、通知
      ├─ ChangesPanel.tsx  两个区域 + 拖拽 / 多选 / 快捷键 + 提交框
      ├─ HistoryPanel.tsx  提交列表（分页）
      ├─ CommitReview.tsx  三栏提交审查
      ├─ DetailPane.tsx    预览容器（头部计数 + 加载态）
      ├─ DiffFileView.tsx  唯一的 diff 渲染器 + 行选择
      ├─ BranchMenu.tsx    分支列表与切换 / merge / rebase
      ├─ diff-parse.ts     补丁拆分、按文件分区、片段重建
      ├─ helpers.ts        徽标、行数、相对时间、拖放规则等展示辅助
      ├─ pane-split.ts     更改页与历史页各自记住的分隔条比例（scope: changes / review）
      ├─ panel-cache.ts    模块级面板缓存（重新打开标签页时立刻有内容）
      ├─ ui.tsx            分支菜单的点击外部关闭遮罩
      └─ git.module.css    CSS Modules（lightningcss）
```

## 安装与启用

插件以 **profile bundle** 的形式挂载：宿主半随 profile 启动，浏览器半由 client-modules
按 `package.json` 的 `dsh.client` 声明提供给 GUI。

### 方式一：从 npm 安装（推荐）

```powershell
# 需要 dsh >= 0.1.5-rc.1、Node ^22.19.0 || >=24.0.0
dsh plugin --profile web add @fengbinmov/dsh-git-panel@latest

# 重启 dsh web
```

包内已带构建产物（`lib/index.js` 宿主半 + `lib/client.js` 浏览器半），**装完不需要本地编译**。

### 方式二：克隆仓库后 link:（开发调试）

```powershell
# 1) 克隆并构建（仓库根即包根）
git clone https://github.com/fengbinmov/dsh-git-panel.git
cd dsh-git-panel
pnpm install
pnpm build            # tsc -b && tsdown → lib/index.js（宿主）+ lib/client.js（浏览器）

# 2) 注册进 profile（link: 指向克隆目录，改完代码重建即可生效）
dsh plugin --profile web add link:<克隆目录的绝对路径>

# 3) 重启 dsh web
```

登记后 `~/.dsh/profiles/web/package.json` 会长出两处（这是实际生效的写法）：

```jsonc
{
  "dependencies": { "@fengbinmov/dsh-git-panel": "link:<克隆目录的绝对路径>" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "...", "@fengbinmov/dsh-git-panel"] } }
}
```

卸载：

```powershell
dsh plugin --profile web remove @fengbinmov/dsh-git-panel
```

**生效范围**

| 改动位置 | 需要做什么 |
|---|---|
| `lib/client.js`（`src/client/**`） | 刷新页面即可（浏览器半由 client-modules 现取现发） |
| `lib/index.js`（`src/host/**`、`src/core/**`） | **重启 `dsh web`** —— 路由与服务在宿主进程里 |

改了源码别忘了 `pnpm build`：`link:` 方式下 profile 直接读这个包的 `lib/`，不会自动编译。

## 开发

克隆后先 `pnpm install`（Node `^22.19.0 || >=24.0.0`；`packageManager` 固定为 pnpm 11.7.0）：

```powershell
pnpm typecheck   # tsc -b --pretty false
pnpm test        # vitest run
pnpm build       # tsc -b && tsdown
```

测试用真实 git 二进制在临时仓库里跑（不是 mock）：

| 测试文件 | 用例 | 覆盖 |
|---|---|---|
| `git-service.spec.ts` | 35 | 真实仓库上的服务动词：状态、分支切换、暂存/提交/丢弃、diff、历史、远端（本地 bare remote）、merge/rebase 冲突、SSE 摘要、路径与工作区闸门 |
| `types.spec.ts` | 41 | 线上词汇表：porcelain v2 解析、补丁拆分数行、装饰解析、乐观预测函数 |
| `group-split.spec.ts` | 21 | 文件如何分到两个区域（含 `AM` 双侧、冲突、未跟踪） |
| `changes-groups.spec.tsx` | 18 | 更改页渲染与拖拽规则 |
| `git-command.spec.ts` | 13 | argv 构造器（破坏性命令的 `--`、安全校验） |
| `drop-rules.spec.ts` | 11 | 放置目标与命中规则 |
| `diff-parse.spec.ts` | 10 | 补丁分区与片段重建 |
| `selection-stage.spec.ts` | 9 | 行级暂存/取消暂存/丢弃打**真实 git**，含 3 个拒绝分支 |
| `line-selection.spec.tsx` | 7 | 行选择手势（含「在文字上拖动不产生行选择」） |
| `diff-preview.spec.tsx` | 5 | 预览渲染（二进制、截断、空态） |
| `access.spec.ts` | 4 | 信任栅栏 |
| **合计** | **174** | **11 个文件** |

**代码约定**

- 注释写「为什么」，不写「是什么」；每个模块顶部有一段模块级说明。
- 客户端 CSS 用 CSS Modules（lightningcss 编译，类名带 hash）；属性选择器（`[data-gitgraph-*]`、
  `[data-diff-gutter]` 这类）不参与作用域，是外部自动化（布局/交互检查）依赖的稳定契约，改名要当心。
- i18n 命名空间固定为 `git-panel`，中英文字典必须键一致（新增 key 两处都要加）。
- 乐观预测必须是纯函数并带单测：宿主答复到达前界面就靠它们。
- 客户端组件只吃注入的动词，不直接 `fetch`，也不 `import` 任何 git 相关实现。

**发布到 npm（维护者）**

```powershell
cd <仓库根>
npm login                              # 首次；npm 账号名或组织名必须就是 @fengbinmov 这个 scope
npm pack --dry-run                     # 先看一眼 tarball：lib/index.js + lib/client.js + lib/types/** + cordis.patch.yml
npm publish                            # publishConfig.access=public；会先跑 prepublishOnly（typecheck + test + build）
npm view @fengbinmov/dsh-git-panel version   # 校验 registry 上的版本
```

后续版本先 `npm version patch --no-git-tag-version` 再 `npm publish`：npm 不允许重发同一版本号。

`lib/` 不进版本库（`.gitignore`）：打包时 `prepublishOnly` 会重建，从 git 安装时 `prepare` 会重建；`npm pack`
按 `files` 白名单带上它，所以忽略 `lib/` 不影响 tarball 内容。先把代码推上仓库，发布成功后再打对齐版本的 tag：

```powershell
git add -A && git commit -m "feat: ..."
git push -u origin HEAD
npm publish
git tag v0.1.0 && git push origin v0.1.0
```

包名（`package.json` 的 `name`）、浏览器半的 bundle id（`tsdown.config.ts` 的 `clientBundle` 首个参数）
和 profile 行名（`cordis.patch.yml`）必须是同一个字符串，改名要三处一起改。

## 已知限制与设计取舍

- **没有标签页**：标签管理（列表/新建/删除）曾实现过，后按需求整体移除；宿主侧的 `tag: ` 装饰处理仍保留，
  所以历史页的提交上如果带 tag，仍会作为 ref 正常显示。
- **行级丢弃不二次确认**（与整文件丢弃一致）：追求操作速度，未做确认步骤。
- **补丁上限**：`status-files` 每侧补丁 400k 字符、单文件 diff 同样截断；超出后由预览提示「已截断」。
  单个 git 进程的 stdout/stderr 上限为 1 MiB。
- **远端操作超时 120 s**（`fetch`/`pull`/`push`），`status-files` 超时 15 s；超时按失败提示，不会一直转圈。
- **列表未虚拟化**：大仓库（数千文件）滚动仍是全量渲染；`content-visibility` 曾被评估并否决，
  因为它会破坏预览区依赖的 `min-width: max-content` 横向滚动。
- **一次只服务当前会话的工作区**：每个会话按自己的 cwd 解析工作区，面板不会跨工作区操作。
