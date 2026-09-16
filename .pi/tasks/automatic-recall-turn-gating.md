# 任务目标

修复 Pi 0.85.1 下自动 Recall 的首条用户问题被跳过及后续轮次错位问题，使每条分别提交的普通用户输入最多召回一次，同时不让工具循环、重试、压缩重试或流式排队消息造成重复或错误召回。

# Risk

- 类型：关键任务
- 判断理由：本任务修改自动 Recall 的核心生命周期、并发认领和 Session 内状态协调。错误实现可能导致首轮继续漏召回、同一输入重复访问 Hindsight、跨输入或跨 Session 串状态、取消后晚注入，或将不可信记忆错误持久化到 Session。
- 关键契约与升级触发条件：必须保持 TUI-only、每条普通输入至多一次尝试、Session 隔离、先认领后异步、失败不阻塞、Recall 只通过本轮 `systemPrompt` 注入且不持久化、现有安全过滤及候选提取行为不变。若实现需要修改 Pi core/内部 API、SQLite schema、Hindsight 格式、Provider payload、持久化 Recall 消息，或单独支持 queued `steer`/`followUp` Recall，立即停止并重新讨论、审批方案。

# Scope

- 当前基线：Git HEAD `0781c90208e4f6ddc133867db9e8bc080c1b314d`；其上已有本任务获批但未提交的文档改动：`docs/decisions/automatic-recall-turn-gating.md`、`docs/product-requirements.md`、`docs/architecture.md`、`HANDOVER.md`。用户自有未跟踪文件 `.pi/memory.json` 不属于基线，禁止读取或修改。
- 允许改动文件/目录：`src/index.ts`、`src/runtime/session-runtime.ts`、`src/recall/recall-service.ts`、`tests/lifecycle.test.ts`、`tests/integration.test.ts`、`scripts/acceptance-pi.mjs`；为测试该生命周期而严格必要的 `tests/e2e-harness/**`、`src/testing/**`、`src/i18n/messages.ts`；本任务的 `docs/decisions/automatic-recall-turn-gating.md`、`docs/product-requirements.md`、`docs/architecture.md`、`HANDOVER.md` 和本任务书。
- 禁止改动文件/目录：`.pi/memory.json`、数据库 migrations/schema、Hindsight Bank/document/metadata 协议、治理写入/审批/发现/删除业务逻辑、用户真实 Pi 配置和记忆数据库、与本任务无关的源码/测试/文档。禁止导入 Pi `dist/core/*` 或其他内部 API。

# 执行器与授权

- 执行器：Claude Code
- 请求模型：`claude-sonnet-5`
- 编码与发布授权：均已在对话中由用户明确授予。实现、Pi 独立 diff 检查、受影响测试、完整 `npm test`、typecheck、build、`npm audit --omit=dev`、`npm pack --dry-run --json`、`git diff --check`、NUL 字节扫描，以及隔离 packaged Pi 黑盒验收均已通过。首次全新 Claude Code 独立复审仅因交接未明确区分 real-PTY 与单元测试证据而返回 FAIL，未发现核心功能或安全缺陷；披露修正后，第二个全新（非 resume）Claude Code 复审会话返回 PASS。实现提交 `977dc991c68a8139cf9c79b904cc7ed6a1d99a8c` 已推送至 `origin/main`，annotated tag `v0.2.3` 及 GitHub Release 已发布。未执行 npm-registry 发布或目标机部署。
- 权限范围：获得后仅可在上述允许范围内调查、编码、补测试和运行本任务规定的本地隔离验证；不得 commit、push、发布、部署、修改 live 配置或访问/修改 live Memory SQLite/Hindsight 数据。

# 真实业务背景

用户在 Profile Memory 中已经保存“供复制执行的终端命令优先输出为单行”的偏好。用户在一个全新 Pi Session 的第一条消息中请求生成 `curl` 命令，但该偏好没有被自动召回，模型输出了反斜杠分行命令。直接用同一原始问题请求本机 Hindsight，第一条结果即为该偏好，证明记忆存在且语义匹配；问题发生在 Extension 自动 Recall 生命周期门控，而不是记忆内容或 Hindsight 检索质量。

# 已确认的源码事实

- Pi 0.85.1 普通 prompt 的公开生命周期是 `input` 后执行 `before_agent_start`，随后 Agent 才发出 `agent_start` 和 `turn_start`。
- 当前 `handleBeforeAgentStart()` 调用 `tryClaimRecallRun(sessionId)`；后者要求由 `turn_start` 设置的 `currentTurnIndex`，没有该值就返回 `null`。
- 因此全新 Session 的第一条 prompt 在 Recall 门控处直接返回，后续 prompt 还可能使用上一轮 model-turn index。
- 当前生命周期单元/集成测试在调用 `handleBeforeAgentStart()` 前人工调用 `noteTurnStart()`，与真实顺序相反。
- 当前 packaged Pi acceptance 在真正检查 Recall 前发送 `first warmup question`，掩盖首轮缺陷。
- Pi 0.85.1 的 `InputEvent` 提供 `source` 以及流式期间的 `streamingBehavior: "steer" | "followUp"`。
- Pi 0.85.1 将流式期间的 queued `steer`/`followUp` 交给已运行的 Agent 队列，交付时不会再次发出 `before_agent_start`，因此当前公开 API 无法为它们安全追加新的 turn-specific system prompt。
- `turn_start.turnIndex` 当前也服务于 settled candidate extraction 的 source reference/scheduling，不能为修 Recall 而破坏提取逻辑。

