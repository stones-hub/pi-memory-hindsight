# 任务目标

新增 `/memory help`，以中英文分组列出全部受支持的 `/memory` 命令，并用通俗语言解释用途；裸 `/memory` 复用同一详细帮助。

# Risk

- 类型：普通任务
- 判断理由：局部命令解析、只读帮助文案和测试改动，不改变存储、治理、删除、并发、认证或 provider 契约。
- 关键契约与升级触发条件：不得改变已有命令语义、TUI-only 门禁、Hindsight/SQLite 数据行为。若实现需要数据库迁移、provider 调用、治理流程或公共工具契约变更，立即停止并升级为关键任务重新确认。

# Scope

- 当前基线：`916747bc5e07ddc132ad0a68734171593a4bdd04`；工作区另有用户未跟踪文件 `.pi/memory.json`，必须保持未读取、未修改、未暂存。
- 允许改动文件/目录：`src/commands/memory-command-parser.ts`、`src/commands/memory-command.ts`、`src/i18n/messages.ts`、`src/runtime/global-runtime.ts`（仅允许增加不触发初始化的 cached-runtime peek，用来保证 help 不创建/修改 SQLite）、相关 `tests/`、`scripts/acceptance-pi.mjs`（仅在证明打包后公开入口确有必要时）、`README.md`、`docs/product-requirements.md`、`docs/acceptance.md`、`package.json` 和 `package-lock.json`（仅将发布版本从 `0.1.0` 提升到用户确认的 `0.2.0`）。
- Pi 已维护、不要求执行器修改：`docs/memory-help-command.md`、本任务书、`HANDOVER.md`。
- 禁止改动文件/目录：除上述只读 cached-runtime peek 外的 runtime 初始化行为、数据库 schema/repository、provider、治理服务、identity、recall/extraction 核心逻辑、依赖和 lockfile、`.pi/memory.json`、Pi 配置、live Hindsight 数据。

# 执行器与授权

- 执行器：Cursor Agent（原计划 Claude Code，但调用被中止且未产生源码改动；用户随后明确授权切换到 Cursor Agent）
- 请求模型：Cursor `grok-4.6`（用户在 `composer-2.5` 调用中止后明确指定 Grok 4.6）；实际生效模型以 Cursor 响应可证明字段为准，缺失则记为未证明。
- 编码授权：已获得；用户在确认方案后明确要求“帮我处理”，并明确要求改用 Cursor Agent 执行。
- 权限范围：完成本任务实现、测试及 `0.2.0` 版本准备。用户已单独授权 Pi 在最终验收后执行 commit、push `origin/main`、annotated tag `v0.2.0` 和 GitHub Release；编码执行器不得自行执行这些 Git/GitHub 动作，也不得部署或修改 live 配置/数据。

# 真实业务背景

当前裸 `/memory` 会走 help，但只显示单行命令格式；显式 `/memory help` 不能解析。用户希望通过一个容易发现的命令看到完整命令列表和每条命令的说明。

# 已确认的源码事实

- `ParsedMemoryCommand` 已有 `{ kind: "help" }`，裸参数返回 help，但 parser 没有 `case "help"`。
- `memory-command.ts` 的 help 路径读取 i18n `memory.help`；未知输入以 error 通知帮助。
- 当前中英文 `memory.help` 都是一行命令串，且刻意不包含已移除的 manual extract 命令。
- 命令只在 `ctx.mode === "tui"` 时处理。
- 本地 runtime 可用后才根据 Profile 语言渲染；当前 runtime 不可用时 status 有特殊输出，其余命令直接返回，需使 help 符合已批准的可用性方案且不得引入数据访问。

# 预期正确行为

- 正常路径：精确 `/memory help` 显示多行、按功能分组、逐条解释的完整中英文帮助；裸 `/memory` 显示完全相同内容。
- 必须覆盖：help/status、on/off、remember、update、forget、list/list profile/list project/show/last、candidates 及四种文本形式、cleanup status/now、language zh/en、reflect profile/project。
- 帮助补充：Profile 类型 `preference|habit`；Project 类型 `project_fact|decision|lesson|task_state|inference`；TUI-only；`cleanup now` 与 `reflect` 需确认；没有 manual `/memory extract`，候选由 settled 自动提取。
- 边界：`help extra` 非法并以 error 显示同一帮助；Hindsight 不可用时帮助仍显示；帮助不触发 provider 读写或 SQLite mutation；非 TUI 仍保持无行为。特别注意：不得为了读取语言调用会首次初始化 SQLite/profile 的 `getLocalRuntime()`；可只查看已经存在的 process-wide cached local runtime，未初始化时回退英文。
- 语言：local runtime 已缓存可用时服从持久化 zh/en；尚未初始化或不可用时英文回退。

