/**
 * dsh-cred-ref — 凭据引用插件（DeepSeek Harness Host plugin）。
 *
 * 设计（与设计稿一致）：
 *  1. 明文凭据只存本地 YAML 文件（chmod 600），宿主进程读取。
 *  2. 模型可见两个工具：cred_exec(alias, command) / cred_list()——
 *     参数与返回值里只有别名、主机、用户名和命令输出，永远没有口令。
 *  3. SSH：spawn sshpass -e ssh，口令走 SSHPASS 环境变量（不进 argv，
 *     ps 不可见）。telnet：宿主进程内裸 socket 交互式登录（无 pty 依赖）。
 *  4. tools.guard() 硬拒绝：任何其它工具的参数里出现凭据路径 → deny。
 *     guard 单调同步，后注册的监听器也无法翻案。
 *
 * 工程约束（来自已验证的 harness 事实）：
 *  - inject 必须挂在回调上（Object.assign(run, {inject})），
 *    不能作为兄弟命名导出——否则 "cannot get property tools without inject"。
 *  - 本插件零 @deepseek-ai 依赖：工具注册用原始 ToolDefinition 对象
 *    （name/description/parameters/output/execute），不需要 defineTool。
 *  - timeoutMs 在 ToolDefinition 上是声明式的，注册表不强制；本插件在
 *    execute 里自己实现协作超时并转发 exec.signal。
 *
 * @module @hyll/dsh-cred-ref
 */

import { spawn } from 'node:child_process'
import { readFileSync, statSync, writeFileSync, renameSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { connect as netConnect } from 'node:net'

/** Cordis 插件名（诊断用）。 */
export const name = 'dsh-cred-ref'

/**
 * 行配置形状（文档化而非 schema 校验；缺省在 resolveSettings）。
 * @typedef {object} CredRefConfig
 * @property {string} [credsPath] 凭据文件路径（支持 ~）。
 * @property {boolean} [guard] 启用路径硬拒绝；默认 true。
 * @property {number} [timeoutMs] 单次远程执行超时；默认 60000。
 * @property {number} [maxOutputBytes] 单路输出上限字节；默认 65536。
 */

const DEFAULT_CREDS_PATH = '~/.dsh/creds/servers.yaml'
const DEFAULT_TIMEOUT_MS = 60000
const DEFAULT_MAX_OUTPUT = 65536
const SSH_CONNECT_TIMEOUT_S = 10

/** 应用缺省值并归一化配置。 */
function resolveSettings(config) {
  const raw = config ?? {}
  const credsPath = typeof raw.credsPath === 'string' && raw.credsPath.length > 0
    ? raw.credsPath
    : DEFAULT_CREDS_PATH
  return {
    credsPath: expandHome(credsPath),
    guard: raw.guard !== false,
    timeoutMs: Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0 ? raw.timeoutMs : DEFAULT_TIMEOUT_MS,
    maxOutputBytes: Number.isFinite(raw.maxOutputBytes) && raw.maxOutputBytes > 0 ? raw.maxOutputBytes : DEFAULT_MAX_OUTPUT
  }
}

/** 展开 ~ 前缀。 */
function expandHome(p) {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return homedir() + p.slice(1)
  return p
}

/* ---------- 凭据文件：严格 YAML 子集 ---------- */

const FIELD_KEYS = new Set(['host', 'port', 'user', 'password', 'enable', 'kind'])
const KINDS = new Set(['ssh', 'telnet'])

/**
 * 解析严格 YAML 子集：顶层 `别名:`，二层缩进 `字段: 值`。
 * 不支持的行直接抛错——凭据文件宁可失败也不静默猜。
 * @returns {Map<string, object>} alias -> {host,port,user,password,enable,kind}
 */
function parseCredsYaml(text) {
  const map = new Map()
  let current
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (/^\S/.test(line)) {
      const top = line.match(/^(\S[^:]*):\s*$/)
      if (!top) throw new Error(`凭据文件第 ${i + 1} 行不是合法的别名行："${line}"（应为 \`别名:\`）`)
      current = { port: 22, kind: 'ssh' }
      map.set(top[1], current)
      continue
    }
    const field = line.match(/^\s+([A-Za-z]+):\s*(.*)$/)
    if (!field || current === undefined) {
      throw new Error(`凭据文件第 ${i + 1} 行不是合法的字段行："${line}"（应为两空格缩进的 \`字段: 值\`）`)
    }
    const key = field[1]
    if (!FIELD_KEYS.has(key)) throw new Error(`凭据文件第 ${i + 1} 行出现未知字段 "${key}"`)
    const value = unquote(field[2].trim())
    if (key === 'port') {
      const port = Number.parseInt(value, 10)
      if (!(port > 0 && port < 65536)) throw new Error(`别名 "${aliasOf(map, current)}" 的 port 非法："${value}"`)
      current.port = port
    } else if (key === 'kind') {
      if (!KINDS.has(value)) throw new Error(`别名 "${aliasOf(map, current)}" 的 kind 非法："${value}"（仅 ssh|telnet）`)
      current.kind = value
    } else {
      current[key] = value
    }
  }
  for (const [alias, e] of map) {
    if (typeof e.host !== 'string' || e.host.length === 0) throw new Error(`别名 "${alias}" 缺少 host`)
    if (typeof e.user !== 'string' || e.user.length === 0) throw new Error(`别名 "${alias}" 缺少 user`)
    if (typeof e.password !== 'string' || e.password.length === 0) throw new Error(`别名 "${alias}" 缺少 password`)
  }
  return map
}