# 预期正确行为

- 正常路径：`input` 为每条分别提交的普通用户输入分配当前 Session 内有界身份；`before_agent_start` 在任何 await 前原子认领该身份并执行一次 Recall。第一条 prompt 可召回，下一条普通 prompt 可再次召回；即使两条 prompt 文本完全相同，也因是两次提交而分别允许一次召回。
- 防重复路径：同一输入的并发回调、工具循环、自动重试和压缩重试不得触发第二次 Recall；无匹配、失败、超时或取消后，同一输入也不重试。
- 兜底路径：未经过 `input` 却到达 `before_agent_start` 的受支持路径，使用 Session ID、当前 leaf ID（或空 leaf 标记）和 expanded prompt 单向哈希形成不保存正文的稳定兜底身份；必须验证在 Pi 0.85.1 中同一请求稳定、后续已完成输入可区分。无法可靠构成时保守跳过，不得放开重复召回。
- queued 输入：识别 `steer`/`followUp`，但本任务不为其单独召回；它们不得使上一条输入重复召回，也不得覆盖或消耗下一条普通输入的召回资格。
- Session/开关：状态按真实 Session ID 隔离且有界；shutdown 取消在途 Recall 并拒绝晚注入；`/new`、`/resume`、`/fork` 不继承旧 claim；`/memory off` 不访问 Hindsight，重新 on 后下一条新普通输入恢复。
- 安全：只在 TUI 自动运行；Recall 仍只返回当前轮 `systemPrompt`，不返回/发送持久消息；不存用户 prompt 正文；现有 scope、identity、lifecycle、conflict、sensitive、bulk、条数和 token 过滤保持不变。
- 提取：`turn_start.turnIndex` 可继续用于 candidate extraction，但必须与 Recall input identity 完全分责；现有 settled extraction 不回归。

# Verify：自动化测试

- 编码 Agent 必须运行：受影响的 `tests/lifecycle.test.ts` 和 `tests/integration.test.ts`；与 Session on/off、命令状态及 packaged acceptance helper 直接相关的测试；完整 `npm test`；`npm run typecheck`；`npm run build`；`npm audit --omit=dev`；`npm pack --dry-run --json`；`git diff --check`；对 `src/`、`tests/`、`scripts/` 做 NUL 字节扫描。不得访问 live Hindsight 或真实 Memory SQLite。
- Pi 必须独立重跑：检查完整 Git diff 和范围；确认测试未被删除、跳过或放松；重跑受影响测试、完整 `npm test`、typecheck、build、production audit、pack dry-run、diff check 和 NUL 扫描；检查打包内容包含 `LICENSE`、`src/index.ts` 和本任务文档，不包含 `dist/`。
- 关键任务额外测试/独立复审：必须覆盖真实事件顺序的首轮、原子并发认领、相同文本的两个独立输入、no-match/failure/timeout 同输入不重试、新输入恢复、queued steer/followUp 不污染、Session 隔离/切换/shutdown 晚返回、off/on、非 TUI 零自动行为、Recall 非持久化和 extraction 回归；完成 Pi 检查和本机候选验收后，使用新的 Claude Code `review` 会话进行至少一路独立复审，不得 resume 编码会话。

# Verify：本机候选运行验收

