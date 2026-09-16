# Pi Memory Hindsight

为 Pi 提供跨 Session 的长期记忆，使用 Hindsight 保存正式记忆正文，并使用本地 SQLite 管理记忆 ID、候选、状态和并发安全。

本文只讲三件事：

1. 命令怎么用；
2. 不使用命令时，自动记忆怎么工作；
3. 插件怎么安装和配置。

**典型流程（简版）：**

1. 每次对话 settled 后，插件**在合适时**自动尝试提取 Candidate，写入本地 SQLite（不是每一轮都会产生 Candidate）。
2. 用 `/memory candidates` 审阅、批准或拒绝 Candidate；批准后才会写入 Hindsight 正式记忆。
3. 若你明确想记住某条内容，用 `/memory remember ...` 或自然语言让 Pi 调用 `memory_remember`，这是直接写入正式记忆的路径。

> 当前版本适配 Pi `0.85.1`、Hindsight API `0.8.3`，需要 Node.js `>=22.19.0`。当前实现已通过 353 项自动化测试、打包后的隔离 Pi 验收、一次性 Bank 的真实 Hindsight 0.8.3 验收，以及真实 Pi 中临时 Memory 的创建、查看、同 ID 更新和精确删除测试。

---

# 第一部分：命令怎么用

所有 `/memory` 命令都应在交互式 Pi TUI 中使用。

## 查看全部命令：`/memory help`

```text
/memory help
```

或直接输入：

```text
/memory
```

用途：

- 按功能分组列出全部受支持的 `/memory` 命令，并用通俗语言解释每条命令；
- 跟随已保存的 Memory 界面语言（`zh` 或 `en`），但只读取本进程已经成功缓存的本地 runtime；尚未初始化时回退英文，且不会因此创建 SQLite 或 Profile；
- 未知命令或错误参数会以错误提示显示同一份详细帮助；
- Hindsight 不可用时仍可查看，且不会读写 Hindsight，也不会改写 SQLite 记忆数据。

帮助会说明 Profile 类型 `preference|habit`、Project 类型 `project_fact|decision|lesson|task_state|inference`，以及 `cleanup now` 与 `reflect` 需要确认。Reflect 支持 `/memory reflect profile <query>` 和 `/memory reflect project <query>`。没有手动 `/memory extract` 命令；候选仅由 settled 后的自动提取产生。

## 1. 查看状态

```text
/memory status
```

用途：

- 检查插件是否正常加载；
- 检查 Hindsight 是否可用；
- 查看当前 Session 是否开启自动记忆；
- 查看当前目录是否启用了 Project Memory。

示例输出：

```text
Memory: enabled. Profile bank ready.
This session: automatic recall/extraction are ON.
Project scope: disabled (not inside a Git repository).
```

`Project scope: disabled` 不代表插件出错，Profile Memory 仍然可以正常使用。

---

## 2. 开启或关闭当前 Session 的自动记忆

关闭：

```text
/memory off
```

开启：

```text
/memory on
```

它们只控制当前 Session 的：

- 自动读取相关记忆；
- 对话结束后的自动候选提取。

它们不会删除已有记忆，也不会影响其他 Session。

新 Session 默认开启，一般不需要先执行 `/memory on`。

---

## 3. 明确创建一条正式记忆

格式：

```text
/memory remember <scope> <type> <content>
```

## Profile Memory

Profile Memory 在所有项目中都可以使用，支持两种类型：

| 类型 | 用途 | 示例 |
|---|---|---|
| `preference` | 长期偏好 | 默认使用中文回答 |
| `habit` | 长期工作习惯 | 提交前先运行测试 |

示例：

```text
/memory remember profile preference 默认使用中文回答，并在修改代码后汇报测试结果。
```

```text
/memory remember profile habit 提交代码前先检查 Git 状态和测试结果。
```

## Project Memory

Project Memory 只在指定项目中使用，支持五种类型：

