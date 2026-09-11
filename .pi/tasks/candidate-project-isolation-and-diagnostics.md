# 任务目标

修复 Candidate 的项目隔离与失败提示：错误项目看不到也不能修改其他项目 Candidate，所有失败显示安全、明确、可本地化的原因。

# Risk

- 类型：关键任务
- 判断理由：涉及跨项目授权边界、Candidate 状态机、审批/拒绝写操作和 Provider 写入前置条件；错误实现可能误拒绝、误改或误写其他项目记忆。
- 关键契约与升级触发条件：Candidate scope/project identity 隔离、审批 CAS、失败重试、Provider 零 I/O、正文安全与 body-free audit 均不可弱化。若需要 DB migration、改变候选身份模型、扩展配置格式或修改 Hindsight 契约，立即停止并报告。

# Scope

- 当前基线：`e4fa97d2640b5806379ad90e092664a1a5ccccad`；工作区在编码前仅有用户自有未跟踪 `.pi/memory.json`，以及 Pi 新增的本任务 decision/task 文档。
- 允许改动：`src/db/candidates-repository.ts`（仅确有需要时）、`src/governance/candidate-service.ts`、`src/ui/candidate-reviewer.ts`、`src/commands/memory-command.ts`、`src/i18n/messages.ts`、相关 `tests/**`、`scripts/acceptance-pi-candidate-project-isolation.mjs`、`README.md`、`docs/product-requirements.md`、`docs/memory-policy.md`、本 decision/task 文档。用户已于 2026-09-11 授权 commit、push 和 GitHub Release，因此发布准备阶段另允许仅将 `package.json`、`package-lock.json` 版本从 `0.2.0` 提升为补丁版本 `0.2.1`，并将 README 当前正式版本安装示例更新为 `v0.2.1`。
- 禁止改动：`.pi/memory.json`、live Pi 配置、live SQLite/Hindsight 数据、Hindsight bank/document 契约、依赖版本、除上述 `0.2.1` 补丁版本准备外的 package 元数据、无关功能。

# 执行器与授权

- 执行器：Claude Code
- 请求模型：`claude-sonnet-5`
- 编码授权：已获得（用户于 2026-09-11 明确要求落地并指定 Claude Code）
- 权限范围：只允许完成本任务代码、测试与相关文档；禁止 commit、push、publish、deploy。

# 真实业务背景

用户在非 `ai-workbench` 目录打开全局 Candidate reviewer，看到了 `ai-workbench` Project Candidate。审批在 Hindsight I/O 前因 cwd Project 不可用而失败，但 TUI 只显示“候选操作未完成”。当前直接拒绝还可能跨项目修改 Candidate。

# 已确认的源码事实

- `CandidatesRepository.listReviewable()` 未按 project identity 过滤。
- `listCandidates()`、custom reviewer 和 `/memory candidates list` 使用该全局结果。
- reviewer 对 approve/edit-approve 的所有非成功结果使用 `candidates.action_failed`。
- command 路径已有 `candidateOutcomeMessage()`，但返回未经统一本地化的 `reason`。
- `approveCandidate()` 在调用 `remember`/`replace` 解析 cwd Project 前先 `tryClaimForApproval()`。
- `rejectCandidate()` 没有 cwd/project 参数或 Project 授权检查。
- Candidate 已有 `project_identity`、`failure_code`，无需为本方案新增 schema。

# 预期正确行为

- 正常路径：Profile Candidate 在所有 cwd 可见可操作；Project Candidate 只在 enabled 且 identity 精确匹配的 cwd 可见可操作；匹配项目可重试已有 `failed/project_unavailable` Candidate。
- 列表路径：custom reviewer、文本 list、expired view、冲突物化和批量拒绝只处理当前上下文可见 Candidate。
- ID 路径：approve/reject/edit-approve 即使手工输入其他项目 ID，也在任何 Candidate/Conflict/Audit/Operation/Memory mutation 和 Provider I/O 前拒绝。
- 诊断：TUI 与命令共用安全本地化结果；明确区分 project unavailable/mismatch、not found/already decided、validation/stale target、retryable/in-progress/uncertain、success。
- 详情：Project Candidate 显示 project identity；显示 state；有 failure_code 时仅通过 allowlist 显示本地化说明。视图标题说明 Profile-only 或 Profile + 当前 Project。
- 安全：不展示原始 Provider body、header、凭证、路径或无界异常；不削弱二次 expectedProjectIdentity 检查。

