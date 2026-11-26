// dsh-cred-ref Client 半：凭据管理共享组件 + 两个消费面。
//  1) 插件详情页（plugins.bundle.config，key = 包名，view === 'page'）——原有入口，含侧边栏开关行。
//  2) 侧边栏全局面板（sidebar.panellist 导航行 + main key=cred-ref 面板体）——开关开启时才注册。
// 两面共用同一 CredPanel 组件与同一 Host RPC 通道 /dsh-cred-ref（list/upsert/delete/getUi/setUi），
// 写入逻辑只在 Host 一份（原子写 + 600），客户端不存在第二套实现。
// 开关状态持久化在 Host 的 <credsPath>.ui.json；跨组件/跨标签同步靠 window 事件 + focus 复查。
// 样式只用 --dsw-alias-* 主题 token；文案走 Client locale 服务。
window.__ModuleLoader__.load({
  id: '@hyll/dsh-cred-ref',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const CHANNEL = '/dsh-cred-ref'
    const PANEL_ID = 'cred-ref'
    const UI_EVENT = 'dsh-cred-ref:ui'
    const T = {
      title: { en: 'Credentials', zh: '凭据管理' },
      nav: { en: 'Credentials', zh: '凭据管理' },
      path: { en: 'Credentials file', zh: '凭据文件路径' },
      permsOk: { en: 'Mode 600 ✓', zh: '权限 600 ✓' },
      permsBad: { en: 'Permissions too open — chmod 600', zh: '权限过宽 — 请 chmod 600' },
      missing: { en: 'File not created yet; adding a credential creates it.', zh: '文件尚未创建；添加第一条凭据时会自动创建。' },
      list: { en: 'Credential list (passwords always masked)', zh: '凭据清单（口令永远掩码）' },
      alias: { en: 'Alias', zh: '别名' },
      host: { en: 'Host', zh: '主机' },
      port: { en: 'Port', zh: '端口' },
      user: { en: 'User', zh: '用户' },
      kind: { en: 'Kind', zh: '类型' },
      password: { en: 'Password', zh: '口令' },
      enable: { en: 'Enable password', zh: '特权口令' },
      actions: { en: 'Actions', zh: '操作' },
      add: { en: '+ Add credential', zh: '+ 添加凭据' },
      edit: { en: 'Edit', zh: '编辑' },
      del: { en: 'Delete', zh: '删除' },
      delConfirm: { en: 'Confirm delete?', zh: '确认删除？' },
      save: { en: 'Save', zh: '保存' },
      cancel: { en: 'Cancel', zh: '取消' },
      keepPw: { en: 'Leave blank to keep current password', zh: '留空 = 保留原口令' },
      empty: { en: 'No credentials yet.', zh: '还没有凭据。' },
      loading: { en: 'Loading…', zh: '加载中…' },
      masked: { en: '••••••', zh: '••••••' },
      closePanel: { en: 'Close panel', zh: '关闭面板' },
      sidebarToggle: { en: 'Sidebar panel', zh: '侧边栏面板' },
      sidebarToggleHint: { en: 'Show a Credentials panel in the sidebar; same data and writes as this page.', zh: '在侧边栏显示凭据面板；与本页共用同一份数据与写入逻辑。' },
      note: { en: 'Writes are atomic (temp file + rename, mode 600). Plaintext never reaches the model, the UI list, or logs.', zh: '写入走原子锁（临时文件 + rename，权限 600）。明文永不进入模型、UI 清单或日志。' }
    }

    const S = {
      panel: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0' },
      head: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      h3: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', margin: 0 },
      pathBox: { fontFamily: 'var(--dsw-font-mono, monospace)', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: '7px 10px', wordBreak: 'break-all' },
      badgeOk: { fontSize: 12, borderRadius: 11, padding: '3px 10px', color: 'var(--dsw-alias-state-success-primary)', border: '1px solid var(--dsw-alias-state-success-primary)' },
      badgeBad: { fontSize: 12, borderRadius: 11, padding: '3px 10px', color: 'var(--dsw-alias-state-error-primary)', border: '1px solid var(--dsw-alias-state-error-primary)' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
      th: { textAlign: 'left', fontWeight: 400, fontSize: 12, color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)', padding: '7px 10px', border: '1px solid var(--dsw-alias-border-l1)' },
      td: { padding: '9px 10px', border: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-primary)' },
      mono: { fontFamily: 'var(--dsw-font-mono, monospace)', fontSize: 12 },
      mask: { color: 'var(--dsw-alias-label-secondary)', letterSpacing: 2 },
      btn: { fontSize: 12, borderRadius: 8, padding: '6px 14px', cursor: 'pointer', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l2)' },
      btnPrimary: { fontSize: 12, borderRadius: 8, padding: '6px 14px', cursor: 'pointer', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-brand-primary)', border: '1px solid var(--dsw-alias-brand-primary)' },
      link: { fontSize: 12, cursor: 'pointer', background: 'none', border: 'none', padding: '2px 6px', color: 'var(--dsw-alias-brand-primary)' },
      linkDanger: { fontSize: 12, cursor: 'pointer', background: 'none', border: 'none', padding: '2px 6px', color: 'var(--dsw-alias-state-error-primary)' },
      form: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: 14 },
      label: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      input: { fontSize: 13, borderRadius: 7, padding: '7px 9px', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l2)' },
      error: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap' },
      note: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      rowActions: { display: 'flex', gap: 4, alignItems: 'center' },
      spacer: { flex: 1 },
      toggleRow: { display: 'flex', alignItems: 'center', gap: 10, borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 12 },
      toggleLabel: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' },
      switch: { width: 34, height: 20, borderRadius: 10, border: '1px solid var(--dsw-alias-border-l2)', cursor: 'pointer', padding: 0, position: 'relative' },
      switchKnob: { position: 'absolute', top: 2, width: 14, height: 14, borderRadius: 7, background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)' },
      sidebarWrap: { padding: '16px 20px', maxWidth: 1080 }
    }

    const EMPTY_FORM = { alias: '', host: '', port: '22', user: '', password: '', enable: '', kind: 'ssh' }

    const broadcastUi = () => { try { window.dispatchEvent(new CustomEvent(UI_EVENT)) } catch {} }

    /** 共享凭据面板：配置页与侧边栏唯一实现。onDisableSidebar 存在时头部显示「关闭面板」。 */
    function CredPanel(props) {
      const { rpc, resolveText, onDisableSidebar } = props
      const t = (key) => resolveText(T[key])
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [form, setForm] = useState(null) // null = closed; {mode, ...fields}
      const [busy, setBusy] = useState(false)
      const [confirmAlias, setConfirmAlias] = useState('')

      const refresh = useCallback(async () => {
        try {
          const res = await rpc.call(CHANNEL, 'list', {})
          if (res.ok) { setData(res.value); setError('') } else setError(res.error.message)
        } catch (e) { setError(String(e && e.message ? e.message : e)) }
      }, [rpc])

      useEffect(() => { void refresh() }, [refresh])
      useEffect(() => {
        const onFocus = () => void refresh()
        window.addEventListener('focus', onFocus)
        return () => window.removeEventListener('focus', onFocus)
      }, [refresh])

      const set = (key) => (ev) => setForm((f) => ({ ...f, [key]: ev.target.value }))

      const submit = async () => {
        if (form === null) return
        setBusy(true); setError('')
        try {
          const res = await rpc.call(CHANNEL, 'upsert', {
            alias: form.alias, host: form.host, port: form.port, user: form.user,
            password: form.password, enable: form.enable, kind: form.kind,
            ...(form.mode === 'edit' ? { renameFrom: form.originalAlias } : {})
          })
          if (res.ok) { setForm(null); await refresh() } else setError(res.error.message)
        } catch (e) { setError(String(e && e.message ? e.message : e)) }
        setBusy(false)
      }

      const remove = async (alias) => {
        setBusy(true); setError('')
        try {
          const res = await rpc.call(CHANNEL, 'delete', { alias })
          if (res.ok) { setConfirmAlias(''); await refresh() } else setError(res.error.message)
        } catch (e) { setError(String(e && e.message ? e.message : e)) }
        setBusy(false)
      }

      const openEdit = (e) => setForm({ mode: 'edit', alias: e.alias, originalAlias: e.alias, host: e.host, port: String(e.port), user: e.user, password: '', enable: '', kind: e.kind })

      const field = (labelKey, key, extra) => h('label', { style: S.label, key },
        t(labelKey),
        h('input', { style: S.input, value: form[key], onChange: set(key), ...(extra || {}) }))

      return h('div', { style: S.panel },
        h('div', { style: S.head },
          h('h3', { style: S.h3 }, t('title')),
          data ? h('span', { style: data.permsOk ? S.badgeOk : S.badgeBad }, data.permsOk ? t('permsOk') : t('permsBad')) : null,
          h('span', { style: S.spacer }),
          onDisableSidebar ? h('button', { style: S.link, onClick: () => void onDisableSidebar(), disabled: busy }, t('closePanel')) : null),
        data ? h('div', { style: S.pathBox }, data.path) : null,
        data && !data.exists ? h('div', { style: S.note }, t('missing')) : null,
        error ? h('div', { style: S.error }, error) : null,
        data === null ? h('div', { style: S.note }, t('loading')) : h('table', { style: S.table },
          h('thead', null, h('tr', null,
            h('th', { style: S.th }, t('alias')), h('th', { style: S.th }, t('host')),
            h('th', { style: S.th }, t('port')), h('th', { style: S.th }, t('user')),
            h('th', { style: S.th }, t('kind')), h('th', { style: S.th }, t('password')),
            h('th', { style: S.th }, t('actions')))),
          h('tbody', null,
            data.entries.length === 0
              ? h('tr', null, h('td', { style: S.td, colSpan: 7 }, t('empty')))
              : data.entries.map((e) => h('tr', { key: e.alias },
                h('td', { style: { ...S.td, ...S.mono } }, e.alias),
                h('td', { style: { ...S.td, ...S.mono } }, e.host),
                h('td', { style: S.td }, e.port),
                h('td', { style: S.td }, e.user),
                h('td', { style: S.td }, e.kind),
                h('td', { style: { ...S.td, ...S.mask } }, t('masked')),
                h('td', { style: S.td }, h('div', { style: S.rowActions },
                  h('button', { style: S.link, onClick: () => openEdit(e), disabled: busy }, t('edit')),
                  confirmAlias === e.alias
                    ? h('button', { style: S.linkDanger, onClick: () => void remove(e.alias), disabled: busy }, t('delConfirm'))
                    : h('button', { style: S.linkDanger, onClick: () => setConfirmAlias(e.alias), disabled: busy }, t('del')))))))),
        form === null
          ? h('div', null, h('button', { style: S.btnPrimary, onClick: () => setForm({ mode: 'add', ...EMPTY_FORM }), disabled: busy }, t('add')))
          : h('div', { style: S.form },
            field('alias', 'alias', { placeholder: 'server1' }),
            field('host', 'host', { placeholder: '192.0.2.10' }),
            field('port', 'port', { type: 'number', min: 1, max: 65535 }),
            field('user', 'user', { placeholder: 'root' }),
            h('label', { style: S.label }, t('kind'),
              h('select', { style: S.input, value: form.kind, onChange: (ev) => {
                const kind = ev.target.value
                setForm((f) => ({ ...f, kind, port: kind === 'telnet' ? '23' : '22' }))
              } },
                h('option', { value: 'ssh' }, 'ssh'), h('option', { value: 'telnet' }, 'telnet'))),
            field('password', 'password', { type: 'password', placeholder: form.mode === 'edit' ? t('keepPw') : '', autoComplete: 'new-password' }),
            form.kind === 'telnet' ? field('enable', 'enable', { type: 'password', autoComplete: 'new-password' }) : null,
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'end' } },
              h('button', { style: S.btnPrimary, onClick: () => void submit(), disabled: busy }, t('save')),
              h('button', { style: S.btn, onClick: () => { setForm(null); setError('') }, disabled: busy }, t('cancel')))),
        h('div', { style: S.note }, t('note')))
    }

    /** 配置页消费面：原入口 + 侧边栏开关行。 */
    function ConfigPage(props) {
      const { view, rpc, resolveText } = props
      const t = (key) => resolveText(T[key])
      const [ui, setUi] = useState(null)
      const [err, setErr] = useState('')
      const load = useCallback(async () => {
        try {
          const res = await rpc.call(CHANNEL, 'getUi', {})
          if (res.ok) setUi(res.value); else setErr(res.error.message)
        } catch (e) { setErr(String(e && e.message ? e.message : e)) }
      }, [rpc])
      useEffect(() => { if (view === 'page') void load() }, [view, load])
      useEffect(() => {
        const onUi = () => void load()
        window.addEventListener(UI_EVENT, onUi)
        return () => window.removeEventListener(UI_EVENT, onUi)
      }, [load])
      if (view !== 'page') return null
      const toggle = async (next) => {
        setErr('')
        try {
          const res = await rpc.call(CHANNEL, 'setUi', { sidebarPanel: next })
          if (res.ok) { setUi(res.value); broadcastUi() } else setErr(res.error.message)
        } catch (e) { setErr(String(e && e.message ? e.message : e)) }
      }
      const on = ui?.sidebarPanel === true
      return h('div', null,
        h(CredPanel, { rpc, resolveText }),
        h('div', { style: S.toggleRow },
          h('button', {
            style: { ...S.switch, background: on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-2)' },
            role: 'switch', 'aria-checked': on, 'aria-label': t('sidebarToggle'),
            onClick: () => void toggle(!on)
          }, h('span', { style: { ...S.switchKnob, left: on ? 16 : 2 } })),
          h('span', { style: S.toggleLabel }, t('sidebarToggle')),
          h('span', { style: S.note }, t('sidebarToggleHint'))),
        err ? h('div', { style: S.error }, err) : null)
    }

    /** 侧边栏消费面：同一 CredPanel，头部带「关闭面板」（= 关开关）。 */
    function SidebarPage(props) {
      const { rpc, resolveText } = props
      const disable = async () => {
        try {
          const res = await rpc.call(CHANNEL, 'setUi', { sidebarPanel: false })
          if (res.ok) broadcastUi()
        } catch {}
      }
      return h('div', { style: S.sidebarWrap }, h(CredPanel, { rpc, resolveText, onDisableSidebar: disable }))
    }

    /**
     * 侧边栏导航行图标：镂空（描边）数字盾牌 + 钥匙孔，传达凭据安全。
     * 视觉规范对齐官方面板图标（Schedule 用产品图标集 outline 风格）：
     * currentColor 随主题、调用方传入 size、24 视图框上 1.7 线宽
     * （等比 CalendarIcon 的 14/1px 视觉重量）、圆角端点。
     * 产品图标集无盾牌字形，按 CalendarIcon 先例本包自绘。
     */
    function SidebarIcon(props) {
      const size = props?.size ?? 18
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
        fill: 'none', xmlns: 'http://www.w3.org/2000/svg',
        style: { display: 'block', opacity: props?.active ? 1 : 0.75 }
      },
        h('path', {
          // 盾牌轮廓
          d: 'M12 3L19.5 5.8V11.2C19.5 16.1 16.3 19.6 12 21C7.7 19.6 4.5 16.1 4.5 11.2V5.8Z',
          stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linejoin': 'round'
        }),
        h('circle', {
          // 钥匙孔：锁芯圆 + 锁杆
          cx: 12, cy: 10, r: 2.2, stroke: 'currentColor', 'stroke-width': 1.7
        }),
        h('path', {
          d: 'M12 12.2V15.4', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round'
        }))
    }

    return {
      inject: ['slots', 'connection', 'locale'],
      apply(ctx) {
        const rpc = ctx.connection.rpc
        const resolveText = (text) => ctx.locale.resolveText(text)

        // 配置页入口：常驻，行为不变。
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: '@hyll/dsh-cred-ref',
          inject: () => ({ rpc, resolveText })
        }, ConfigPage))

        // 侧边栏：按持久化开关动态注册/注销（关 = 导航行与面板体都不存在）。
        let disposers = []
        const syncSidebar = async () => {
          let on = false
          try {
            const res = await rpc.call(CHANNEL, 'getUi', {})
            on = res.ok === true && res.value?.sidebarPanel === true
          } catch { on = false }
          if (on && disposers.length === 0) {
            disposers.push(ctx.slots.register({
              name: 'main', key: PANEL_ID,
              inject: () => ({ rpc, resolveText })
            }, SidebarPage))
            disposers.push(ctx.slots.register({
              name: 'sidebar.panellist', id: PANEL_ID, order: 15,
              label: () => resolveText(T.nav)
            }, SidebarIcon))
          } else if (!on && disposers.length > 0) {
            for (const d of disposers) { try { d() } catch {} }
            disposers = []
          }
        }
        ctx.effect(() => () => { for (const d of disposers) { try { d() } catch {} } disposers = [] }, 'dsh-cred-ref sidebar registrations')
        ctx.effect(() => {
          const onUi = () => void syncSidebar()
          const onFocus = () => void syncSidebar()
          window.addEventListener(UI_EVENT, onUi)
          window.addEventListener('focus', onFocus)
          document.addEventListener('visibilitychange', onFocus)
          return () => {
            window.removeEventListener(UI_EVENT, onUi)
            window.removeEventListener('focus', onFocus)
            document.removeEventListener('visibilitychange', onFocus)
          }
        }, 'dsh-cred-ref sidebar sync listeners')
        void syncSidebar()
      }
    }
  }
})