| 类型 | 用途 | 默认有效期 |
|---|---|---:|
| `project_fact` | 项目事实 | 180 天 |
| `decision` | 已确认的项目决定 | 不自动过期 |
| `lesson` | 项目中验证过的经验 | 不自动过期 |
| `task_state` | 临时任务状态 | 30 天 |
| `inference` | 尚未证实的推断 | 90 天 |

示例：

```text
/memory remember project project_fact 服务启动入口是 src/server.ts。
```

```text
/memory remember project decision 数据库迁移必须保持向前兼容。
```

```text
/memory remember project lesson 修改缓存结构后必须清理旧索引。
```

```text
/memory remember project task_state 支付重构已经完成第一阶段。
```

```text
/memory remember project inference 当前性能下降可能与索引失效有关。
```

注意：

- Project Memory 必须先在项目中启用；配置方法见第三部分。
- `inference` 会被标记为未验证推断。
- 单条记忆最多 1,000 个 Unicode 字符。
- 密钥、Token、密码、`.env` 正文、完整文件和长日志会被拒绝。
- `remember` 只负责创建，不会自动覆盖内容相似的旧记忆。
- 完全相同的 scope、类型和正文已经存在时，会返回 duplicate，不会重复创建。

---

## 4. 更新一条正式记忆

格式：

```text
/memory update <memory-id> <new-content>
```

示例：

```text
/memory update 550e8400-e29b-41d4-a716-446655440000 默认使用中文回答，并优先给出可执行命令。
```

更新时：

- 必须提供精确的 Memory ID；
- 原 Memory ID 不变；
- 原 Hindsight document ID 不变；
- 新正文替换旧正文；
- 不会根据相似内容自动猜测更新目标；
- 已过期（含尚未物理清理、但已超过 `expires_at`）的记忆不能通过 update 复活。

## 4.1 列出与查看正式记忆

```text
/memory list
/memory list profile
/memory list project
/memory show <memory-id>
```

规则：

- 默认 `/memory list` 最多显示 20 条当前 Profile + 已启用 Project 的**有效活跃**本地记忆；
- 只通过 SQLite 已证明的 Bank/document 定位器精确读取正文，从不枚举 Bank，也不做模糊目标选择；
- 列表与 `show` 会用 SQLite 中的精确定位信息，同时读取 Hindsight 的原始 Document 和该 Document 唯一的有效 Memory unit；
- 只有 Bank ID、Document ID、Memory ID、scope、类型、正文、哈希、治理元数据和生命周期信息全部一致时，才会展示正文；
- Hindsight `0.8.3` 的治理元数据来自 Document 的 `document_metadata`，不会错误依赖 Memory unit 中可能为 `null` 的 `metadata`；
- provider 不可用或任一校验不一致时，仍会显示 ID/scope/type/status，但正文标记为 `content unavailable`，从不展示未验证正文；
- 成功 remember、Candidate 批准、候选文本列表和 `/memory last` 会显示可用的 Memory ID；无本地行的共享 Project 回忆标记为只读，不能作为 update/forget 目标。

---

## 5. 删除一条正式记忆

格式：

```text
/memory forget <memory-id>
```

示例：

```text
/memory forget 550e8400-e29b-41d4-a716-446655440000
```

它会：

1. 删除该记忆对应的 Hindsight document；
2. 检查 document 已不存在；
3. 检查对应的有效 memory unit 数量为零；
4. 验证成功后，把本地记忆状态改为 `deleted`。

如果网络超时或无法证明删除结果，插件不会假装删除成功，而会保留可恢复状态，等待后续按同一个精确目标核验或重试。

可以先用 `/memory list` 查找 Memory ID，再用 `/memory show <memory-id>` 确认目标；删除时仍必须明确提供精确 ID，插件不会根据相似内容猜测。

---

## 6. 查看自动提取的候选记忆

推荐使用交互界面：

