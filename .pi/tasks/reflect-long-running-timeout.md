# 任务目标

彻底修复 `/memory reflect` 复用 10 秒普通 HTTP 超时而误报失败的问题：Reflect 独立使用 180 秒上限，保留用户取消，并提供本地化、脱敏且可理解的失败信息。

# Risk

- 类型：普通任务
- 判断理由：局部改变手动、只读 Reflect 请求的等待与错误展示，不改变认证、删除、并发状态机、数据库迁移或正式记忆写入。
- 关键契约与升级触发条件：不得改变 Recall/普通请求的 10 秒上限、mutation lease、存储治理、安全过滤和 mode gate；若实现需要触碰这些契约，停止并升级为关键任务重新确认。

# Scope

- 当前基线：`717c12e76110cc6a2f58ee1e7657a36c9db7bce7`，编码前新增本任务与 `docs/decisions/reflect-long-running-timeout.md` 两个方案文件。
- 允许改动文件/目录：`src/provider/`、`src/governance/reflect-service.ts`、`src/i18n/messages.ts`、相关 `tests/`、`README.md`、`docs/`、`.pi/tasks/reflect-long-running-timeout.md`、`HANDOVER.md`。
- 禁止改动文件/目录：Pi 全局配置、用户真实 SQLite、既有 Hindsight Bank、package 依赖/lockfile（除非先停止说明必要性）、无关功能。

# 执行器与授权

- 执行器：Claude Code
- 请求模型：`claude-sonnet-5`
- 编码授权：已获得（用户 2026-09-10 明确授权按方案处理）
- 权限范围：仅本任务允许范围；禁止 commit、push、发布和部署。

# 真实业务背景

真实 Hindsight 0.8.3 中简单 Reflect 已耗时 10.76–14.19 秒并最终成功，但扩展通用 HTTP 客户端在 10 秒取消，用户只看到 `Error: Reflect failed`。未来记忆更多时可能更久。

# 已确认的源码事实

- `src/provider/http-client.ts` 的 `PROVIDER_HTTP_TIMEOUT_MS=10_000`，构造器会将 requested timeout clamp 到该上限。
- `HindsightAdapter` 共用一个 `HttpClient`；`reflect()` 没有单次请求超时策略。
- `reflectMemory()` 将所有 `result.ok === false` 统一映射为 `reflect.failed`。
- `ctx.signal` 已传入 adapter，可用于 Esc/session shutdown 取消。
- Hindsight `/reflect` 返回 `{ text: string }`，Reflect 手动确认、只读、不自动保存。

# 预期正确行为

- 正常路径：Reflect 可等待最多 180 秒；耗时 10–180 秒的合法响应正常展示。
- 关键异常/边界路径：超过 180 秒显示明确、本地化超时；外部取消立即结束并保持取消语义；HTTP/网络/畸形响应显示脱敏且可理解的失败；普通 Recall/其他请求仍为 10 秒。

# Verify：自动化测试

- 编码 Agent 必须运行：相关 reflect/http client/commands 测试、`npm run typecheck`。
- Pi 必须独立重跑：`npm test`、`npm run typecheck`、`npm run build`、`npm pack --dry-run`、`npm audit --omit=dev`、`npm run acceptance:pi`。
- 关键任务额外测试/独立复审：本任务初判普通；仍安排一路独立 review，重点检查超时分层、取消语义和错误脱敏。

# Verify：本机候选运行验收

- 是否改变运行行为：是。
- 运行方式：从当前工作区构建后，使用真实 Pi TUI + 本机 Docker Hindsight 0.8.3。
- 本地依赖及数据库类型/版本：现有 loopback Hindsight 0.8.3；不得输出密钥。
- 构建或安装命令：`npm run build`；Pi 现有 Git package 指向当前仓库源码，验收前核实加载候选。
- 启动命令：真实 `pi` TUI。
- 业务就绪检查：`GET http://127.0.0.1:8888/health` healthy，`/version` 为 0.8.3。
- 正式入口和核心黑盒业务场景：在真实 Pi TUI 执行 `/memory reflect profile 总结我已记录的个人偏好。`，确认提示后等待结果。
- 必须检查的最终结果：不在 10 秒时报错；获得非空总结；耗时与 Hindsight 日志对应。
- 必须检查的日志：Hindsight Reflect Start/Complete，无未解释异常；不得在交接复制完整记忆正文。
- 关键失败/边界/恢复场景：自动化测试证明 10–180 秒成功、180 秒超时、外部取消、Recall 仍为 10 秒。
- 停止和清理命令：退出测试 Pi；Reflect 不写数据，无测试记忆需清理。
- 测试数据准备与清理：仅读取现有 Profile 记忆并经用户已授权的功能调用；不新建、更新或删除记忆。
- 禁止连接的域名、数据库和环境：除当前 loopback Hindsight 外不得连接其他 Hindsight/生产环境。
- 环境缺失时的阻断条件：Hindsight 不健康、版本不符、无法证明候选被加载、确认 UI 无法驱动，则标记受阻，不以单测替代。

# 验收标准

- Reflect 使用独立 180 秒上限，普通请求仍使用 10 秒。
- 超过旧 10 秒但未超过 180 秒的 Reflect 成功。
- 用户取消及时生效。
- 超时和一般失败信息本地化、脱敏且可区分。
- 所有计划测试与真实 Pi TUI Reflect 验收通过。
- 编码 Agent 自报、单元测试、进程/容器存活均不能单独构成完成。

# 禁止事项

- 禁止读取或输出凭证，禁止未经授权 SSH 或访问生产环境。
- 禁止未经单独授权 commit、push 或部署。
- 禁止 rsync、scp、docker cp 或其他绕开 Git 的代码交付。
- 遇到范围冲突、前提错误或验证受阻时停止并报告，不静默改方案或降低标准。
