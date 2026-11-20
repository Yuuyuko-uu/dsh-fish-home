// 鱼鱼窝 · 网页半边
//
// 在 DSH 设置左侧栏加一项「鱼鱼窝」：看她连上没有、绑的哪间会话、
// 房间里现在几点、刚才说过什么，还有那个「试一句」。
//
// ⚠ 这里不碰会话，只是往宿主那几条 /dsh-fish-home/* 路由上读写。

window.__ModuleLoader__.load({
  id: 'dsh-fish-home',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const inject = ['slots']
    const h = React.createElement

    const B = '/dsh-fish-home'
    const get = (p) => fetch(B + p, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    const post = (p, body) =>
      fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
        .then((r) => r.json())
        .catch(() => null)

    // 房间后台那几条挂在 /fish-room/v1 下面（房间本体写死的前缀）。
    // 页面这边不带令牌，靠同源放行。
    const 房 = '/fish-room/v1'
    const 房取 = (p) => fetch(房 + p, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    const 房发 = (p) =>
      fetch(房 + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        .then((r) => r.json())
        .catch(() => null)

    const S = {
      wrap: {
        padding: '12px 14px 24px',
        fontSize: 13,
        lineHeight: 1.7,
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.92))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))',
        borderRadius: 12,
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        padding: '10px 12px',
        marginBottom: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      row: { display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 8, flexWrap: 'wrap' },
      lab: { minWidth: 120, paddingTop: 3, fontSize: 12.5 },
      ctl: { flex: '1 1 240px', minWidth: 200 },
      hint: { opacity: 0.6, fontSize: 11.5, marginTop: 2 },
      input: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: '100%',
        boxSizing: 'border-box',
      },
      btn: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '5px 12px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        cursor: 'pointer',
      },
      dot: (on) => ({
        display: 'inline-block', width: 8, height: 8, borderRadius: 8, marginRight: 6,
        background: on ? '#35c07f' : 'rgba(150,150,150,.5)',
      }),
    }

    function 卡(标题, 副, 内容) {
      return h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: 6 } }, 标题),
        副 ? h('div', { style: S.hint }, 副) : null,
        内容)
    }

    function 行(标签, 控件, 提示) {
      return h('div', { style: S.row },
        h('div', { style: S.lab }, 标签),
        h('div', { style: S.ctl }, 控件, 提示 ? h('div', { style: S.hint }, 提示) : null))
    }

    function 说时间(房) {
      if (!房 || !Number.isFinite(Number(房.hour))) return '房间里还没报过时间'
      const 总分 = Math.floor(Number(房.hour) * 60)
      const hh = String(Math.floor(总分 / 60) % 24).padStart(2, '0')
      const mm = String(总分 % 60).padStart(2, '0')
      const 天 = { rain: '下雨', snow: '下雪', cloudy: '阴天', storm: '打雷' }[房.weather] || ''
      return hh + ':' + mm + (房.period ? ' · ' + 房.period : '') + (天 ? ' · ' + 天 : '')
    }

    function Section() {
      const [态, 设态] = React.useState(null)
      const [读不到, 设读不到] = React.useState(0)
      const [忙, 设忙] = React.useState(false)
      const [话, 设话] = React.useState('')
      const [结果, 设结果] = React.useState('')
      const [画, 设画] = React.useState({})
      const [模型们, 设模型们] = React.useState([])
      const [画结果, 设画结果] = React.useState('')
      const [试画的图, 设试画的图] = React.useState('')
      const [试画内容, 设试画内容] = React.useState('')
      const [房态, 设房态] = React.useState(null)
      const [房忙, 设房忙] = React.useState(false)
      // 屋里那两件事：默认都开；房间读不到就回落到本地那份，再没有就是开
      const [屋里, 设屋里] = React.useState({ 学菜: true, 画图: true })
      const [屋里来源, 设屋里来源] = React.useState('')
      const [屋里忙, 设屋里忙] = React.useState('')
      const [屋里说, 设屋里说] = React.useState('')
      const [睡态, 设睡态] = React.useState(null)
      const [睡忙, 设睡忙] = React.useState(false)
      const [睡说, 设睡说] = React.useState('')
      // 房间本体（三百多兆的另一份程序）装没装；以及插件自己有没有新版
      const [本体, 设本体] = React.useState(null)
      const [更新, 设更新] = React.useState({ 忙: false, 说: '', 最新: '', 当前: '', 有: false, 能装: false, 开发副本: false })
      // 读 /api/state 可能要几秒；这期间她已经拨过开关的话，别拿旧值盖掉
      const 屋里改过 = React.useRef(false)

      const 拉 = React.useCallback(async () => {
        const j = await get('/state')
        if (j && j.ok) { 设态(j); 设读不到(0) } else 设读不到((n) => n + 1)
      }, [])

      // 房间本体：插件包里不带它（三百多兆，npm 装不下），所以设置里得说清装没装、去哪下
      const 查本体 = React.useCallback(async () => {
        const j = await get('/room-body')
        if (j && j.ok) 设本体(j)
      }, [])
      React.useEffect(() => { void 查本体() }, [查本体])

      // 检查更新：跟其它几个插件同一份实现（宿主那边的 lib/selfupdate.mjs 干的活）
      const 查更新 = React.useCallback(async (刷新) => {
        设更新((x) => ({ ...x, 忙: true, 说: '查着…' }))
        const j = await get('/update' + (刷新 ? '?refresh=1' : ''))
        if (!j || !j.ok) {
          设更新({ 忙: false, 说: j && j.error ? '没查成：' + j.error : '没查成', 最新: '', 当前: '', 有: false, 能装: false, 开发副本: false })
          return
        }
        const 最新 = String(j.latest || '')
        const 当前 = String(j.current || '')
        let 说
        if (!最新) 说 = '查不到版本信息' + (j.error ? '（' + j.error + '）' : '')
        else if (j.hasUpdate) 说 = '有新版本 ' + 最新 + '（现在是 ' + 当前 + '）'
        else if (j.ahead) 说 = '本机 ' + 当前 + ' 比仓库还新（自己改过还没推，正常）'
        else 说 = '已是最新（' + 当前 + '）'
        设更新({ 忙: false, 说, 最新, 当前, 有: Boolean(j.hasUpdate), 能装: Boolean(j.canInstall), 开发副本: Boolean(j.devCopy) })
      }, [])
      React.useEffect(() => { void 查更新(false) }, [查更新])

      // 一键更新：走宿主自己的 pluginManager 装，装完由宿主决定要不要重载
      const 装更新 = React.useCallback(async () => {
        if (!更新.有 || !更新.能装) return
        设更新((x) => ({ ...x, 忙: true, 说: '正在装…' }))
        const j = await post('/update/install', {})
        if (j && j.ok) {
          设更新((x) => ({ ...x, 忙: false, 说: '装好了：' + String(j.说 || j.restartReason || '重载一次 DSH 生效') }))
          void 查更新(true)
        } else {
          设更新((x) => ({ ...x, 忙: false, 说: '没装成：' + String((j && (j.error || j.说)) || '宿主没答话') }))
        }
      }, [更新.有, 更新.能装, 查更新])

      // 模型列表：从 DSH 那边读，不让人手打名字。
      // ⚠ 只读一次不够 —— 插件刚起来那一瞬间可能还没有 provider；没读到就每 4 秒再试，直到读到。
      const 模型们ref = React.useRef([])
      const [模型提示, 设模型提示] = React.useState('')
      const 拉模型 = React.useCallback(async () => {
        const j = await get('/models')
        if (j && j.ok && Array.isArray(j.providers) && j.providers.length) {
          模型们ref.current = j.providers
          设模型们(j.providers)
          设模型提示('')
          return true
        }
        设模型提示(String((j && j.说) || '读不到'))
        return false
      }, [])

      React.useEffect(() => {
        拉()
        const t = setInterval(() => {
          拉()
          if (!模型们ref.current.length) 拉模型()
        }, 4000)
        return () => clearInterval(t)
      }, [拉, 拉模型])

      React.useEffect(() => { 拉模型() }, [拉模型])

      // 房间后台只看一眼：设置页打开时刷一次就够，没必要隔几秒去敲一次门
      const 拉房态 = React.useCallback(async () => {
        const j = await 房取('/room/status')
        设房态(j && typeof j.运行中 === 'boolean' ? j : null)
      }, [])

      React.useEffect(() => { 拉房态() }, [拉房态])

      // 屋里开关：打开设置时问一次房间，读不到宿主会给本地那份
      const 拉屋里 = React.useCallback(async () => {
        const j = await get('/room-settings')
        if (!j || !j.ok || 屋里改过.current) return
        设屋里({ 学菜: j.学菜 !== false, 画图: j.画图 !== false })
        设屋里来源(String(j.来源 || ''))
      }, [])

      React.useEffect(() => { 拉屋里() }, [拉屋里])

      // 睡觉状态：打开设置看一眼，叫起来之后再刷一遍
      const 拉睡态 = React.useCallback(async () => {
        const j = await get('/sleep')
        if (j && j.ok) 设睡态(j)
      }, [])

      React.useEffect(() => { 拉睡态() }, [拉睡态])

      // 第一次读到状态时，把画图那几格填上（之后就以本地输入为准，别被轮询冲掉）
      const 画填过 = React.useRef(false)
      React.useEffect(() => {
        if (!态 || 画填过.current) return
        画填过.current = true
        设画({
          画图地址: 态.画图地址 || '',
          画图密钥: 态.画图密钥 || '',
          画图模型: 态.画图模型 || '',
          画图尺寸: 态.画图尺寸 || '1024x1024',
        })
      }, [态])

      const 存 = async (补丁) => {
        设忙(true)
        const j = await post('/save', 补丁)
        设忙(false)
        if (j && j.ok) { 设态(j); 设结果('存好了') } else 设结果('没存上：' + String((j && j.error && j.error.message) || '未知原因'))
      }

      const 试 = async () => {
        设忙(true)
        设结果('')
        const j = await post('/try', { 话 })
        设忙(false)
        设结果(j && j.ok ? String(j.说 || '送进去了') : '没送进去：' + String((j && j.error && j.error.message) || '未知原因'))
        拉()
      }

      const 试画 = async () => {
        设忙(true)
        设画结果('画着…')
        设试画的图('')
        const j = await post('/paint', { prompt: 试画内容.trim() })
        设忙(false)
        if (j && j.ok) {
          设画结果('画好了（' + Math.round((j.b64 || '').length / 1024) + 'KB）')
          设试画的图('data:' + (j.mime || 'image/png') + ';base64,' + j.b64)
        } else {
          设画结果('没画成：' + String((j && j.error && j.error.message) || '未知原因'))
        }
      }

      const 停后台 = async () => {
        设房忙(true)
        const j = await 房发('/room/stop')
        设房忙(false)
        设结果(j && j.ok
          ? '鱼鱼窝后台停了'
          : '没停成：' + String((j && (j.说 || (j.error && j.error.message))) || '未知原因'))
        await 拉房态()
      }

      const 切屋里 = async (键, 值) => {
        屋里改过.current = true
        设屋里((旧) => ({ ...旧, [键]: 值 }))   // 先把开关拨过去，别等网络
        设屋里忙(键)
        设屋里说('')
        const j = await post('/room-settings', { [键]: 值 })
        设屋里忙('')
        if (j && j.ok) {
          设屋里({ 学菜: j.学菜 !== false, 画图: j.画图 !== false })
          设屋里来源(String(j.来源 || ''))
          if (j.已送达 === false) 设屋里说('房间没开，这次先记在本地；等它起来会自动补上。')
        } else {
          设屋里说('没送到房间，也没记下来（DSH 后台没答话）。')
        }
      }

      const 叫起来 = async () => {
        设睡忙(true)
        设睡说('')
        const j = await post('/sleep/wake', {})
        设睡忙(false)
        if (!j || !j.ok) 设睡说('房间没开或没答话，没叫起来（等它起来再试）')
        else 设睡说('叫起来了')
        await 拉睡态()
      }

      if (!态) {
        return h('div', { style: S.wrap },
          h('div', null, '正在读鱼鱼窝的状态…'),
          读不到 >= 2
            ? h('div', { style: { marginTop: 8, color: '#c0392b' } }, '读不到。插件那半边没起来。')
            : null)
      }

      const 名单 = Array.isArray(态.名单) ? 态.名单 : []

      return h('div', { style: S.wrap },
        卡('检查更新' + (更新.当前 ? ' · 鱼鱼窝 v' + 更新.当前 : ''), '查这个插件自己的仓库，多源取最大的那个版本',
          h('div', null,
            h('div', { style: S.hint }, 更新.说 || '还没查'),
            更新.开发副本 ? h('div', { style: S.hint }, '这是本地开发副本（link:），不给自动装 —— 会把你正在改的目录换成仓库里的版本') : null,
            h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
              h('button', { style: S.btn, onClick: () => { void 查更新(true) } }, 更新.忙 ? '查着…' : '再查一次'),
              更新.有 && 更新.能装 ? h('button', { style: S.btn, onClick: () => 装更新() }, '一键更新') : null)))
        , 卡('现在这样', '她（大肥鱼的小日子）那个房间和 DSH 里的会话说上话没有',
          h('div', null,
            h('div', { style: { marginBottom: 6 } },
              h('span', { style: S.dot(态.已连 > 0) }),
              态.已连 > 0 ? '房间连着（' + 态.已连 + ' 个连接）' : '房间没连上'),
            h('div', { style: { marginBottom: 6 } },
              h('span', { style: S.dot(态.会话活着) }),
              态.会话 ? '接的是这间会话' : '还没选会话'),
            h('div', { style: S.hint }, '地址：' + (态.地址 || '（还没起来）')),
            h('div', { style: S.hint }, '房间里：' + 说时间(态.房间环境)),
            态.房间那句 ? h('div', { style: S.hint }, '递给 DSH 的那句：' + 态.房间那句) : null))

        , 卡('后台', 'DSH 关着的时候，房间也可以一直住在后台',
          h('div', null,
            行('启动 DSH 时在后台开着鱼鱼窝', h('input', {
              type: 'checkbox',
              checked: Boolean(态.开机自启),
              onChange: (e) => 存({ 开机自启: e.target.checked }),
            }), '默认关；打开之后 DSH 一启动就把房间拉到后台'),
            行('鱼鱼窝后台', h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
              h('span', { style: { display: 'inline-flex', alignItems: 'center', minWidth: 0 } },
                h('span', { style: S.dot(Boolean(房态 && 房态.运行中)) }),
                房态 === null ? '读不到' : (房态.运行中 ? '运行中' : '已停止')),
              h('button', {
                style: {
                  ...S.btn,
                  marginLeft: 'auto',
                  opacity: (房态 && 房态.运行中 && !房忙) ? 1 : 0.5,
                  cursor: (房态 && 房态.运行中 && !房忙) ? 'pointer' : 'default',
                },
                disabled: !(房态 && 房态.运行中) || 房忙,
                onClick: 停后台,
              }, 房忙 ? '停着…' : '停止')),
              '停掉的只是后台服务；房间里已经开着的窗口要自己关')))

        , 卡('屋里那两件事', '开关会直接送进房间；房间没开就先记着，等它起来补上',
          h('div', null,
            行('每天学一道菜 · 显示做法', h('input', {
              type: 'checkbox',
              checked: Boolean(屋里.学菜),
              disabled: Boolean(屋里忙),
              onChange: (e) => 切屋里('学菜', e.target.checked),
            }), '会话能查今天的菜和指定菜谱。关闭后，网页和会话都只看菜名。'),
            行('让她画画', h('input', {
              type: 'checkbox',
              checked: Boolean(屋里.画图),
              disabled: Boolean(屋里忙),
              onChange: (e) => 切屋里('画图', e.target.checked),
            }), '控制会话画画和屋内画架。下方的接口试画只预览，不放进画册。'),
            屋里说 ? h('div', { style: S.hint }, 屋里说) : null,
            屋里来源 === '本地' ? h('div', { style: S.hint }, '房间那边暂时没给这两个开关，这里显示的是本地记的那份') : null))

        , 卡('睡觉', '怕以后出 BUG 把人锁在「叫不醒」里 —— 这里能看、能叫，还有一道总开关',
          h('div', null,
            行('房间现在', h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('span', { style: S.dot(Boolean(睡态 && 睡态.睡着)) }),
              h('span', null, (睡态 === null || 睡态.房间在 === false) ? '读不到' : (睡态.睡着 ? '睡着' : '醒着')),
              睡态 && 睡态.活动 ? h('span', { style: S.hint }, '· ' + 睡态.活动) : null,
              睡态 && 睡态.房间在 === false ? h('span', { style: S.hint }, '（房间没开）') : null)),
            行('叫起来', h('div', null,
              h('button', {
                style: { ...S.btn, opacity: 睡忙 ? 0.5 : 1 },
                disabled: 睡忙,
                onClick: 叫起来,
              }, 睡忙 ? '叫着…' : '叫起来'),
              睡说 ? h('div', { style: S.hint }, 睡说) : null)),
            行('睡着了就不理我', h('input', {
              type: 'checkbox',
              checked: 态.睡着不理 !== false,
              onChange: (e) => 存({ 睡着不理: e.target.checked }),
            }), '关掉之后睡着也照常回话（逃生门，默认开）')))

        , 卡('上下文与回忆', '默认不把现场数据塞进每一轮 runtime-context；需要时让她调用 fish_home 查询。',
          h('div', null,
            行('状态变化时通知', h('input', {
              type: 'checkbox', checked: 态.状态变化通知 !== false,
              onChange: (e) => 存({ 状态变化通知: e.target.checked }),
            }), '天气真正变化时，单独告诉绑定会话。'),
            行('每轮注入现场', h('input', {
              type: 'checkbox', checked: 态.每轮注入现场 === true,
              onChange: (e) => 存({ 每轮注入现场: e.target.checked }),
            }), '打开后每轮都会增加一段 runtime-context，可能增加用量。'),
            ...[['milestone','成熟与生活里程碑'],['wallet','金币与商店变动'],['scene','拎起、秋千等场景互动']].map(([key,label]) =>
              行(label, h('input', {
                type: 'checkbox', checked: 态.主动生活通知?.[key] !== false,
                onChange: (e) => 存({ 主动生活通知: { ...(态.主动生活通知 || {}), [key]: e.target.checked } }),
              }), '这类事件会单独发给绑定会话，可能触发一次模型回复。')),
            行('记忆文本路径', h('input', {
              style: S.input, value: 态.文本记忆路径 || '', placeholder: 'D:\\鱼鱼\\memory.md 或文件夹',
              onChange: (e) => 设态((x) => ({ ...x, 文本记忆路径: e.target.value })),
              onBlur: (e) => 存({ 文本记忆路径: e.target.value.trim() }),
            }), '支持 .md / .txt 文件或文件夹；段落会显示为“记住的事”。'),
            行('日记文本路径', h('input', {
              style: S.input, value: 态.文本日记路径 || '', placeholder: 'D:\\鱼鱼\\日记',
              onChange: (e) => 设态((x) => ({ ...x, 文本日记路径: e.target.value })),
              onBlur: (e) => 存({ 文本日记路径: e.target.value.trim() }),
            }), '支持按日期命名的 .md / .txt 文件或文件夹；没有星汐时也能作为相伴天数来源。'),
            行('相伴起始日', h('input', {
              style: S.input, type: 'date', value: 态.相伴起始日 || '',
              onChange: (e) => 存({ 相伴起始日: e.target.value }),
            }), '没有可读日记时使用这个日期计算存档天数。')))

        , 卡('接哪间会话', '房间里说的话会送进这一间；她回的话也顺着这条路回来',
          h('div', null,
            行('会话', h('select', {
              style: S.input,
              value: 态.会话 || '',
              onChange: (e) => 存({ 会话: e.target.value }),
            },
              h('option', { value: '' }, '（不选）'),
              名单.map((x) => h('option', { key: x.id, value: x.id },
                (x.标题 || '（还没起名字）') + ' · ' + x.id.slice(-8))))),
            行('开着', h('input', {
              type: 'checkbox',
              checked: Boolean(态.开),
              onChange: (e) => 存({ 开: e.target.checked }),
            }), '关掉之后房间连不上'),
            行('她主动开口也送过去', h('input', {
              type: 'checkbox',
              checked: Boolean(态.转发主动开口),
              onChange: (e) => 存({ 转发主动开口: e.target.checked }),
            }), '主动搭话、刷完 B 站回来这类，房间里也冒气泡')))

        , 卡('试一句', '跟房间里打字走同一条路，真的会送进会话',
          h('div', null,
            h('input', { style: S.input, value: 话, placeholder: '试发内容', onChange: (e) => 设话(e.target.value) }),
            h('div', { style: { marginTop: 8 } },
              h('button', { style: { ...S.btn, opacity: 忙 ? 0.5 : 1 }, disabled: 忙 || !话.trim(), onClick: 试 }, 忙 ? '送着…' : '送进去')),
            结果 ? h('div', { style: { marginTop: 8, fontSize: 12 } }, 结果) : null))

        , 卡('房间那边', '房间读 data/dsh-bridge.json',
          h('div', { style: S.hint },
            '地址和令牌在 ~/.dsh/fish-room.discovery.json。'))

        , 卡('画架生图', '填好兼容 /images/generations 的接口、密钥和生图模型。屋内点击画架会通知绑定会话。',
          h('div', null,
            行('接口地址', h('input', {
              style: S.input, value: 画.画图地址 || '', placeholder: 'https://…/v1',
              onChange: (e) => 设画({ ...画, 画图地址: e.target.value }),
              onBlur: (e) => 存({ 画图地址: e.target.value }),
            })),
            行('密钥', h('input', {
              style: S.input, value: 画.画图密钥 || '', type: 'password',
              onChange: (e) => 设画({ ...画, 画图密钥: e.target.value }),
              onBlur: (e) => 存({ 画图密钥: e.target.value }),
            })),
            h('div', { style: { display: 'flex', gap: 8 } },
              h('select', {
                style: { ...S.input, flex: 1 },
                value: 画.画图模型 || '',
                onChange: (e) => { 设画({ ...画, 画图模型: e.target.value }); 存({ 画图模型: e.target.value }) },
              },
                h('option', { value: '' }, 模型们.length ? '（不选）' : '（还没读到模型）'),
                ...模型们.map((p) => h('optgroup', { key: p.id, label: p.name },
                  ...(p.models || []).map((m) => h('option', { key: p.id + '/' + m.id, value: m.id },
                    m.name === m.id ? m.id : m.name + '（' + m.id + '）'))))),
              h('button', { style: S.btn, onClick: () => 拉模型() }, '重新读')),
            行('模型 ID', h('input', {
              style: S.input, value: 画.画图模型 || '', placeholder: '接口没列出模型时手动输入',
              onChange: (e) => 设画({ ...画, 画图模型: e.target.value }),
              onBlur: (e) => 存({ 画图模型: e.target.value.trim() }),
            })),
            模型提示 ? h('div', { style: S.hint }, 模型提示) : null,
            行('尺寸', h('select', {
              style: S.input,
              value: 画.画图尺寸 || '1024x1024',
              onChange: (e) => { 设画({ ...画, 画图尺寸: e.target.value }); 存({ 画图尺寸: e.target.value }) },
            },
              ['1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', '3840x2160', '2160x3840', 'auto'].map((v) => h('option', { key: v, value: v }, v)))),
            行('试画内容', h('input', { style: S.input, value: 试画内容, maxLength: 1000, onChange: (e) => 设试画内容(e.target.value) })),
            h('div', { style: { marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' } },
              h('button', { style: { ...S.btn, opacity: 忙 ? 0.5 : 1 }, disabled: 忙 || !试画内容.trim(), onClick: 试画 }, 忙 ? '画着…' : '试画'),
              h('span', { style: S.hint }, 画结果)),
            (试画的图 ? h('img', { src: 试画的图, style: { marginTop: 10, width: 180, borderRadius: 8, display: 'block' } }) : null)))

        , 卡('房间本体', '那个 3D 屋子。它是另一份程序，三百多兆，装不进插件包，所以单独下载',
          h('div', null,
            h('div', { style: S.hint }, 本体
              ? (本体.已装
                ? '装好了' + (本体.版本 ? '：鱼鱼窝 ' + 本体.版本 : '') + '（' + 本体.目录 + '）'
                : '还没装' + (本体.版本 ? '（看到版本 ' + 本体.版本 + '，但没找到 app-server.js）' : '') + ' —— 下下来解压到 ' + 本体.目录)
              : '正在看…'),
            本体?.已装 ? h('div', { style:S.hint }, '更新房间：退出后台，再运行房间目录里的 update-fish-home.cmd 选择新版 ZIP。旧版没有脚本时，从新 ZIP 只复制两个 update-fish-home 文件到旧目录。存档会保留。') : null,
            h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
              本体 && 本体.下载页
                ? h('a', { href: 本体.下载页, target: '_blank', rel: 'noopener', style: { ...S.btn, textDecoration: 'none', display: 'inline-block' } }, 本体.已装 ? '去 Releases 看看' : '去下载')
                : null,
              h('button', { style: S.btn, onClick: () => { void 查本体() } }, '重新检测'))))
        , 卡('最近', null,
          h('div', null,
            h('div', { style: S.hint }, '她最近说的一句：' + (态.最近说过 || '还没说过')),
            (态.日志 || []).slice(-8).map((x, i) => h('div', { key: i, style: S.hint }, x.时 + '  ' + x.话))))
      )
    }

    /**
     * 侧栏底部的「鱼鱼窝」。
     * 尺寸 / 圆角 / hover 都照抄旁边自带的底部按钮：宽排 42px、窄栏 36px 圆形。
     * 自己做一套皮肤的话，旁边那两个按钮会显得像拼上去的。
     * 点一下只发一条 /room/open —— 起服务、去重、开窗口都在宿主那边做。
     */
    function 鱼鱼窝按钮({ wide }) {
      const [忙, 设忙] = React.useState(false)
      const [悬停, 设悬停] = React.useState(false)
      const [说不出来, 设说不出来] = React.useState('')
      // 图标（鲸鱼尾）只在 lib/icon.mjs 存一份；页面这边 import 不了，跟宿主要。
      // null = 还在拿，'' = 拿不到（退回那个「鱼」字）
      const [图标图, 设图标图] = React.useState(null)
      React.useEffect(() => {
        let 还在 = true
        get('/icon').then((j) => {
          if (!还在) return
          设图标图(j && typeof j.图标 === 'string' ? j.图标 : '')
        })
        return () => { 还在 = false }
      }, [])

      const 点 = () => {
        if (忙) return
        设忙(true)
        设说不出来('')
        房发('/room/open').then((j) => {
          设忙(false)
          if (!j || !j.ok) 设说不出来(String((j && (j.说 || (j.error && j.error.message))) || '没打开'))
        }, () => {
          设忙(false)
          设说不出来('连不上 DSH 后台')
        })
      }

      const 钮 = {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: wide ? 'flex-start' : 'center',
        gap: 8,
        width: wide ? 'calc(100% + 4px)' : 36,
        height: wide ? 42 : 36,
        margin: wide ? '0 -2px' : 0,
        padding: wide ? '0 10px 0 8px' : 0,
        border: 'none',
        borderRadius: wide ? 12 : '50%',
        background: 悬停 && !忙 ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: 14,
        lineHeight: '20px',
        cursor: 忙 ? 'default' : 'pointer',
        opacity: 忙 ? 0.6 : 1,
        overflow: 'hidden',
      }

      const 图标 = {
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        // 16 太小、32 又顶得慌；22 跟旁边自带图标差不多一档，窄栏那个 36 的圆钮里放 20
        width: wide ? 22 : 20,
        height: wide ? 22 : 20,
        fontSize: wide ? 16 : 15,
        fontWeight: 500,
        lineHeight: 1,
      }

      // 图是纯黑剪影：<img> 在深色主题下会糊成一团，用 mask + currentColor 才跟着主题走
      const 图标画 = {
        ...图标,
        ...(图标图 ? {
          background: 'currentColor',
          WebkitMaskImage: 'url(' + 图标图 + ')',
          maskImage: 'url(' + 图标图 + ')',
          WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat',
          WebkitMaskPosition: 'center', maskPosition: 'center',
          WebkitMaskSize: 'contain', maskSize: 'contain',
        } : {}),
      }

      const 按钮 = h('button', {
        type: 'button',
        style: 钮,
        title: 说不出来 ? ('鱼鱼窝：' + 说不出来) : '打开鱼鱼窝',
        'aria-label': '鱼鱼窝',
        'aria-busy': 忙 ? 'true' : undefined,
        disabled: 忙,
        onClick: 点,
        onMouseEnter: () => 设悬停(true),
        onMouseLeave: () => 设悬停(false),
      },
        h('span', { style: 图标画, 'aria-hidden': 'true' }, 图标图 === '' ? '鱼' : null),
        wide ? h('span', {
          style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, 忙 ? '正在开…' : 说不出来 ? '鱼鱼窝未打开' : '鱼鱼窝') : null)
      if (!说不出来) return 按钮
      return h('div', { style: { position: 'relative', width: wide ? '100%' : 36 } }, 按钮,
        h('div', { role: 'alert', style: {
          position: 'fixed', left: 12, bottom: 64, zIndex: 1000, boxSizing: 'border-box',
          width: 248, maxWidth: 'calc(100vw - 24px)', padding: '9px 12px', borderRadius: 8,
          background: 'var(--dsw-alias-interactive-bg-hover, #eee9e1)',
          color: 'var(--dsw-alias-label-primary, #302e29)', boxShadow: '0 4px 18px #0003',
          fontSize: 12, lineHeight: 1.5, overflowWrap: 'anywhere',
        } }, 说不出来))
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'fish-home', order: 56, label: () => '鱼鱼窝' },
          Section,
        ),
      )
      // 底部动作跟自带的插件按钮并排：order 10 排在没写 order（默认 0）的那个后面
      slots.inject('sidebar.footer.action', () =>
        slots.register(
          { name: 'sidebar.footer.action', id: 'fish-home', order: 10, label: '鱼鱼窝' },
          鱼鱼窝按钮,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