# Verify：自动化测试

- 编码 Agent 必须运行：受影响测试；`npm test`；`npm run typecheck`；`npm run build`；`npm pack --dry-run`；`npm audit --omit=dev`；`git diff --check`；`src/` 和 `tests/` NUL scan。
- Pi 必须独立重跑：新增/受影响测试、完整 `npm test`、typecheck、build、pack dry-run、audit、diff check、NUL scan。
- 关键任务额外测试/独立复审：覆盖 disabled/mismatch/matching Project、Profile、expired、direct ID approve/reject/edit、无状态/正文/failure_code/冲突/audit/operation/memory 副作用、Provider 零 I/O、正确项目重试、TUI/command 一致诊断；完成后使用全新 Claude Code review 会话独立复审。

# Verify：本机候选运行验收

- 是否改变运行行为：是。
- 运行方式：构建并 `npm pack`，安装/加载到脚本已有的完全隔离临时 Pi Profile、临时项目和 mock Hindsight；不得使用用户 live Profile 或 live Hindsight。
- 本地依赖及数据库类型/版本：Node `>=22.19.0`、Pi `0.85.1`、内置 `node:sqlite`、项目 mock Hindsight。
- 构建或安装命令：`npm run build` 后使用项目 `scripts/acceptance-pi.mjs` 的 packaged Pi TUI 方式；需要为本场景扩展 acceptance harness 时仅使用临时目录和合成 Candidate。
- 启动命令：由 `npm run acceptance:pi` / `scripts/acceptance-pi.mjs` 通过 PTY 启动真实 Pi TUI。
- 业务就绪检查：打包源码入口被真实 Pi 加载，memory command 注册，临时 DB 和 mock server 可用。
- 正式入口和核心黑盒业务场景：通过真实 `/memory candidates list`、`/memory candidates` 或 deterministic command，证明普通目录/Project A 不暴露 Project B，直接 ID 操作无副作用，Project B 可重试；失败提示不是笼统文案。
- 必须检查的最终结果：TUI 输出、临时 SQLite Candidate 状态/正文/failure_code、mock Hindsight route journal；所有资源来自当前候选包。
- 必须检查的日志：PTY 结果与 mock route journal 无未解释错误或跨项目 Provider mutation。
- 关键失败/边界/恢复场景：disabled Project、mismatched Project、matching Project retry、Profile Candidate、direct ID reject/edit/approve。
- 停止和清理命令：acceptance harness 必须停止 Pi/mock server 并删除临时 profile/project/package 目录。
- 测试数据准备与清理：仅合成 Candidate，位于临时 SQLite；结束后删除。
- 禁止连接的域名、数据库和环境：任何非 loopback 网络、用户 `~/.pi/agent` live DB、用户 live Hindsight、远程 Hindsight/模型服务。
- 环境缺失时的阻断条件：无法从当前 tarball 加载真实 Pi TUI、无法隔离 Profile/DB/mock server，或无法证明没有 live 数据访问时，标记本机验收受阻，不以单元测试替代。

# 验收标准

- 错误/未启用 Project cwd 不显示其他 Project Candidate。
- direct ID approve/reject/edit-approve 均无法跨项目修改，且无 Provider I/O 和治理副作用。
- 匹配 Project 可以查看并重试原有 failed Candidate。
- Profile Candidate 行为不退化。
- custom reviewer、文本 list、expired 与 batch 都使用同一隔离规则。
- TUI 和 command 显示明确、安全、本地化原因；Project/状态/allowlisted failure detail 可见。
- 无 DB migration、无 live 配置或 live Hindsight 修改。
- Pi 独立自动化、packaged TUI 黑盒验收和独立复审全部通过。
- 编码 Agent 自报、单元测试、进程/容器存活均不能单独构成完成。

# 禁止事项

- 禁止读取、修改、暂存或输出 `.pi/memory.json` 内容。
- 禁止读取或输出凭证，禁止未经授权 SSH 或访问生产环境。
- 禁止未经单独授权 commit、push、publish 或 deploy。
- 禁止 rsync、scp、docker cp 或其他绕开 Git 的代码交付。
- 禁止连接或修改用户 live Hindsight 和 live Memory SQLite。
- 遇到范围冲突、前提错误或验证受阻时停止并报告，不静默改方案或降低标准。