- 是否改变运行行为：是；改变真实 Pi TUI 的自动 Recall 启动和去重行为，必须做 packaged real-Pi 黑盒验收。
- 运行方式：从当前工作区重新 build 和 pack，将候选安装/加载到隔离的临时 Pi Profile；使用真实 Pi 0.85.1 TUI、PTY 驱动、临时 SQLite、loopback Mock Hindsight 和 fake model/provider。不得从源码直接 import 冒充已安装候选。
- 本地依赖及数据库类型/版本：Node `>=22.19.0` 的内置 `node:sqlite`；Pi `0.85.1`；项目 loopback Mock Hindsight（模拟 Hindsight 0.8.3 所需接口）；临时文件型 SQLite。不得连接 `127.0.0.1:8888` 上用户正在使用的 live Hindsight。
- 构建或安装命令：使用仓库现有 `npm run build`、`npm pack`/packaged acceptance 流程和隔离 package 配置；执行时记录实际命令、候选 Git/工作区身份和 tarball SHA-256。
- 启动命令：使用 `scripts/acceptance-pi.mjs` 现有 PTY/真实 `pi` 入口，并仅做本任务严格必要的增强；所有参数和环境指向临时目录、fake provider 和 loopback Mock Hindsight。
- 业务就绪检查：Pi TUI 已加载当前 packed Extension；`memory` 命令和 acceptance probe 可用；临时 Profile/SQLite 创建成功；Mock Hindsight journal 可计数；fake provider 能证明模型请求是否看见 Recall block。
- 正式入口和核心黑盒业务场景：全新 Session 不发送 warmup，第一条用户问题直接命中合成 Profile Memory；观察一次 Recall route 和模型侧 Recall block；让该轮发生工具/继续执行并确认无第二次 Recall；回答 settled 后发送第二条普通问题并确认新增一次 Recall；重复相同文本并确认仍按新输入召回；执行 off/on；在流式期间各探测一次 steer/followUp，确认不重复、不持久化且不消耗后续普通输入。
- 必须检查的最终结果：首条 prompt 恰好一次 Recall；后续每条普通输入各至多一次；相同文本独立提交可分别 Recall；tool/retry/queued 行为没有额外 route；模型请求看见预期 Recall block；Session JSONL 不含 recalled memory block/body；临时 SQLite 不保存用户 prompt 或 Recall body；候选提取既有场景仍通过。
- 必须检查的日志：Mock Hindsight route journal、fake provider markers、PTY transcript（做路径/内容脱敏）、Pi Session JSONL、测试进程退出状态；不得出现 uncaught exception、未解释 timeout、重复 Recall、真实服务 URL 或敏感内容。
- 关键失败/边界/恢复场景：Recall no-match、provider 失败、4 秒 Recall timeout、Session shutdown 后 provider 晚返回、两个并发 callback、`/memory off`、重新 on、两个 Session 隔离、queued steer/followUp、下一条普通输入恢复；自动 retry/compaction retry 若现有 harness 可稳定触发则真实验收，否则必须由自动化生命周期测试明确覆盖并在交接中说明。
- 停止和清理命令：沿用 acceptance harness 的 `finally` 清理；退出 Pi，关闭 fake provider/Mock Hindsight，删除临时 `PI_CODING_AGENT_DIR`、Session、SQLite、package/cache 和合成项目目录。失败时仅在仓库外保留已脱敏证据并记录路径与清理责任。
- 测试数据准备与清理：只在临时 Profile Bank 中写入明确合成的命令格式偏好；使用随机临时 bank/document/Session identity；测试结束删除整个临时根目录。禁止读取、复制或变更用户真实记忆。
- 禁止连接的域名、数据库和环境：禁止外部网络、生产环境、用户真实 `~/.pi/agent/memory/pi-memory-hindsight.db`、用户 live Hindsight `http://127.0.0.1:8888`、任何非本次 loopback 随机端口服务，以及用户真实 Pi 配置目录。
- 环境缺失时的阻断条件：无法证明候选来自当前工作区、无法启动真实 Pi 0.85.1 TUI/PTY、无法隔离 `PI_CODING_AGENT_DIR`/SQLite/Mock Hindsight、无法证明未连接 live 服务、或无法检查 Session 非持久化时，必须标记本机验收受阻，不得用单元测试替代并宣称完成。

# 验收标准

- 新 Session 第一条符合条件的普通用户问题执行且仅执行一次 Recall，不再需要 warmup。
- 每条分别提交的普通输入最多一次 Recall；下一条输入重新具备资格；相同文本的两次独立提交不被错误合并。
- 同一输入的并发处理、工具循环、自动重试、压缩重试、no-match、失败和 timeout 均不产生第二次 Recall。
- `turn_start.turnIndex` 不再是 Recall 前置条件或 Recall identity，但 candidate extraction 的 turn source/scheduling 保持正确。
- queued `steer`/`followUp` 不单独 Recall、不重复旧 Recall、不持久化 Recall，也不消耗下一条普通输入资格；限制与文档一致。
- `/memory off|on`、Session shutdown/new/resume/fork、多窗口隔离和非 TUI mode gate 全部符合方案。
- Recall block 仅存在于当前请求的临时 system prompt；Session JSONL、SQLite 和 Hindsight 中没有新增 Recall body 或用户 prompt body。
- 现有 Recall 安全过滤、Bank/Project 隔离、预算、治理写入以及 settled candidate extraction 测试无回归。
- 编码 Agent 的验证、Pi 独立完整 diff/测试/打包检查、隔离 packaged Pi 黑盒验收及独立新会话复审全部通过，且没有未解释异常或范围外改动。
- 编码 Agent 自报、单元测试、进程存活或单独健康检查均不能单独构成完成。

# 禁止事项

- 禁止读取或输出凭证，禁止未经授权 SSH、外部网络或访问生产环境。
- 禁止读取、修改、暂存或删除用户自有 `.pi/memory.json`。
- 禁止访问或修改用户真实 Pi 配置、Memory SQLite 或 live Hindsight 数据。
- 禁止修改 Pi core、导入 Pi 内部 `dist/core/*`、使用 Provider payload hack，或将 Recall 内容写成持久化 Session/custom message。
- 禁止顺带实现 queued `steer`/`followUp` Recall、修改数据库 schema/Hindsight 协议或扩大治理业务范围。
- 禁止未经单独授权 commit、push、发布或部署。
- 禁止 rsync、scp、docker cp 或其他绕开 Git 的代码交付。
- 遇到范围冲突、前提错误或验证受阻时停止并报告，不静默改方案、换执行器或降低标准。