/** 反查 map 里指向 entry 的别名（仅错误信息用）。 */
function aliasOf(map, entry) {
  for (const [alias, e] of map) if (e === entry) return alias
  return '?'
}

/** 去掉成对引号；双引号内反转义 \" 与 \\（与 yamlQuote 互逆）。 */
function unquote(v) {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(["\\])/g, '$1')
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1)
  return v
}

/**
 * 读取并校验凭据文件。权限不是 600 时拒绝加载——与
 * dsh-credentials-local 同样的纪律：凭据文件他人可读就不该被使用。
 */
function loadCreds(settings) {
  let st
  try {
    st = statSync(settings.credsPath)
  } catch {
    throw new Error(`凭据文件不存在：${settings.credsPath}（请按 docs/DETAIL.md 的格式创建，chmod 600）`)
  }
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    throw new Error(`凭据文件权限过宽（${(st.mode & 0o777).toString(8)}）：${settings.credsPath}，请 chmod 600`)
  }
  return parseCredsYaml(readFileSync(settings.credsPath, 'utf8'))
}

/* ---------- 远程执行 ---------- */

/**
 * SSH 执行：口令经 SSHPASS 环境变量传给 sshpass，不进 argv。
 * @returns {Promise<{ok:boolean, exitCode:number, durationMs:number, stdout:string, stderr:string}>}
 */
