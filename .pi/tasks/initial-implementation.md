# 任务目标

实现 `pi-memory-hindsight` 首个可安装、可测试的生产级候选：通过 Pi 0.85.1 公共 Extension API，在交互式 TUI 中提供隔离、审批、安全降级的 Profile/Project 长期记忆，并以 Hindsight 0.8.3 为首个 Provider。

# Risk

- 类型：关键任务
- 判断理由：涉及持久化数据库迁移、敏感数据过滤、跨项目隔离、并发审批、幂等写入、物理删除、模型调用和 Session 生命周期。
- 关键契约与升级触发条件：不得改变已确认的 Bank/身份/配置、审批、原样写入、一记忆一 Document、删除后验证、非交互禁用和 fail-open-for-Pi/fail-closed-for-memory 契约。若公共 Pi/Hindsight API 无法实现，停止并报告，不能改用内部 API或放宽安全策略。

# Scope

- 当前基线：仓库无 commit；阶段 0 文件全部未提交。仓库外基线清单 `/tmp/pi-memory-hindsight-implementation-baseline.txt`，SHA-256 `75352e72cb1dfbd502cc710b8ccff52179e61a7087b20e6fc2c8932ce9cadc54`。
- 允许改动：`package.json`、锁文件、TypeScript/build/lint/test 配置、`src/`、`tests/`、`README.md`、`docs/`、`HANDOVER.md`、`.gitignore`、本任务书。
- 禁止改动：仓库外文件、现有 Pi 配置、用户已有 Hindsight 数据/Bank、Docker 配置、系统配置。

# 执行器与授权

- 执行器：Claude Code
- 请求模型：`sonnet`，必须报告响应可证明的 canonical model。
- 编码授权：已获得（当前用户回复“授权”）。
- 权限范围：仅当前仓库正式代码、测试和文档；可运行本地构建和测试。禁止 commit、push、publish、全局安装、修改 `~/.pi`、访问/枚举/写入真实 Hindsight Banks。Provider 集成测试使用 mock HTTP server；真实契约测试留给 Pi 的隔离验收。

# 真实业务背景

Pi 保留原生 Session、Compaction、`AGENTS.md` 和 Skills。Extension 仅增加跨 Session 长期记忆。Hindsight 保存获批正文；SQLite 保存候选和治理状态。自动提取不能自动批准。召回是不可信参考，任何故障都不能中断普通 Pi 工作。

# 已确认的源码事实

- Pi 0.85.1：`ctx.mode` 为 `tui|rpc|json|print`；自动行为必须精确检查 `tui`。
- `before_agent_start` 可返回回合级 `systemPrompt`；下一回合无 override 时恢复 base。返回 custom `message` 会持久化，不用于 Recall。
- `agent_end` 有 messages；`agent_settled` 无 messages。`pi.appendEntry()` 不参与 LLM 上下文。
- `ctx.modelRegistry.complete()` 可独立调用当前模型；必须自行记录 usage，并使用独立 session ID、无 tools、timeout/cancellation。
- Pi/Node 基线 `>=22.19.0`，使用 `node:sqlite`。
- Hindsight 0.8.3：认证为可选 `Authorization: Bearer <HINDSIGHT_API_KEY>`；同步 retain 不返回 unit ID；可按 `document_id` list。
- Owned Bank 必须固定 `retain_extraction_mode=chunks`、`retain_chunk_size=2048`、`enable_observations=false`、`enable_auto_consolidation=false` 并回读验证。
- 一个逻辑记忆对应一个确定性 Document；正文最多 1,000 Unicode 字符；写后精确回读。
- 无公开单 Memory DELETE；forget 用公开 Document DELETE 并验证 Document 404、该 document 的 units 为 0。

# 预期正确行为

## 正常路径

- 通过 `getAgentDir()` 解析 Profile 目录；全局配置仅 `<agent-dir>/memory-hindsight.json` 的 `url`，Key 仅环境变量。
- SQLite 位于 `<agent-dir>/memory/pi-memory-hindsight.db`，有版本迁移、WAL/busy timeout、外键、并发条件更新、body-free audit。
- 项目配置仅 Git 根 `.pi/memory.json`，严格字段 `enabled` 与可选 `project`；身份规则完全遵循 requirements。
- Bank ID 是 `pi-memory-hindsight:profile|project:<hash>`，不泄露路径或名称，不枚举 Banks。
- 每个真实用户回合最多 Recall 一次；并行查询启用的 Project/Profile Banks，Project 优先；10 条/~1500 token；追加到 `event.systemPrompt` 的明确不可信数据块；不写 Session message。
- `agent_end`/`agent_settled` 自动提取：本地门禁、最小材料、敏感过滤、独立当前模型、严格全有或全无 JSON 校验、只入 candidates。
- 提供 `memory_remember` Tool 和 `/memory` 命令族，至少实现：status/on/off/last/extract/remember/candidates/approve/reject/forget/language/reflect；候选 TUI 可审阅、编辑、批准、拒绝，文本子命令复用同一 service。
- 显式 remember 在授权清晰且安全时可直接写；模糊 scope/conflict 询问或创建待处理状态；Project 未启用时不得降级写 Profile。
- 写入 Hindsight 使用确定性 document ID、同步 chunks retain、按 document ID 精确验证；不明确结果进入 reconcile/retry 状态，不能静默重复。
- lifecycle、冲突、去重、过期和验证状态按文档实现；Project Bank 共享所需 metadata 必须在 Hindsight 记录中。
- forget 只根据本地 owned locator 删除，执行并验证物理 Document 删除；审计不含正文。
- 中英文 UI/消息，自动语言检测，SQLite 持久化切换。