# Verify：自动化测试

- 编码 Agent 必须运行：相关 Vitest（至少 parser/command/i18n），`npm test`，`npm run typecheck`，`npm run build`，`npm pack --dry-run`（清理任何生成 tgz），`git diff --check`，src/tests NUL 扫描；若修改 acceptance runner，再运行 `npm run acceptance:pi`。
- Pi 必须独立重跑：相关测试、`npm test`、typecheck、build、pack dry-run、diff/NUL；并运行隔离的 packaged Pi acceptance 或等价的打包后真实 Pi 命令入口验收。
- 关键任务额外测试/独立复审：不适用；若范围升级为关键任务则停止并重新确认。

# Verify：本机候选运行验收

- 是否改变运行行为：是，新增公开 TUI 命令行为。
- 运行方式：构建并打包，在隔离临时 `PI_CODING_AGENT_DIR` 中由真实 `pi` 子进程加载包；优先扩展现有 `npm run acceptance:pi` 的安全离线 harness。
- 本地依赖及数据库类型/版本：项目现有 Node >=22.19、Pi 0.85.1、内置 `node:sqlite`；Hindsight 使用 loopback mock，不连接 live 服务。
- 构建或安装命令：`npm run build`，现有 package/acceptance 流程。
- 启动命令：`npm run acceptance:pi` 或经 Pi 确认的等价隔离命令。
- 业务就绪检查：真实 Pi 子进程成功加载打包扩展并注册 `memory` 命令。
- 正式入口和核心黑盒业务场景：从真实 `/memory help` 入口验证详细帮助；验证裸 `/memory`；至少验证默认英文，中文由自动化测试覆盖，若 harness 易扩展则也做中文入口。
- 必须检查的最终结果：输出包含全部命令组和解释，不包含可执行的 `/memory extract` 命令；无 provider retain/delete/recall/reflect 请求；证据不得包含正文、密钥或完整日志。
- 必须检查的日志：子进程无未解释异常，acceptance `pending=[]` 且既有 required booleans 不回退。
- 关键失败/边界/恢复场景：Hindsight unavailable 时 help 仍可显示；非 TUI 自动行为约束不回退。
- 停止和清理命令：由现有 acceptance harness timeout/finally 清理临时目录、子进程和 mock server；删除意外 tgz。
- 测试数据准备与清理：仅合成数据和临时 Profile；不读取用户 `.pi/memory.json`。
- 禁止连接的域名、数据库和环境：任何非 loopback Hindsight、用户真实 Pi profile、用户 live SQLite、外部机器或生产环境。
- 环境缺失时的阻断条件：真实 Pi/Node 或隔离 acceptance 无法运行时标记受阻，不得用单测冒充黑盒通过。

# 验收标准

- `parseMemoryCommand("help")` 返回 help，`help extra` 返回 null。
- `/memory help` 与裸 `/memory` 显示同一详细帮助。
- 中英文帮助逐条覆盖全部现有合法命令与解释，包括明确列出 `/memory reflect profile <query>` 和 `/memory reflect project <query>`，并保留 manual extract 不存在的说明。
- 在全新、尚无 SQLite 文件/Profile 的隔离 agent dir 中，单独运行 help 不创建数据库或 Profile；已有 cached runtime 时可读取内存中的语言。
- runtime/provider 不可用时 help 仍可显示，且无 mutation。
- 未知或参数错误命令继续以 error 显示帮助。
- 已有命令、TUI-only、安全和治理测试无回归。
- 自动化与打包后真实入口验收通过。
- 编码 Agent 自报、单元测试、进程/容器存活均不能单独构成完成。

# 禁止事项

- 禁止读取或输出凭证，禁止未经授权 SSH 或访问生产环境。
- 禁止未经单独授权 commit、push、发布或部署。
- 禁止 rsync、scp、docker cp 或其他绕开 Git 的代码交付。
- 禁止读取、修改或暂存未跟踪的 `.pi/memory.json`。
- 遇到范围冲突、前提错误或验证受阻时停止并报告，不静默改方案或降低标准。