```text
/memory candidates
```

按键：

| 按键 | 操作 |
|---|---|
| `j` / `k` 或方向键 | 移动选择 |
| `a` | 批准候选并写入正式记忆 |
| `e` | 编辑后批准 |
| `r` | 拒绝候选 |
| `x` | 确认后批量拒绝低价值候选 |
| `Tab` | 切换是否显示过期候选 |
| `q` / `Esc` | 关闭 |

只查看文本列表：

```text
/memory candidates list
```

如果已经知道 Candidate ID，也可以使用：

```text
/memory candidates approve <candidate-id>
```

```text
/memory candidates reject <candidate-id>
```

```text
/memory candidates edit-approve <candidate-id> <new-content>
```

Candidate 默认 30 天过期（仅未处理的 `pending` 会 TTL 过期）。批准后才会写入正式记忆。手动拒绝仅允许 `pending` 或明确失败的 `failed`；`approving` 与 `reconciling` 不可拒绝。终端态（approved/rejected/expired）会立即清除本地正文，只保留哈希与元数据。

Project 范围的 Candidate 只在当前目录已启用且项目身份精确匹配时才可见、可操作（交互界面、文本列表、过期视图、冲突展示、批量拒绝，以及按 ID 直接 approve/reject/edit-approve 均适用）；界面顶部会说明当前显示的是仅 Profile 还是 Profile + 当前 Project。匹配项目下可以重试此前失败的 Candidate。失败原因仅展示经过白名单核准的本地化说明，不会展示原始 Provider 响应内容。

`/memory candidates list` 会显示 Candidate ID。

---

## 7. 查看上一轮自动读取了什么

```text
/memory last
```

用途：

- 查看当前 Session 最近一次成功召回的记忆；
- 判断回答是否使用了长期记忆；
- 排查某条旧记忆是否影响当前回答。

它只显示最近一次召回摘要，不是完整记忆列表。有本地治理行时会显示 Memory ID；无本地行的共享 Project 回忆标记为只读。

---

## 7.1 清理过期记忆

### 查看是否需要清理

```text
/memory cleanup status
```

这个命令只查看状态，不会删除任何内容。你可以用它检查：

- 有没有过期记忆等待清理；
- 上一次清理是否成功；
- 当前是否有其他 Pi 窗口正在清理。

### 立即清理

```text
/memory cleanup now
```

这个命令会先让你确认。确认后，它会：

- 从 Hindsight 删除已经过期的记忆；
- 清理 SQLite 中太旧、已经没用的历史记录；
- 保留仍然有效、正在处理或需要恢复的数据。

为了避免一次运行太久，每次最多处理 10 条过期正式记忆。

### 什么时候使用？

平时不用手动清理，插件每天最多会自动处理一次。你只需要在以下情况手动执行：

1. 想确认自动清理是否正常时，运行 `/memory cleanup status`；
2. 状态显示有过期记忆等待处理时，运行 `/memory cleanup now`；
3. Hindsight 之前不可用、现在已经恢复，想马上重试清理时，运行 `/memory cleanup now`。

简单说：`status` 是看看有没有需要清理的内容，`now` 是现在开始清理。

## 8. 切换 Memory 界面语言

中文：

```text
/memory language zh
```

英文：

```text
/memory language en
```

只改变 Memory 插件的通知和界面语言，不会改变 Pi 主程序或模型回答语言。

---

## 9. 汇总和回顾已有记忆：`/memory reflect`

简单说，Reflect 的作用是：

> **让 Hindsight 阅读某个范围内已经保存的多条记忆，再根据你的问题做一次总结或归纳。**

它适合回答这类问题：

- “我以前记录过哪些工作偏好？”
- “这个项目已经做过哪些重要技术决定？”
- “根据过去的项目经验，有哪些教训需要注意？”
- “目前记录的项目任务状态是什么？”

格式：