function execSsh(entry, command, timeoutMs, signal, maxOut) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(
      'sshpass',
      [
        '-e', 'ssh',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`,
        '-o', 'NumberOfPasswordPrompts=1',
        '-p', String(entry.port),
        `${entry.user}@${entry.host}`,
        command
      ],
      { env: { ...process.env, SSHPASS: entry.password } }
    )
    settle(child, started, timeoutMs, signal, maxOut, 'ssh', resolve)
  })
}

/**
 * Telnet 执行（Cisco IOS 风格交互）：宿主进程内裸 socket，无 pty。
 * 流程：等 Username:/Password: → 登录 →（如配了 enable 且提示符是 >）进特权 → 发命令 → 等提示符。
 */
function execTelnet(entry, command, timeoutMs, signal, maxOut) {
  return new Promise((resolve) => {
    const started = Date.now()
    const deadline = started + Math.min(timeoutMs, 120000)
    let buffer = ''
    let stdout = ''
    let stderr = ''
    let sentCommand = false
    let phase = 'login' // login -> enabling -> command -> done
    let killed = false
    let timer = null

    const socket = netConnect({ host: entry.host, port: entry.port })
    socket.setEncoding('utf8')

    const finish = (ok, exitCode, errText) => {
      if (timer !== null) clearTimeout(timer)
      socket.destroy()
      resolve({ ok, exitCode, durationMs: Date.now() - started, stdout: cap(stdout, maxOut), stderr: cap(errText, maxOut) })
    }

    const armDeadline = () => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => { killed = true; finish(false, 124, 'telnet: 超时（提示符匹配失败或登录流程未完成）') }, deadline - Date.now())
    }
    armDeadline()
    const onAbort = () => { killed = true; finish(false, 130, 'telnet: 已取消') }
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })

    const send = (line) => socket.write(line + '\r\n')

    socket.on('error', (error) => { if (!killed) finish(false, 1, `telnet: 连接失败 ${error.message}`) })
    socket.on('close', () => { if (!killed && phase !== 'done') finish(false, 0, '') })

    socket.on('data', (chunk) => {
      buffer += chunk
      if (buffer.length > 8192) buffer = buffer.slice(-8192)

      if (phase === 'login') {
        if (/[Uu]sername\s*[#:]*\s*$/.test(buffer)) { send(entry.user); buffer = ''; return }
        if (/[Pp]assword\s*[#:]*\s*$/.test(buffer)) {
          send(entry.password)
          buffer = ''
          phase = entry.enable !== undefined ? 'enabling' : 'command'
          return
        }
        if (/[Pp]assword\s*incorrect/.test(buffer)) { killed = true; finish(false, 1, 'telnet: 密码错误'); return }
        return
      }

      if (phase === 'enabling') {
        if (/[Pp]assword\s*[#:]*\s*$/.test(buffer)) { send(entry.enable); buffer = ''; phase = 'command'; return }
        if (/[>#]\s*$/.test(buffer) && !sentCommand) { // 无需 enable 密码直接给了提示符
          send('enable')
          return
        }
        return
      }

      if (phase === 'command') {
        if (!sentCommand) {
          // 登录后的空闲提示符（行尾 # 或 > 且已收到至少一个换行）
          if (/\n[^\n]*[#>]\s*$/.test(buffer) || (buffer.length > 0 && /[#>]\s*$/.test(buffer))) {
            send(command)
            sentCommand = true
            buffer = ''
            return
          }
        } else if (/#\s*$/.test(buffer) && buffer.includes('\n')) {
          stdout = buffer.replace(/^\s*\n/, '')
          phase = 'done'
          if (signal !== undefined) signal.removeEventListener('abort', onAbort)
          finish(true, 0, '')
        }
      }
    })
  })
}

/** 公共收尾：截流、超时、取消、退出码。 */
function settle(child, started, timeoutMs, signal, maxOut, label, resolve) {
  let stdout = ''
  let stderr = ''
  let killed = false
  let timer = null

  const finish = (exitCode) => {
    if (timer !== null) clearTimeout(timer)
    const truncated = stdout.length > maxOut || stderr.length > maxOut
    resolve({
      ok: exitCode === 0,
      exitCode,
      durationMs: Date.now() - started,
      stdout: cap(stdout, maxOut),
      stderr: cap(stderr, maxOut) + (truncated ? '\n(输出已截断)' : '')
    })
  }

  timer = setTimeout(() => {
    killed = true
    child.kill('SIGKILL')
    stderr += `\n${label}: 超时 ${timeoutMs}ms，进程已终止`
  }, timeoutMs)

  const onAbort = () => {
    if (!killed) { killed = true; child.kill('SIGKILL'); stderr += `\n${label}: 已取消` }
  }
  if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })

  child.stdout?.on('data', (d) => { stdout += d })
  child.stderr?.on('data', (d) => { stderr += d })
  child.on('error', (error) => {
    if (timer !== null) clearTimeout(timer)
    resolve({ ok: false, exitCode: 127, durationMs: Date.now() - started, stdout: cap(stdout, maxOut), stderr: `${label}: ${error.message}（sshpass 是否在 PATH？brew install esolitos/ipa/sshpass）` })
  })
  child.on('close', (code) => {
    if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    finish(code === null ? 1 : code)
  })
}

/** 按字节上限截断。 */
function cap(s, maxOut) {
  if (s.length <= maxOut) return s
  return s.slice(0, maxOut) + '\n…(截断，共 ' + s.length + ' 字符)'
}

/* ---------- 工具注册 ---------- */

/** cred_exec 的模型可见描述。 */
const CRED_EXEC_DESC = [
  '按别名在远程主机执行命令并回传输出。凭据（主机/用户/口令）由宿主进程本地解析，口令永远不会出现在参数或结果里。',
  '别名先用 cred_list 查询。支持 ssh 与 telnet（网络设备）。',
  '参数 command 是要在远端执行的整条命令；不要在 command 里拼接任何口令。'
].join(' ')

/** @type {import('@deepseek-ai/dsh-tools').ToolDefinition} */
const credExecDefinition = {
  name: 'cred_exec',
  description: CRED_EXEC_DESC,
  parameters: {
    type: 'object',
    properties: {
      alias: { type: 'string', description: '凭据别名（来自 cred_list）' },
      command: { type: 'string', description: '要在远端执行的整条命令' },
      timeoutMs: { type: 'integer', description: '可选：本次执行超时毫秒（默认 60000，上限 120000）' }
    },
    required: ['alias', 'command'],
    additionalProperties: false
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        exitCode: { type: 'integer' },
        durationMs: { type: 'integer' },
        stdout: { type: 'string' },
        stderr: { type: 'string' }
      },
      required: ['ok', 'exitCode', 'durationMs', 'stdout', 'stderr'],
      additionalProperties: false
    },
    render: (_args, value) => [{ type: 'text', text: renderExecResult(value) }]
  },
  isConcurrencySafe: () => true,
  async execute(args, exec) {
    const { alias, command } = requireStrings(args, ['alias', 'command'])
    const settings = SETTINGS
    const entry = loadCreds(settings).get(alias)
    if (entry === undefined) throw new Error(`未知别名 "${alias}"；先用 cred_list 查看可用别名`)
    const timeoutMs = clampTimeout(args?.timeoutMs, settings.timeoutMs)
    if (entry.kind === 'ssh') return execSsh(entry, command, timeoutMs, exec.signal, settings.maxOutputBytes)
    if (entry.kind === 'telnet') return execTelnet(entry, command, timeoutMs, exec.signal, settings.maxOutputBytes)
    throw new Error(`别名 "${alias}" 的 kind "${entry.kind}" 不受支持`)
  }
}

/** @type {import('@deepseek-ai/dsh-tools').ToolDefinition} */
const credListDefinition = {
  name: 'cred_list',
  description: '列出可用的凭据别名及主机、用户名、连接类型（不含口令）。连远程主机前先查别名。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    schema: {
      type: 'object',
      properties: {
        count: { type: 'integer' },
        aliases: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              alias: { type: 'string' },
              host: { type: 'string' },
              port: { type: 'integer' },
              user: { type: 'string' },
              kind: { type: 'string' }
            },
            required: ['alias', 'host', 'port', 'user', 'kind'],
            additionalProperties: false
          }
        }
      },
      required: ['count', 'aliases'],
      additionalProperties: false
    },
    render: (_args, value) => {
      const list = Array.isArray(value?.aliases) ? value.aliases : []
      const lines = list.map((e) => `  ${e.alias}  ${e.user}@${e.host}:${e.port}  (${e.kind})`)
      return [{ type: 'text', text: `可用凭据别名（${value?.count ?? list.length}）：\n${lines.join('\n')}` }]
    }
  },
  isConcurrencySafe: () => true,
  async execute() {
    const settings = SETTINGS
    const map = loadCreds(settings)
    const aliases = [...map.entries()].map(([alias, e]) => ({
      alias, host: e.host, port: e.port, user: e.user, kind: e.kind
    }))
    return { count: aliases.length, aliases }
  }
}

/** 工具 execute 内的参数抽取（arguments 已冻结但类型未窄化）。 */
function requireStrings(args, keys) {
  const out = {}
  for (const key of keys) {
    const v = args?.[key]
    if (typeof v !== 'string' || v.length === 0) throw new Error(`参数 ${key} 必须是非空字符串`)
    out[key] = v
  }
  return out
}

/** 每调用超时：默认取配置，允许模型下调，上限 120s。 */
function clampTimeout(requested, fallback) {
  const n = Number(requested)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(n, 120000)
}

/** cred_exec 结果的文本渲染。 */
function renderExecResult(value) {
  if (value === null || typeof value !== 'object') return String(value)
  const v = value
  const head = v.ok === true ? '✓ ' : '✗ '
  const parts = [`${head}${v.exitCode ?? '?'} (${v.durationMs ?? '?'}ms)`]
  if (typeof v.stdout === 'string' && v.stdout.length > 0) parts.push('stdout:\n' + v.stdout)
  if (typeof v.stderr === 'string' && v.stderr.length > 0) parts.push('stderr:\n' + v.stderr)
  return parts.join('\n')
}

/* ---------- 凭据 CRUD（配置页 UI 与 Host 共用同一套操作） ---------- */

/** 值一律双引号序列化，转义反斜杠与双引号。 */
function yamlQuote(v) {
  return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/** 提取文件头部注释块（保留用户注释）。 */
function headerOf(text) {
  const out = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.trim().startsWith('#')) out.push(line)
    else break
  }
  return out
}

/** 从 map 重新序列化（严格子集格式）。 */
function serializeCreds(map, header) {
  const lines = [...header]
  if (lines.length > 0 && lines[lines.length - 1].trim() !== '') lines.push('')
  for (const [alias, e] of map) {
    lines.push(alias + ':')
    lines.push('  host: ' + e.host)
    lines.push('  port: ' + e.port)
    lines.push('  user: ' + e.user)
    lines.push('  password: ' + yamlQuote(e.password))
    if (e.enable !== undefined && e.enable !== '') lines.push('  enable: ' + yamlQuote(e.enable))
    lines.push('  kind: ' + e.kind)
    lines.push('')
  }
  return lines.join('\n')
}

/** 原子写：临时文件 600 → rename。 */
function atomicWrite(path, text) {
  const tmp = path + '.tmp-' + process.pid
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, path)
  chmodSync(path, 0o600)
}

/** 凭据库原子写（沿用 600）。 */
function atomicWriteCreds(settings, text) {
  atomicWrite(settings.credsPath, text)
}

/* ---------- UI 开关状态（侧边栏面板；与凭据同目录、同原子写纪律） ---------- */

/** 状态文件路径：凭据文件旁挂 .ui.json。 */
function uiStatePath(settings) {
  return settings.credsPath + '.ui.json'
}

/** 读开关状态；缺失/损坏一律视为关（fail-closed）。 */
function readUiState(settings) {
  try {
    const parsed = JSON.parse(readFileSync(uiStatePath(settings), 'utf8'))
    return { sidebarPanel: parsed?.sidebarPanel === true }
  } catch {
    return { sidebarPanel: false }
  }
}

/** 写开关状态（原子写 + 600），返回落盘后的状态。 */
function writeUiState(settings, input) {
  const next = { sidebarPanel: input?.sidebarPanel === true }
  atomicWrite(uiStatePath(settings), JSON.stringify(next, null, 2) + '\n')
  return readUiState(settings)
}

/** 读取现有 map；文件不存在时返回空 map 与空头部。 */
function readMapOrEmpty(settings) {
  let text = ''
  try { text = readFileSync(settings.credsPath, 'utf8') } catch { return { map: new Map(), header: [] } }
  return { map: parseCredsYaml(text), header: headerOf(text) }
}

/** 配置页视图：永不含口令明文。 */
function listView(settings) {
  let permsOk = true
  let exists = true
  try {
    const st = statSync(settings.credsPath)
    permsOk = process.platform === 'win32' || (st.mode & 0o077) === 0
  } catch { exists = false; permsOk = false }
  const { map } = exists ? readMapOrEmpty(settings) : { map: new Map() }
  const entries = [...map.entries()].map(([alias, e]) => ({
    alias, host: e.host, port: e.port, user: e.user, kind: e.kind, hasEnable: e.enable !== undefined && e.enable !== ''
  }))
  return { path: settings.credsPath, exists, permsOk, count: entries.length, entries }
}

const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 新增或更新一条凭据。password 为空且别名已存在 = 保留原口令。 */
function upsertCred(settings, input) {
  const raw = input ?? {}
  const alias = typeof raw.alias === 'string' ? raw.alias.trim() : ''
  if (!ALIAS_RE.test(alias)) throw new Error('别名非法：仅字母数字开头，可含 . _ -')
  const host = typeof raw.host === 'string' ? raw.host.trim() : ''
  if (host.length === 0) throw new Error('主机不能为空')
  const user = typeof raw.user === 'string' ? raw.user.trim() : ''
  if (user.length === 0) throw new Error('用户名不能为空')
  const port = raw.port === undefined || raw.port === '' ? 22 : Number.parseInt(raw.port, 10)
  if (!(port > 0 && port < 65536)) throw new Error('端口非法')
  const kind = raw.kind === undefined || raw.kind === '' ? 'ssh' : raw.kind
  if (!KINDS.has(kind)) throw new Error('kind 仅支持 ssh|telnet')
  const password = typeof raw.password === 'string' ? raw.password : ''
  const enable = typeof raw.enable === 'string' ? raw.enable : ''

  const { map, header } = readMapOrEmpty(settings)
  const existing = map.get(alias)
  if (existing === undefined && password.length === 0) throw new Error('新凭据必须填写口令')
  const entry = {
    host, port, user, kind,
    password: password.length > 0 ? password : existing.password,
    ...(enable.length > 0 ? { enable } : {})
  }
  map.set(alias, entry)
  atomicWriteCreds(settings, serializeCreds(map, header))
  return { alias, host, port, user, kind, hasEnable: enable.length > 0 }
}

/** 删除一条凭据。 */
function deleteCred(settings, input) {
  const alias = typeof input?.alias === 'string' ? input.alias : ''
  const { map, header } = readMapOrEmpty(settings)
  if (!map.has(alias)) throw new Error(`未知别名 "${alias}"`)
  map.delete(alias)
  atomicWriteCreds(settings, serializeCreds(map, header))
  return { deleted: alias }
}

/** 通用 RPC 通道处理器（Client 配置页调用；浏览器 Peer 已认证）。 */
function makeRpcHandler(settings) {
  return async (endpoint, payload) => {
    try {
      if (endpoint === 'list') return { ok: true, value: listView(settings) }
      if (endpoint === 'upsert') return { ok: true, value: upsertCred(settings, payload) }
      if (endpoint === 'delete') return { ok: true, value: deleteCred(settings, payload) }
      if (endpoint === 'getUi') return { ok: true, value: readUiState(settings) }
      if (endpoint === 'setUi') return { ok: true, value: writeUiState(settings, payload) }
      return { ok: false, error: { code: 'cred-ref/unknown-endpoint', message: 'unknown endpoint: ' + endpoint, details: {} } }
    } catch (error) {
      return { ok: false, error: { code: 'cred-ref/error', message: error instanceof Error ? error.message : String(error), details: {} } }
    }
  }
}

/* ---------- 插件入口 ---------- */

/** 激活期设置快照（工具 execute 闭包读取）。 */
let SETTINGS

/**
 * 应用入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {CredRefConfig} [config]
 */
function run(ctx, config) {
  const settings = resolveSettings(config)
  SETTINGS = settings

  // 1. guard 先装：即使后续注册失败，凭据路径也已受保护。
  if (settings.guard) {
    const disposeGuard = ctx.tools.guard((execution) => {
      if (execution.name === 'cred_exec' || execution.name === 'cred_list') return undefined
      let serialized
      try { serialized = JSON.stringify(execution.arguments) } catch { return undefined }
      if (serialized === undefined) return undefined
      if (!hitsCredsPath(serialized, settings)) return undefined
      // 维护豁免：write/edit 的**目标文件**不在凭据库内时放行（插件源码/文档
      // 合法地引用默认路径）。读类调用与指向凭据库的写入仍然拒绝。
      if (execution.name === 'write' || execution.name === 'edit') {
        const target = execution.arguments?.file_path
        if (typeof target === 'string' && !hitsCredsPath(JSON.stringify(target), settings)) return undefined
      }
      return {
        reason: `dsh-cred-ref: 拒绝读取凭据库（${settings.credsPath}）。凭据只能通过 cred_exec/cred_list 以别名方式使用，或在插件配置页管理；如需手动修改请自行编辑该文件。`,
        info: { name: 'dsh-cred-ref', code: 'CREDS_PATH_GUARD' }
      }
    })
    ctx.effect(() => disposeGuard, 'dsh-cred-ref guard')
  }

  // 2. 注册两个工具；注册即可见（schema 自动进系统提示词装配）。
  const disposeExec = ctx.tools.register(credExecDefinition)
  ctx.effect(() => disposeExec, 'dsh-cred-ref cred_exec')
  const disposeList = ctx.tools.register(credListDefinition)
  ctx.effect(() => disposeList, 'dsh-cred-ref cred_list')

  // 3. 配置页 RPC 通道：list/upsert/delete，与工具共用同一套 CRUD 操作。
  //    connection 的路由注册会在 reader 上下文读 webServer，而 connection
  //    服务自身只在子上下文注入 webServer——故照 mnemon 的实证模式：
  //    在 inject(['connection','webServer']) 回调里把 webServer extend 进
  //    reader 上下文后再取 connection。无 webServer 的部署（纯 headless）
  //    回调不执行：工具照常，仅配置页 RPC 缺席。
  ctx.inject(['connection', 'webServer'], (webCtx) => {
    const scoped = typeof webCtx.extend === 'function'
      ? webCtx.extend({ webServer: webCtx.get('webServer') })
      : webCtx
    const connection = scoped.connection
    if (connection?.rpc?.handle) {
      const disposeRpc = connection.rpc.handle('/dsh-cred-ref', makeRpcHandler(settings))
      ctx.effect(() => disposeRpc, 'dsh-cred-ref rpc')
    }
  })

  ctx.logger?.info?.('dsh-cred-ref active: %s guard=%s', settings.credsPath, settings.guard)
}

/** 参数文本是否触碰凭据路径（含 ~ 写法的文件与目录两种形式）。 */
function hitsCredsPath(serialized, settings) {
  const expanded = settings.credsPath
  const home = homedir()
  const dir = expanded.slice(0, expanded.lastIndexOf('/'))
  const tildedFile = expanded.startsWith(home) ? '~' + expanded.slice(home.length) : undefined
  const tildedDir = dir.startsWith(home) ? '~' + dir.slice(home.length) : undefined
  const needles = [expanded, tildedFile, dir + '/', tildedDir + '/', '.dsh/creds/']
    .filter((n) => typeof n === 'string' && n.length > 1)
  return needles.some((n) => serialized.includes(n))
}

/**
 * 插件形状：inject 必须挂在回调上（已验证：兄弟导出会激活失败
 * "cannot get property tools without inject"）。
 */
const apply = Object.assign(run, { inject: ['tools'] })

export default apply

// 内部纯函数导出（供冒烟测试；不参与插件运行时契约）。
export { expandHome, parseCredsYaml, resolveSettings, hitsCredsPath, cap, unquote, execSsh, execTelnet, listView, upsertCred, deleteCred, makeRpcHandler, serializeCreds, readUiState, writeUiState, uiStatePath }
