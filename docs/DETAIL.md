# dsh-cred-ref · 凭据引用

## 功能

对话里只说**别名**，插件在宿主进程里解析凭据并远程执行，明文口令永不进入对话、系统提示词或服务端日志。

模型获得两个工具：

- `cred_exec(alias, command)` — 按别名在远端执行命令，只回传 stdout/stderr/退出码/耗时
- `cred_list()` — 列出别名、主机、端口、用户名、连接类型（**无口令**）

## 配置页凭据管理（UI）

插件详情页（Plugins → 凭据引用）内嵌凭据管理面板，**无需手改配置文件**：

- 清单表格：别名 / 主机 / 端口 / 用户 / 类型 / 口令（永远掩码）
- 「+ 添加凭据」表单：口令输入框为 password 类型；telnet 类型额外显示特权口令字段
- 每行「编辑」（口令留空 = 保留原口令）与两步确认「删除」
- 头部显示凭据文件路径与权限校验徽章（600 ✓ / 权限过宽告警）

UI 与 Host 走认证过的本地 RPC 通道（`/dsh-cred-ref` 的 list/upsert/delete），与 agent 工具共用同一套 CRUD 操作；写入为原子写（临时文件 600 → rename），保留文件头部注释。口令明文只在该本地通道与文件内流动，清单接口永不返回明文。

## 侧边栏面板（独立开关，v1.1.0）

配置页底部「侧边栏面板」开关（默认**关**）开启后，侧边栏出现「凭据管理」导航行（镂空盾牌图标），点击即在全局面板中完成增删改查，无需再进插件配置页：

- 面板形态与配置页完全一致（同一共享组件）：标题 + 权限徽章 + 路径 + 七列表格（口令掩码）+ 编辑/删除 + 添加 + 说明文案；头部多一个「关闭面板」= 关开关
- 开关状态持久化在 `<credsPath>.ui.json`（原子写、600、损坏视为关）；刷新/重启后保持
- 关闭时侧边栏导航行与面板体**都不注册**；配置页入口与行为不受影响
- 侧边栏与配置页共用同一 Host RPC 与同一份凭据文件，不存在第二套写入逻辑
- 类型切换 ssh↔telnet 时端口自动随动 22↔23（仍可手改）

## 凭据文件

默认 `~/.dsh/creds/servers.yaml`（配置项 `credsPath` 可改），**权限必须 600**，权限过宽时插件拒绝加载。格式为严格 YAML 子集（顶层=别名，二层两空格缩进字段）：

```yaml
server-a:
  host: 192.0.2.10
  port: 22
  user: root
  password: "口令"
  kind: ssh          # ssh（默认，省略即 ssh）或 telnet

switch-a:
  host: 192.0.2.2
  port: 23
  user: share
  password: "登录口令"
  enable: "特权口令"  # telnet 可选
  kind: telnet
```

字段：`host` / `port`（默认 22）/ `user` / `password` / `enable`（仅 telnet）/ `kind`。其它字段、其它写法一律报错，宁可失败不猜。

## 连接方式

- **ssh**：宿主进程 spawn `sshpass -e ssh`，口令经 `SSHPASS` 环境变量传递（不进命令行，`ps` 看不到）。需要 sshpass：`brew install esolitos/ipa/sshpass`。主机密钥 `accept-new`。
- **telnet**：宿主进程内裸 socket 交互（Cisco IOS 提示符风格：Username/Password → 可选 enable → 命令 → 提示符）。无 pty 依赖。

## guard（默认开启，`guard: false` 可关）

`ctx.tools.guard()` 单调硬拒绝：除 `cred_exec`/`cred_list` 外，任何工具调用的参数里出现凭据文件路径或其目录（含 `~` 写法）→ deny。这是真实边界：模型想用 bash/read 绕过工具直读凭据文件会被拦下。

## 配置（cordis.patch.yml 行 config）

| 键 | 默认 | 说明 |
|---|---|---|
| `credsPath` | `~/.dsh/creds/servers.yaml` | 凭据文件路径，支持 `~` |
| `guard` | `true` | 路径硬拒绝开关 |
| `timeoutMs` | `60000` | 单次远程执行超时 |
| `maxOutputBytes` | `65536` | 单路输出截断上限 |

## 限制（诚实边界）

1. 防不住用户**自己**往对话里粘贴口令——那在插件生效之前。
2. telnet 交互按 Cisco IOS 提示符匹配，其它厂商设备可能需要调整正则。
3. 工具进程与用户同 UID：guard 挡的是工具调用通道，不是操作系统级的访问控制。
4. Windows PowerShell Remoting（pwsh）暂未实现，需另行扩展 kind。