```text
/memory reflect <profile|project> <你想总结的问题>
```

### 汇总个人记忆

```text
/memory reflect profile 总结我在代码协作方面的长期偏好。
```

Hindsight 会基于已保存的 Profile Memory，例如 `preference` 和 `habit`，生成一段汇总回答。

### 汇总当前项目记忆

```text
/memory reflect project 总结这个项目已经记录的关键技术决定和经验教训。
```

Hindsight 会基于当前项目的 `project_fact`、`decision`、`lesson`、`task_state` 和 `inference` 等记忆生成汇总。当前项目必须已经启用 Project Memory。

### 它和自动读取有什么区别？

| 功能 | 自动读取 Recall | 手动 Reflect |
|---|---|---|
| 什么时候运行 | 每次正常提问前自动运行 | 只有输入命令才运行 |
| 主要作用 | 找出少量相关记忆，供 Pi 当前回答参考 | 对多条已有记忆做总结、归纳或回顾 |
| 输出在哪里 | 注入当前轮上下文，不单独生成总结 | 直接向你显示一段总结结果 |
| 是否修改记忆 | 否 | 否 |

### 它不会做什么？

Reflect 不会：

- 新增正式记忆；
- 更新或覆盖旧记忆；
- 删除记忆；
- 把总结结果自动保存为新记忆；
- 自动在后台运行。

Reflect 可能把你的问题和相关记忆交给 Hindsight 配置的生成式模型处理。这个模型是否在本机运行、是否会调用外部服务，取决于你的 Hindsight 部署配置，因此每次执行前都会要求你确认。

### 等待时间、超时与取消

Reflect 是一次可能包含多轮 LLM/工具处理的合成操作，通常比普通的记忆读取（Recall）慢很多。因此：

- Reflect 单次请求最多可等待 **180 秒**，明显长于其他记忆请求（Recall、记住、更新、删除等）固定的 10 秒上限；这个更长的等待时间只适用于 Reflect，不会影响其他请求。
- 如果 Hindsight 在 180 秒内没有返回结果，Pi 会显示一条独立的、本地化的超时提示，和其他失败提示（网络错误、HTTP 错误等）区分开，方便你判断原因。
- 在等待过程中按 Esc 或结束当前会话会立即取消 Reflect，不会等到 180 秒超时，也不会被误报为超时。
- 无论成功、超时还是取消，Reflect 都不会自动保存任何内容为新记忆。

---

## 10. 用自然语言明确要求 Pi 记住

除了命令，你也可以明确告诉 Pi：

```text
请长期记住：我偏好所有回答默认使用中文。这是 profile preference。
```

Pi 可以调用 `memory_remember` 工具直接创建正式记忆。

更新时仍然必须提供精确 ID，例如：

```text
请把 ID 为 550e8400-e29b-41d4-a716-446655440000 的长期记忆更新为：默认使用中文回答，并附带关键命令。
```

模型工具不会模糊选择更新目标。

---

# 第二部分：自动记忆怎么工作

## 1. 自动读取：每次提问前执行

在交互式 Pi TUI 中，只要当前 Session 没有执行 `/memory off`，每次你发送问题时，插件会自动：

1. 查询相关 Profile Memory；
2. 如果当前项目启用了 Project Memory，同时查询该项目记忆；
3. 检查记忆是否为 active、是否过期、scope/type/正文哈希是否一致；
4. 过滤敏感、冲突或无效内容；
5. 最多向当前轮注入 10 条、约 1,500 tokens 的相关记忆。

你不需要输入读取命令。

召回内容只作为当前轮的不可信参考，不会覆盖：

- 你当前的指令；
- 系统和安全规则；
- 当前代码、配置和工具读取到的实际证据。

可以用下面的命令查看最近一次召回：

```text
/memory last
```

---

## 2. 自动提取：一次对话工作完全结束后执行

这里的“一轮”不是关闭 Session，而是：

