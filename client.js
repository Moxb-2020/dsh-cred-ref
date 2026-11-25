// dsh-cred-ref Client 半：插件详情页的凭据管理面板。
// 挂载点 plugins.bundle.config（key = 包名），仅 view === 'page' 渲染。
// 与 Host 通信走通用 Connection RPC 通道 /dsh-cred-ref（浏览器 Peer 已认证）。
// 样式只用 --dsw-alias-* 主题 token；文案走 Client locale 服务。
window.__ModuleLoader__.load({
  id: '@hyll/dsh-cred-ref',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const CHANNEL = '/dsh-cred-ref'
    const T = {
      title: { en: 'Credentials', zh: '凭据管理' },
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
      btnDanger: { fontSize: 12, borderRadius: 8, padding: '6px 14px', cursor: 'pointer', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-state-error-primary)', border: '1px solid var(--dsw-alias-state-error-primary)' },
      link: { fontSize: 12, cursor: 'pointer', background: 'none', border: 'none', padding: '2px 6px', color: 'var(--dsw-alias-brand-primary)' },
      linkDanger: { fontSize: 12, cursor: 'pointer', background: 'none', border: 'none', padding: '2px 6px', color: 'var(--dsw-alias-state-error-primary)' },
      form: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: 14 },
      label: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      input: { fontSize: 13, borderRadius: 7, padding: '7px 9px', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l2)' },
      error: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap' },
      note: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      rowActions: { display: 'flex', gap: 4, alignItems: 'center' }
    }

    const EMPTY_FORM = { alias: '', host: '', port: '22', user: '', password: '', enable: '', kind: 'ssh' }

    function CredPanel(props) {
      const { view, rpc, resolveText } = props
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

      useEffect(() => { if (view === 'page') void refresh() }, [view, refresh])

      if (view !== 'page') return null

      const set = (key) => (ev) => setForm((f) => ({ ...f, [key]: ev.target.value }))

      const submit = async () => {
        if (form === null) return
        setBusy(true); setError('')
        try {
          const res = await rpc.call(CHANNEL, 'upsert', {
            alias: form.alias, host: form.host, port: form.port, user: form.user,
            password: form.password, enable: form.enable, kind: form.kind
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

      const openEdit = (e) => setForm({ mode: 'edit', alias: e.alias, host: e.host, port: String(e.port), user: e.user, password: '', enable: '', kind: e.kind })

      const field = (labelKey, key, extra) => h('label', { style: S.label, key },
        t(labelKey),
        h('input', { style: S.input, value: form[key], onChange: set(key), ...(extra || {}) }))

      return h('div', { style: S.panel },
        h('div', { style: S.head },
          h('h3', { style: S.h3 }, t('title')),
          data ? h('span', { style: data.permsOk ? S.badgeOk : S.badgeBad }, data.permsOk ? t('permsOk') : t('permsBad')) : null),
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
            field('alias', 'alias', { placeholder: 'server1', disabled: form.mode === 'edit' }),
            field('host', 'host', { placeholder: '192.0.2.10' }),
            field('port', 'port', { type: 'number', min: 1, max: 65535 }),
            field('user', 'user', { placeholder: 'root' }),
            h('label', { style: S.label }, t('kind'),
              h('select', { style: S.input, value: form.kind, onChange: set('kind') },
                h('option', { value: 'ssh' }, 'ssh'), h('option', { value: 'telnet' }, 'telnet'))),
            field('password', 'password', { type: 'password', placeholder: form.mode === 'edit' ? t('keepPw') : '', autoComplete: 'new-password' }),
            form.kind === 'telnet' ? field('enable', 'enable', { type: 'password', autoComplete: 'new-password' }) : null,
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'end' } },
              h('button', { style: S.btnPrimary, onClick: () => void submit(), disabled: busy }, t('save')),
              h('button', { style: S.btn, onClick: () => { setForm(null); setError('') }, disabled: busy }, t('cancel')))),
        h('div', { style: S.note }, t('note')))
    }

    return {
      inject: ['slots', 'connection', 'locale'],
      apply(ctx) {
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: '@hyll/dsh-cred-ref',
          inject: () => ({
            rpc: ctx.connection.rpc,
            resolveText: (text) => ctx.locale.resolveText(text)
          })
        }, CredPanel))
      }
    }
  }
})
