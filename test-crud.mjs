// CRUD + RPC handler 单元测试（临时凭据文件，工作区内）
import { resolveSettings, listView, upsertCred, deleteCred, makeRpcHandler, parseCredsYaml } from "./src/index.js"
import { readFileSync, statSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(process.cwd(), ".crud-test-"))
const settings = resolveSettings({ credsPath: join(dir, "servers.yaml") })
let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++ } else { fail++; console.log("FAIL:", name) } }

// 1. 文件不存在时 list 为空、permsOk=false
const v0 = listView(settings)
ok(v0.exists === false && v0.count === 0, "empty list before create")

// 2. 新增两条
upsertCred(settings, { alias: "alpha", host: "10.0.0.1", user: "root", password: "p@ss\"word\\x", kind: "ssh" })
upsertCred(settings, { alias: "sw1", host: "10.0.0.2", port: 23, user: "admin", password: "pw2", enable: "en2", kind: "telnet" })
const v1 = listView(settings)
ok(v1.exists === true && v1.permsOk === true && v1.count === 2, "two entries, mode 600")
ok(v1.entries.every((e) => !("password" in e)), "list never carries password")
ok((statSync(settings.credsPath).mode & 0o777) === 0o600, "file mode 600")

// 3. 引号/反斜杠口令往返无损
const map = parseCredsYaml(readFileSync(settings.credsPath, "utf8"))
ok(map.get("alpha").password === "p@ss\"word\\x", "quoting roundtrip")
ok(map.get("sw1").enable === "en2" && map.get("sw1").port === 23, "telnet fields")

// 4. 编辑保留口令（password 留空）
upsertCred(settings, { alias: "alpha", host: "10.0.0.9", user: "root", password: "", kind: "ssh" })
const map2 = parseCredsYaml(readFileSync(settings.credsPath, "utf8"))
ok(map2.get("alpha").host === "10.0.0.9" && map2.get("alpha").password === "p@ss\"word\\x", "edit keeps password")

// 5. 新别名无口令 → 报错
try { upsertCred(settings, { alias: "beta", host: "h", user: "u", password: "" }); ok(false, "new without password rejected") }
catch { ok(true, "new without password rejected") }

// 6. 非法别名 / 端口 / kind
for (const bad of [{ alias: "a b", host: "h", user: "u", password: "p" }, { alias: "ok", host: "h", user: "u", password: "p", port: 99999 }, { alias: "ok", host: "h", user: "u", password: "p", kind: "ftp" }]) {
  try { upsertCred(settings, bad); ok(false, "invalid rejected: " + JSON.stringify(bad)) } catch { ok(true, "invalid rejected") }
}

// 7. 删除
deleteCred(settings, { alias: "sw1" })
ok(listView(settings).count === 1, "delete works")
try { deleteCred(settings, { alias: "nope" }); ok(false, "delete unknown rejected") } catch { ok(true, "delete unknown rejected") }

// 8. RPC handler 形状
const handler = makeRpcHandler(settings)
const r1 = await handler("list", {})
ok(r1.ok === true && r1.value.count === 1, "rpc list ok shape")
const r2 = await handler("upsert", { alias: "gamma", host: "h", user: "u", password: "p" })
ok(r2.ok === true && r2.value.alias === "gamma", "rpc upsert ok shape")
const r3 = await handler("delete", { alias: "gamma" })
ok(r3.ok === true && r3.value.deleted === "gamma", "rpc delete ok shape")
const r4 = await handler("bogus", {})
ok(r4.ok === false && typeof r4.error.code === "string", "rpc unknown endpoint failure shape")
const r5 = await handler("upsert", { alias: "x y", host: "h", user: "u", password: "p" })
ok(r5.ok === false && r5.error.message.length > 0, "rpc validation failure shape")

// 9. 头部注释保留
const text = readFileSync(settings.credsPath, "utf8")
upsertCred(settings, { alias: "delta", host: "h", user: "u", password: "p" })
ok(readFileSync(settings.credsPath, "utf8").startsWith(text.split("\n")[0]), "header preserved")

// 10. UI 开关状态：默认关、往返、损坏 fail-closed、600、原子
const h2 = makeRpcHandler(settings)
const u0 = await h2("getUi", {})
ok(u0.ok === true && u0.value.sidebarPanel === false, "ui default off")
const u1 = await h2("setUi", { sidebarPanel: true })
ok(u1.ok === true && u1.value.sidebarPanel === true, "ui set on")
ok((statSync(settings.credsPath + ".ui.json").mode & 0o777) === 0o600, "ui state mode 600")
const u2 = await h2("getUi", {})
ok(u2.value.sidebarPanel === true, "ui persisted on")
const u3 = await h2("setUi", { sidebarPanel: false })
ok(u3.value.sidebarPanel === false, "ui set off")
writeFileSync(settings.credsPath + ".ui.json", "{broken")
const u4 = await h2("getUi", {})
ok(u4.value.sidebarPanel === false, "ui corrupt fail-closed")
ok(!existsSync(settings.credsPath + ".ui.json.tmp-" + process.pid), "no tmp leftover")

rmSync(dir, { recursive: true, force: true })
console.log(`CRUD tests: ${pass} pass / ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