> 一次用户输入触发的回答、工具调用、自动重试、自动压缩和排队 follow-up 全部完成，Pi 进入 settled 状态。

例如：

```text
你发送一个问题
  → Pi 读取文件
  → Pi 调用工具
  → Pi 根据结果继续回答
  → 本次工作完全结束
  → 插件尝试提取 Candidate
```

一个 Session 可以有很多轮，每轮结束后都可能获得一次提取机会，不需要等退出 Pi。

但不是每一轮都会产生 Candidate。以下情况通常不会记录：

- 没有值得跨 Session 保存的信息；
- 内容太短；
- 内容像完整文件或长日志；
- 检测到密钥、密码或 Token；
- 提取模型失败、超时或输出格式不合法；
- 已有完全相同的正式记忆或待审候选；
- 当前执行过 `/memory off`。

---

## 3. 普通对话只生成 Candidate，不直接写正式记忆

普通自然语言对话中，模型会判断：

- 是否值得长期记录；
- 属于 `profile` 还是 `project`；
- 属于哪一种 memory type；
- 候选正文是什么。

然后只把 Candidate 写入本地 SQLite。

流程：

```text
普通对话
  → 自动判断 scope 和类型
  → 写入 SQLite Candidate
  → 你执行 /memory candidates 审批
  → 批准后写入 Hindsight 正式记忆
```

因此：

- 普通对话不会自动批准记忆；
- 不会直接写入正式长期记忆；
- 不会自动覆盖或删除旧记忆；
- 不会模糊判断应该替换哪条旧记忆；
- 当前自动提取只创建 create Candidate，不自动创建 update/supersede 目标。

如果你明确说“请长期记住”，Pi 可以调用工具直接写入；这属于明确授权，不是普通自动提取。

---

## 4. SQLite 和 Hindsight 分别保存什么

### 自动提取但尚未批准

SQLite `candidates` 保存：

- Candidate ID；
- 候选正文；
- scope 和类型；
- 有限的证据摘要；
- 来源 Session；
- 审批状态和过期时间。

此时还没有写入正式 Hindsight 记忆。

### Candidate 批准后

Hindsight 保存：

- 正式记忆正文；
- document ID；
- metadata 中的 logical Memory ID、正文哈希、scope、类型和有效期。

SQLite `memories` 保存：

- Memory ID；
- scope、类型和 Project identity；
- Hindsight Bank/document/unit 定位；
- 正文哈希和长度；
- `active`、`reconciling`、`deleted`、`expired`、`superseded` 等生命周期状态；
- 时间、操作代数、所有权和崩溃恢复信息。

SQLite `memories` 不保存正式正文。Candidate 进入 `approved`、`rejected` 或 `expired` 终端态时，会在同一事务中清除候选正文和证据摘要，只保留哈希、状态和必要的治理元数据。`failed` 或 `reconciling` Candidate 在仍需恢复时会暂时保留处理材料。

---

## 5. 过期与数据保留

### Candidate

Candidate 默认 30 天过期。未处理的 `pending` Candidate 到期后会原子地变为 `expired`，并立即清除正文和证据摘要。

`approved`、`rejected` 和 `expired` Candidate 的无正文元数据默认保留 90 天；之后由有界维护在没有必要引用时删除。`failed` 和 `reconciling` 不会仅因 TTL 到期而丢失恢复所需正文。

### 正式 Project Memory

| 类型 | 有效期 |
|---|---:|
| `project_fact` | 180 天 |
| `task_state` | 30 天 |
| `inference` | 90 天 |

到期时间同时写入 SQLite 和 Hindsight metadata。到期后：