## 关键异常/边界路径

- print/json/rpc 自动处理全部 no-op；`hasUI` 不能代替 mode gate。
- 缺配置、错误 URL、Hindsight 超时/4xx/5xx/畸形/过大响应、SQLite 失败、当前模型缺失、抽取 JSON 非法：记忆功能安全失败，Pi 继续。
- 禁止 URL 内凭证和非 HTTP(S)；HTTP client 有超时、响应大小上限、错误脱敏，日志不含响应正文/Authorization。
- 秘密、`.env`、私钥、Token/Cookie/password、完整源码/会话/日志/大工具输出必须在模型和存储边界前拦截；model thinking 不进入抽取材料。
- 并发窗口只有一个审批写者；重复 approve/remember/retry 不产生重复 Document。
- Bank config drift 阻断写入；不得启用 Hindsight generative retain/observations。
- Recall metadata 缺失、未知 logical ID、scope/type/lifecycle 不合法时不注入。
- Session off/on 恢复、fork/tree/Session 切换不得串状态。
- shutdown 取消提取；提取自身不触发 Pi 生命周期递归。

# Verify：自动化测试

- 编码 Agent 必须运行：`npm test`、`npm run typecheck`、`npm run build`、`npm pack --dry-run`（如 scripts 名不同，建立等价标准脚本并记录）。
- Pi 必须独立重跑：上述全部；检查完整 diff、依赖和 package tarball 内容。
- 关键任务额外测试/独立复审：
  - 单元：config/identity/bank ID/filter/scope/lifecycle/budget/i18n/JSON parser。
  - SQLite：migration、WAL/busy、并发 conditional approval、idempotency、无正文审计。
  - Provider mock：bank config readback、exact retain/reconcile/update/delete postconditions、auth redaction、timeout/malformed/oversize。
  - Extension lifecycle harness：mode no-op、system prompt composition/non-persistence、once-per-turn、agent_end+settled、session state restore、cancel。
  - 独立 Claude review 新会话，不 resume 编码会话。

# Verify：本机候选运行验收

- 是否改变运行行为：是。
- 运行方式：构建 npm tarball，安装到隔离临时 `PI_CODING_AGENT_DIR`；使用 mock Hindsight 做全自动 E2E，随后仅在严格专用随机 Bank ID 上对本机 Hindsight 0.8.3 做合成契约验收并清理。
- 本地依赖及数据库：Node 当前版本/内建 SQLite；本机 Hindsight 0.8.3 PostgreSQL 仅限随机专用测试 Bank。
- 构建或安装：`npm ci`（有锁文件后）、`npm run build`、`npm pack`，临时 Profile 本地安装 tarball。
- 启动：Pi 0.85.1 从隔离 Profile 以 TUI/可控 PTY 或官方可验证入口启动；若自动 TUI 驱动受阻，需明确记录并以 Extension harness + 包安装烟测补充，不得假称完整 E2E。
- 业务就绪：Extension 无加载错误，SQLite 创建成功，status 可用，mock/测试 Bank 可连接。
- 正式入口和场景：Profile recall、启用 Project recall、候选提取/审批、显式 remember、Session off/resume/on、forget、语言切换；非交互模式不自动调用 Provider。
- 最终结果：Session 文件无召回正文 custom message；SQLite 无正式正文和 body audit；Hindsight exact unit/metadata；删除后无 Document/unit；非 owned sentinel 不变。
- 日志：无秘密、Authorization、完整响应正文、未解释异常。
- 失败/恢复：Provider timeout、ambiguous retain reconcile、重复审批、删除重试、config drift、invalid extraction。
- 停止和清理：停止临时 Pi/mock server；删除临时 Profile、tarball、随机测试 Bank。测试失败需保留证据时只保留仓库外脱敏日志并说明。
- 禁止连接：除 `127.0.0.1` 本机 Pi/Hindsight 和当前模型调用外，不新增外部服务；不使用生产或用户非专用 Bank。
- 环境缺失阻断：无法构建包、无法加载 Extension、无法隔离 Hindsight Bank 或无法证明删除时，候选不能判为本机验收通过。

# 验收标准

- 所有文档核心行为有实现与测试映射，不留下静默 TODO/stub。
- 包从 tarball 安装后可被 Pi 0.85.1 加载。
- 自动行为只在 TUI；Recall 不持久化 Session message且每回合最多一次。
- 自动提取仅生成候选，严格过滤和全响应校验生效。
- Approved write 是 exact one-unit/one-document、可对账、可幂等重试。
- forget 是经过后置验证的物理删除；失败/未知不报成功。
- Profile/Project/namespace 隔离和共享语义正确。
- Hindsight/SQLite/模型故障不阻断普通 Pi。
- 测试、构建、pack、隔离本机验收及独立复审全部通过后，才可称本机候选通过。

# 禁止事项

- 禁止读取或输出凭证，禁止未经授权 SSH 或访问生产环境。
- 禁止未经单独授权 commit、push、publish 或部署/安装到真实 Pi Profile。
- 禁止读取、列出、更新或删除已有非专用 Hindsight Banks。
- 禁止依赖 Pi `dist/core/*` 或 Hindsight 内部 Python API。
- 禁止把 Recall 作为持久 custom message，禁止将 Project 数据降级到 Profile。
- 禁止 rsync、scp、docker cp 或其他绕开 Git 的代码交付。
- 遇到范围冲突、前提错误或验证受阻时停止并报告，不静默改方案或降低标准。
