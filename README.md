# dsh-agent-restart

让 DeepSeek Harness（DSH NEXT 桌面版）在 agent 自己重启之后，能自动接着把没做完的事做完。

## 它解决什么问题

重启会杀掉当前回合，而且新回合只有被触发才会开始。普通做法要么靠人再开口，要么丢上下文重来。这个插件把重启做成流程的一部分：

- 重启前记下待办，重启后自动开一个新回合接着做，不需要用户重述。
- 只对 agent 自己触发的重启生效；用户手动关闭再打开应用，什么都不做。

## 兼容性

- 适配 DSH NEXT 桌面版 `2.0.17-next`（附带的 `@deepseek-ai/*` 为 `0.2.0-rc.2`）。
- 仅 Windows：重启依赖 PowerShell 与 WMI。
- 使用的是宿主上下文里的会话服务（`sessionController`、`sessions`）来排续跑消息；DSH 升级后这些内部接口可能变化，升级后需要重新验证。插件不承诺兼容旧版本 DSH，遇到不兼容会如实报错，不会静默失败。

## 功能

### 1. 重启工具 `restart_harness`

- 写重启日志（原因、待办、语音状态、会话 id），生成外部助手脚本。
- 用 WMI 创建助手进程，让它脱离应用进程树：等几秒、杀掉应用、等进程退干净、写一次性标记、再拉起应用。
- 拉起后检查 `restart.log` 确认助手进程是否真的启动；没启动就按失败处理，不谎报成功。

### 2. 重启后自动续跑

- 应用就绪（插件加载）后 5 秒，给会话排一条来源为 `restart` 的消息，开一个新回合继续做。
- 只排一次，不建目标、不标完成、不注入系统提示；失败每 3 秒重试，最多 6 次。
- 界面上显示为“收到执行请求”的系统提示，不是用户发言。

### 3. 与语音插件的文件交接

- 重启前记下语音是否开着，启动时写 `voice-resume.json`。
- 语音插件（`dsh-voice-mode-desktop`）自己读这个文件决定要不要自动恢复语音；两个插件可以独立安装，互不依赖。

## 为什么这样设计

- 外部助手进程 + WMI：这是本机验证过唯一可靠的重启方式，不依赖应用内拿不到的 Electron 对象。
- 一次性续跑：续跑只需要接一次，干完自然结束，不需要目标、轮次上限或完成标记这些额外机制。
- 文件交接：两个插件职责分开，重启插件不碰语音逻辑，语音插件不碰重启逻辑。

## 为什么不用应用内接口、也不用社区重启插件

应用内直接重启（Electron 的 relaunch）看起来最干净，但在 DSH 桌面版里这条路走不通：插件跑在宿主子进程里，拿不到 Electron 的 app 对象；渲染层倒是有重启命令，但要弹原生确认框，而且必须经由界面层转发。想绕开确认框就得改 DSH 主进程的代码，那是平台核心，升级会覆盖或冲突，不值得。

社区的重启插件也评估过：它们自己带一个看门狗进程和一条带 token 的 HTTP 路由，等于把外部进程再包一层，零件更多，还要跟着 DSH 版本做适配，代价比收益大。

所以这里用外部助手进程 + WMI：助手脱离应用进程树，是这台机器上唯一验证可靠的重启方式；不改 DSH 核心，插件自己可以独立升级。

## 执行流程

1. agent 调用 `restart_harness(reason, pending)`，插件写 `restart-journal.json`（原因、待办、语音状态、会话 id）。
2. 插件生成外部助手脚本，用 WMI 创建助手进程（脱离应用进程树，应用被杀时它不会跟着死）。
3. 助手等待几秒 → 强杀 `DSH NEXT` → 等进程退干净 → 写一次性标记 `agent-restart.flag` → 拉起应用。
4. 新进程启动：插件看到标记才读 journal（用户手动开应用没有标记，不触发）；写 `voice-resume.json` 交给语音插件，然后删标记。
5. 应用就绪 5 秒后，插件给会话排一条来源为 `restart` 的续跑消息，开一个新回合。
6. agent 接着把待办做完并汇报；journal 状态变成 `continued`。

## 安装

要求：Windows、DSH NEXT 桌面版 `2.0.17-next`、系统自带 PowerShell 与 WMI。

方式 A（推荐）：

1. 在 DSH profile 里安装：`@nutshelllee/dsh-agent-restart`。
2. 在 profile 的 `cordis.patch.yml` 里插入：`- id: agent-restart, name: "@nutshelllee/dsh-agent-restart"`。
3. 重启 DSH，工具列表里会出现 `restart_harness`。

方式 B（本地开发）：把本仓库目录链接到 profile 的 `node_modules/@nutshelllee/dsh-agent-restart`，再按上面第 2、3 步操作。

## 已知限制

- 重启本身需要一条能脱离应用进程树的外部路径；宿主进程里直接 spawn 在本机不可靠，工具会如实返回失败并提示改用外部 pwsh 发 WMI 调用。
- 仅 Windows。
- 语音自动恢复只有装了语音插件才生效。

## 安装（本地开发）

1. 把本目录链接进 profile 的 `node_modules/@nutshelllee/dsh-agent-restart`。
2. 在 profile 的 `cordis.patch.yml` 里插入 `- id: agent-restart, name: "@nutshelllee/dsh-agent-restart"`。
3. 重启 DSH。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