1. 记忆立即停止参与 recall；
2. 默认 `/memory list` 只列有效活跃记忆，因此到期记忆会从列表中消失；如果已知 ID，`/memory show <id>` 会按有效状态报告为 `expired`，且不展示正文；
3. 有界维护使用精确 Bank ID 和 Document ID 删除 Hindsight Document；
4. 只有确认 Document 已不存在且有效 Memory unit 为零后，SQLite 才完成 `expired` 终态；
5. 如果网络结果不明确，记忆保持 `reconciling`，后续继续核验，不会假装删除成功；
6. `expired` 记忆不能通过 update 复活。

### 本地历史数据保留

自动维护和 `/memory cleanup now` 会分批清理不再影响正确性的数据：

| 数据 | 默认保留策略 |
|---|---|
| 无正文终端 Candidate 元数据 | 90 天 |
| 已完成或明确失败的 Operation | 30 天 |
| 已解决 Conflict | 90 天 |
| Audit 与 Usage | 90 天，并分别软限制为最多 10,000 行 |
| 已删除/已过期的无正文 Memory tombstone | 90 天，且必须已无恢复引用 |

每个本地清理操作都以最多 100 行的小批次执行（一次维护会在正式记忆过期处理前后分别进行本地清理）；每次维护最多处理 10 条到期正式记忆。仍在审批、写入、恢复、冲突或被引用的数据不会被清理。

---

## 6. 当前仍存在的限制

- 没有手动 `/memory extract` 命令；Candidate 仅由 settled 自动提取产生（且不是每一轮都会生成）。
- Reflect 只做手动汇总，不会把结果自动保存为新记忆。
- 自动 recall 单轮有超时预算；Hindsight 响应过慢或机器负载过高时，本轮会安全地不注入记忆，不会阻塞或写错数据。
- 到期记忆会立即停止使用，但 Hindsight 中的物理删除依赖后续维护运行。
- 清理后的 SQLite 空闲页可以被后续写入复用，但插件不自动执行 `VACUUM`，因此不承诺数据库文件立即缩小。
- Hindsight 的生成、Embedding 和 Rerank 是否完全在本地运行，取决于你的 Hindsight 部署配置。

---

# 第三部分：安装和配置

## 1. 环境要求

- Pi：`0.85.1` 兼容范围（`pi --version` 可确认）；
- Node.js：`>=22.19.0`；
- Hindsight HTTP API：`0.8.3`，需**单独启动**并可达（默认 `http://127.0.0.1:8888`）；
- 系统：macOS 或 Linux。

> **说明：** 下列 GitHub 直装步骤面向公开仓库 `https://github.com/stones-hub/pi-memory-hindsight`。使用版本 tag 安装可固定代码版本；直接使用仓库 URL 安装时跟随默认分支。

---

## 2. 从 GitHub 安装（推荐）

```bash
pi install https://github.com/stones-hub/pi-memory-hindsight.git
```

Pi 会克隆仓库、执行 `npm install --omit=dev`，并按 `package.json` 中的 `pi.extensions` 直接加载 TypeScript 源码（**不需要**事先 `npm run build`）。本包无运行时 `dependencies`，也无安装脚本；`package.json` 中的 `allowScripts` 仅声明**本包自身**不需要/不允许安装脚本（`{ "pi-memory-hindsight": false }`）。

检查登记：

```bash
pi list
```

重新启动 Pi，或在已运行的 Pi 中执行：

```text
/reload
```

然后确认插件可用：

```text
/memory status
```

### 更新

未固定 tag/commit 时，可用：

```bash
pi update --extensions
```

或：

```bash
pi update --all
```

需要固定到当前正式版本时，可使用：`pi install https://github.com/stones-hub/pi-memory-hindsight.git@v0.2.3`。需要固定到首个正式版本时，可使用 `@v0.1.0`。直接使用不带 `@ref` 的仓库 URL，则跟随默认分支。

### 卸载

从 Pi 设置中移除插件登记（**不会**自动删除本地 SQLite 或 Hindsight 中的记忆数据）。`pi remove` 的参数必须与 `pi list` 中显示的 **package source 完全一致**（git 源按「仓库 URL、不含 ref」匹配；`.git` 后缀通常可与无后缀形式等价，但以 `pi list` 为准）：

```bash
pi list
pi remove https://github.com/stones-hub/pi-memory-hindsight.git
```

上例 remove 使用与 `pi install https://github.com/stones-hub/pi-memory-hindsight.git` 对应的源；若 `pi list` 显示不同字符串，请复制该字符串。

若你是用本地路径安装的，则对 `pi remove` 使用当时登记的**同一路径**（见 `pi list`）。

### 本地路径安装（开发）

```bash
pi install /absolute/path/to/pi-memory-hindsight
```

---

## 3. 配置 Hindsight 地址

默认使用：

```text
http://127.0.0.1:8888
```

如需修改，在 Pi agent 目录创建：

```text
~/.pi/agent/memory-hindsight.json
```

内容只允许：

```json
{
  "url": "http://127.0.0.1:8888"
}
```

如果 Hindsight 需要 API Key，只通过环境变量提供：

```bash
export HINDSIGHT_API_KEY="..."
```

不要把 API Key 写进 JSON 配置或仓库。

---

## 4. 启用 Project Memory

Profile Memory 安装后即可使用。Project Memory 默认关闭。

在目标 Git 仓库根目录创建：

```text
.pi/memory.json
```

推荐显式指定项目身份：

```json
{
  "enabled": true,
  "project": "my-project"
}
```

也可以省略 `project`：

```json
{
  "enabled": true
}
```

省略时会尝试从 Git `origin` 的仓库名推导。如果没有可用 origin，Project Memory 会保持关闭，不会回退写入 Profile Memory。

配置后执行：

```text
/reload
/memory status
```

确认显示：

```text
Project scope: enabled (...)
```

---

## 5. 数据位置

本地治理数据库默认位于：

```text
~/.pi/agent/memory/pi-memory-hindsight.db
```

它保存 Memory ID、Candidate、状态、定位和审计信息。

正式记忆正文保存在插件专属的 Hindsight Bank 中。插件不会枚举已有 Bank。

---

## 6. 开发验证

前置条件：`node` `>=22.19.0`、已安装 Pi CLI（`0.85.1` 兼容）、`python3`（PTY 驱动）、`git`（loopback git-install 验收）。下列命令不会访问真实 `~/.pi` 或已有 Hindsight Bank。

```bash
npm test
npm run typecheck
npm run build
npm pack --dry-run
npm run acceptance:pi
npm run acceptance:git-install
```

`npm test` 当前包含 **18** 个文件 / **353** 项测试（含 loopback `pi install` git 验收）。`npm pack --dry-run` 当前打包 **69** 个文件（含根目录 `LICENSE`）。

真实 Hindsight 验收脚本只允许使用由随机 nonce 派生的全新临时 Project Bank，不应针对已有 Bank 运行。脚本默认拒绝执行，必须显式提供安全开关、loopback 地址、预期 API 版本、nonce 和与 nonce 匹配的 Bank ID；无论主流程成功或失败，都会尝试删除该临时 Bank。完整运行方式和环境变量见 [`docs/acceptance.md`](docs/acceptance.md)。

命令入口是：

```bash
npm run acceptance:hindsight:live
```

普通开发检查不会操作真实 Pi Profile 或已有 Hindsight Bank。

更多实现和安全设计：

- [`docs/product-requirements.md`](docs/product-requirements.md)
- [`docs/architecture.md`](docs/architecture.md)
- [`docs/memory-policy.md`](docs/memory-policy.md)
- [`docs/threat-model.md`](docs/threat-model.md)
- [`docs/hindsight-contract.md`](docs/hindsight-contract.md)
- [`docs/acceptance.md`](docs/acceptance.md)

---

## 7. 许可证

本仓库以 [Apache License 2.0](LICENSE) 发布（与 `package.json` 中 `Apache-2.0` 一致）。
