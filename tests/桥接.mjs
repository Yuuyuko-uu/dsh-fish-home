// 鱼鱼窝桥接 · 自测
//
// 用「大肥鱼的小日子」那边的 BridgeClient 真连一次 —— 不是自己造一个客户端，
// 是拿房间自己的那份代码来验，这样契约对不上当场就会红。
//
// 跑法： node tests/桥接.mjs

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'

const 家 = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-room-'))
process.env.DSH_HOME = 家
// 自测里别让「她刚醒」的 10 秒定时器插手，免得它去读真房间、给假 agent 递话
process.env.FISH_ROOM_WAKE_TICK_MS = '3600000'

// 会话得自己选 —— 插件**不会**替人认（不选就是不选）
const 会话id = 'session-abcdef12-3456-7890-abcd-ef1234567890'
fs.writeFileSync(path.join(家, 'fish-room.json'), JSON.stringify({ 开: true, 会话: 会话id }, null, 2), 'utf8')

const 房间 = 'D:/1/大肥鱼的小日子/server/bridge'
const { BridgeClient } = await import('file:///' + 房间 + '/client.js')
const { BRIDGE_SCHEMA, PET_STATE_SCHEMA, LIFE_EVENT_SCHEMA } = await import('file:///' + 房间 + '/contract.js')

let 挂 = 0
const 报 = (标, 过, 细) => {
  if (!过) 挂++
  console.log((过 ? 'PASS  ' : 'FAIL  ') + 标 + (细 ? '  :: ' + 细 : ''))
}

/* ── 假的 DSH ─────────────────────────────────────────── */

const 收到的话 = []          // followup 进来的东西
const 会话监听 = []
let 会话活着 = true

const 上下文们 = []          // systemPrompt.context 挂上来的东西
const 注册的工具 = []        // 挂到 agent 身上的工具
const 假agent = {
  session: { id: 'session-abcdef12-3456-7890-abcd-ef1234567890' },
  followup: async (消息) => { 收到的话.push(消息) },
  ctx: {
    systemPrompt: {
      context: (行) => { 上下文们.push(行); return () => { 行.__卸了 = true } },
    },
    tools: {
      register: (t) => { 注册的工具.push(t); return () => { t.__卸了 = true } },
    },
  },
}

const 归档会话id = 'session-archived-0000-0000-0000-000000000000'
const 假归档agent = {
  session: { id: 归档会话id, meta: {} },
  followup: async () => {},
  ctx: { systemPrompt: { context: () => () => {} } },
}
const 代理 = {
  get: (id) => {
    if (!会话活着) return undefined
    const 键 = String(id)
    const 真 = 'session-abcdef12-3456-7890-abcd-ef1234567890'
    if (键 === 归档会话id) return 假归档agent
    return (键 === 真 || 键 === 真.slice('session-'.length)) ? 假agent : undefined
  },
  list: () => (会话活着 ? [假agent, 假归档agent] : []),
}

// 真的 http 服务，交给插件注册路由
const 路由表 = new Map()
const 服务 = http.createServer((req, res) => {
  const 址 = new URL(req.url, 'http://127.0.0.1')
  const 命中 = 路由表.get(址.pathname)
  if (!命中) { res.writeHead(404).end(); return }
  Promise.resolve(命中(req, res)).catch(() => { try { res.writeHead(500).end() } catch {} })
})
服务.listen(0, '127.0.0.1')
await once(服务, 'listening')
const 端口 = 服务.address().port

const ctx = {
  webServer: {
    get port() { return 端口 },
    register: (r) => { 路由表.set(r.path, r.handler); return () => 路由表.delete(r.path) },
  },
  agents: 代理,
  llm: { listProviders: () => [{ id: 'gpt', name: 'GPT' }], listModels: async () => [{ id: 'gpt-image-2', name: 'GPT Image 2' }] },
  workspaceRegistry: { archivedSessionIds: ['session-archived-0000-0000-0000-000000000000'] },
  get: (名) => (名 === 'agents' ? 代理 : (名 === 'sessions' ? { flush: async () => {} } : undefined)),
  on: (名, cb) => { if (名 === 'session/event') 会话监听.push(cb); return () => {} },
  effect: (fn) => { const 摘 = fn(); return () => { try { 摘 && 摘() } catch {} } },
  logger: { info() {} },
}

const 插件 = await import('../lib/host.js')
报('插件名字叫 fish-home（鱼鱼窝）', 插件.name === 'fish-home', 插件.name)
报('依赖声明齐全（少了 workspaceRegistry 归档过滤就会失效）',
  Array.isArray(插件.inject) && 插件.inject.join() === 'webServer,agents,sessions,sessionTitle,workspaceRegistry', String(插件.inject))

const 实例 = 插件.apply(ctx)

/* ── 发现文件 ─────────────────────────────────────────── */

const 发现 = JSON.parse(fs.readFileSync(path.join(家, 'fish-room.discovery.json'), 'utf8'))
报('发现文件写出来了', 发现.schema === 'dsh.fish-room.discovery/1', JSON.stringify(发现).slice(0, 120))
报('发现文件里的地址是本机 /fish-room/v1', 发现.url === 'http://127.0.0.1:' + 端口 + '/fish-room/v1', 发现.url)
报('令牌够长（房间那边要求 ≥16 位）', String(发现.token || '').length >= 16, String(发现.token || '').length)
报('不选就是不选（插件不会自己认一间）', 发现.sessionId === 会话id, 发现.sessionId)

/* ── 拿房间自己的客户端连 ─────────────────────────────── */

const 客户端 = new BridgeClient({
  baseUrl: 发现.url,
  token: 发现.token,
  sessionId: 发现.sessionId,
  chatTimeoutMs: 8000,
  publishIntervalMs: 50,
})

const 健康 = await 客户端.health()
报('健康检查通过、版本对得上', 健康.ok === true && 健康.schema === BRIDGE_SCHEMA, JSON.stringify(健康).slice(0, 160))
报('健康检查报出了绑定的会话', 健康.sessionId === 假agent.session.id, 健康.sessionId)

// 令牌不对必须 401
const 错客户端 = new BridgeClient({ baseUrl: 发现.url, token: 'x'.repeat(32), sessionId: '', chatTimeoutMs: 3000 })
let 被拒 = ''
try { await 错客户端.health() } catch (error) { 被拒 = String(error.code || error.message) }
报('令牌不对 → 401 被拒', 被拒 === 'HTTP_401' || 被拒 === 'UNAUTHORIZED', 被拒)

/* ── 回忆簿 ───────────────────────────────────────────── */
{
  fs.mkdirSync(path.join(家, 'fish-memory'), { recursive: true })
  fs.writeFileSync(path.join(家, 'fish-memory', 会话id + '.json'), JSON.stringify({
    memories: [{ id: 'x1', text: '她说想去看海', at: '2026-11-01T10:00:00.000Z' }],
  }), 'utf8')
  const 档 = path.join(家, '档案')
  fs.mkdirSync(path.join(档, '日记'), { recursive: true })
  fs.writeFileSync(path.join(档, '日记', '2026-11-07.md'), '下雨，她没出门。', 'utf8')
  fs.writeFileSync(path.join(档, '记忆卡.md'), '## 一、她\n\n- 她叫小鱿鱼\n', 'utf8')
  fs.mkdirSync(path.join(家, 'xingxi'), { recursive: true })
  fs.writeFileSync(path.join(家, 'xingxi', 'config.json'), JSON.stringify({ 绑定: { [会话id]: 档 } }), 'utf8')

  const 记 = await 客户端.memories({ limit: 20 })
  报('回忆簿：记住的事 + 日记都拿到了（成长已摘掉）', 记.total === 2, String(记.total))
  报('回忆簿：只有 fact / daily 两种',
    new Set((记.items || []).map((x) => x.kind)).size === 2,
    JSON.stringify((记.items || []).map((x) => x.kind)))
  const 搜 = await 客户端.memories({ q: '海' })
  报('回忆簿：搜「海」只剩一条', 搜.total === 1 && String(搜.items[0].text).includes('海'), String(搜.total))
  const 只看 = await 客户端.memories({ kind: 'daily' })
  报('回忆簿：只看日记', 只看.total === 1 && 只看.items[0].kind === 'daily', String(只看.total))
}


/* ── 开事件流 ─────────────────────────────────────────── */

const 收到事件 = []
let 流开着 = false
const 流 = 客户端.openStream({
  since: 0,
  onOpen: () => { 流开着 = true },
  onEvent: (事件) => { 收到事件.push(事件) },
  onInvalid: (错误) => { 收到事件.push({ type: 'BAD', data: { 说: String(错误 && 错误.message) } }) },
})
const 等到 = async (判, 毫秒 = 3000) => {
  const 起 = Date.now()
  while (Date.now() - 起 < 毫秒) {
    if (判()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return false
}
报('事件流连上了', await 等到(() => 流开着), '')
报('连上先收到 bridge.hello', await 等到(() => 收到事件.some((e) => e.type === 'bridge.hello')),
  收到事件.map((e) => e.type).join(','))

/* ── 房间打字 → 进会话 ───────────────────────────────── */

const 聊天 = await 客户端.chat({ requestId: 'req-test-0001', text: '你在房间里做什么呀？' })
报('打字被收下了', 聊天.ok === true && 聊天.accepted === true, JSON.stringify(聊天))
报('真的送进了会话', 收到的话.length === 1 && 收到的话[0].content[0].text === '你在房间里做什么呀？',
  JSON.stringify(收到的话[0] && 收到的话[0].content))
报('送进去的话标着 fish-room（别的插件认得出来）', 收到的话[0].source && 收到的话[0].source.kind === 'fish-home',
  JSON.stringify(收到的话[0] && 收到的话[0].source))

/* ── 会话回话 → 递回房间 ─────────────────────────────── */

const 会话 = { id: 假agent.session.id }
const 打事件 = (type, data) => { for (const cb of 会话监听) cb(会话, { type, data }) }

打事件('user/message', { role: 'user', content: [{ type: 'text', text: '你在房间里做什么呀？' }], source: { kind: 'fish-home' } })
打事件('assistant/message', { turn: 7, message: { role: 'assistant', content: [{ type: 'text', text: '好呀，我去把灯调暗一点。' }] } })
打事件('turn/end', { turn: 7, reason: { kind: 'completed' } })

报('回话递回房间了', await 等到(() => 收到事件.some((e) => e.type === 'chat.reply' && e.data.requestId === 'req-test-0001')),
  收到事件.map((e) => e.type).join(','))
const 回包 = 收到事件.find((e) => e.type === 'chat.reply' && e.data.requestId === 'req-test-0001')
报('回包带的是那句真话', 回包 && 回包.data.text === '好呀，我去把灯调暗一点。', JSON.stringify(回包 && 回包.data))
报('房间自己说的话不会回声成 chat.user', !收到事件.some((e) => e.type === 'chat.user' && /房间里做什么/.test(e.data.text)),
  收到事件.filter((e) => e.type === 'chat.user').map((e) => e.data.text).join(' | '))

/* ── 她在 DSH 窗口里自己打字 → 房间看得见 ───────────── */

打事件('user/message', { role: 'user', content: [{ type: 'text', text: '我在 DSH 里打的字' }], source: { kind: 'user' } })
报('DSH 窗口里打的字同步过去了', await 等到(() => 收到事件.some((e) => e.type === 'chat.user' && e.data.origin === 'dsh' && e.data.text === '我在 DSH 里打的字')),
  收到事件.filter((e) => e.type === 'chat.user').map((e) => e.data.text).join(' | '))

打事件('user/message', { role: 'user', content: [{ type: 'text', text: 'Current runtime context: ...' }], source: { kind: 'runtime-context' } })
await new Promise((r) => setTimeout(r, 60))
报('运行环境那种注入不会被当成她说话', !收到事件.some((e) => e.type === 'chat.user' && /Current runtime/.test(e.data.text)),
  收到事件.filter((e) => e.type === 'chat.user').map((e) => e.data.text).join(' | '))

/* ── 她主动开口（没有人在等回话）→ proactive.speak ──── */

打事件('assistant/message', { turn: 8, message: { role: 'assistant', content: [{ type: 'text', text: '我先去倒杯水。' }] } })
打事件('turn/end', { turn: 8, reason: { kind: 'completed' } })
报('没人等回话时，她说的话算「主动开口」', await 等到(() => 收到事件.some((e) => e.type === 'proactive.speak' && e.data.text === '我先去倒杯水。')),
  收到事件.map((e) => e.type).join(','))

/* ── 房间报生活数据 ───────────────────────────────────── */

const 状态回 = await 客户端.sendPetState({
  schema: PET_STATE_SCHEMA, revision: 1, at: Date.now(), sessionId: 假agent.session.id,
  snapshot: { name: '大肥鱼', ageDays: 3, mood: 72, affection: 60, needs: { energy: 40 }, activity: { label: '看书', action: 'read', room: 'study' }, thought: '有点困。', now: Date.now() },
  recent: [], recentChat: [],
})
报('房间的生活数据收下了', 状态回.ok === true, JSON.stringify(状态回))
const 状态 = await 客户端.status()
报('生活数据能查回来', 状态.pet && 状态.pet.snapshot && 状态.pet.snapshot.mood === 72, JSON.stringify(状态.pet && 状态.pet.snapshot))

const 事回 = await 客户端.sendLifeEvent({ schema: LIFE_EVENT_SCHEMA, id: 'life-1', at: Date.now(), kind: 'dsh_bili_done', title: '从 B 站回来了', text: '看了两个视频。' })
报('生活事件收下了', 事回.ok === true, JSON.stringify(事回))
const 重复 = await 客户端.sendLifeEvent({ schema: LIFE_EVENT_SCHEMA, id: 'life-1', at: Date.now(), kind: 'dsh_bili_done', title: '从 B 站回来了', text: '看了两个视频。' })
报('同一个事件不会记两遍', 重复.duplicate === true, JSON.stringify(重复))

/* ── 会话没开着 → 明说，不装死 ───────────────────────── */

会话活着 = false
let 睡着的错 = null
try { await 客户端.chat({ requestId: 'req-test-0003', text: '在吗' }) } catch (error) { 睡着的错 = error }
报('会话没开着 → 明确报错（不是静默丢掉）', 睡着的错 && String(睡着的错.code || '') === 'SESSION_SLEEPING',
  睡着的错 ? String(睡着的错.code) + ' ' + String(睡着的错.message) : '没报错')
会话活着 = true

/* ── 时间同步：房间几点要递进 DSH ─────────────────────── */

await 客户端.sendPetState({
  schema: PET_STATE_SCHEMA, revision: 2, at: Date.now(), sessionId: 假agent.session.id,
  snapshot: {
    name: '大肥鱼', ageDays: 3, mood: 68, affection: 60, needs: {},
    activity: { label: '看书', action: 'read', room: 'study' }, thought: '', now: Date.now(),
    hour: 21.75, period: '夜晚', weather: 'rain', realtime: true,
  },
  recent: [], recentChat: [],
})
打事件('turn/start', { turn: 9 })
报('一开口就把「房间时间」挂进系统提示词', await 等到(() => 上下文们.length > 0), String(上下文们.length))
const 那句 = 上下文们.length ? String(上下文们[0].text()) : ''
报('那句话里有几点、夜里、下雨、她在干嘛',
  /21:4\d/.test(那句) && 那句.includes('夜晚') && 那句.includes('下雨') && 那句.includes('看书'), 那句)
报('挂的名字叫 fish-home', 上下文们.length > 0 && 上下文们[0].name === 'fish-home', String(上下文们[0] && 上下文们[0].name))

/* ── 说话反馈：她一开始想，房间就该知道 ───────────────── */

报('「她开始想了」这个事件递出去了',
  await 等到(() => 收到事件.some((e) => e.type === 'chat.thinking')), 收到事件.map((e) => e.type).join(','))

/* ── 设置页那几条接口 ─────────────────────────────────── */

const 管理 = await (await fetch('http://127.0.0.1:' + 端口 + '/dsh-fish-home/state')).json()
报('设置页能读到状态', 管理.ok === true && 管理.会话 === 假agent.session.id, JSON.stringify(管理).slice(0, 120))
报('设置页能看到房间几点', /21:4\d/.test(String(管理.房间那句)), String(管理.房间那句))
报('设置页能看到会话名单', Array.isArray(管理.名单) && 管理.名单.length === 1, JSON.stringify(管理.名单))
报('归档的会话不出现在名单里', Array.isArray(管理.名单) && !管理.名单.some((x) => x.id === 归档会话id),
  JSON.stringify(管理.名单.map((x) => x.id)))

const 存 = await (await fetch('http://127.0.0.1:' + 端口 + '/dsh-fish-home/save', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ 转发主动开口: false }),
})).json()
报('设置页能存设置', 存.ok === true && 存.转发主动开口 === false, JSON.stringify(存).slice(0, 120))

const 试 = await (await fetch('http://127.0.0.1:' + 端口 + '/dsh-fish-home/try', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ 话: '试一句' }),
})).json()
报('设置页「试一句」真送进了会话', 试.ok === true && 收到的话.some((m) => m.content[0].text === '试一句'), JSON.stringify(试))

// 假生图接口：/v1/models 列模型、/v1/images/generations 回一张 1×1 的 PNG
const 画服务 = http.createServer(async (req, res) => {
  if (!String(req.headers.authorization || '').startsWith('Bearer ')) { res.writeHead(401).end('{}'); return }
  if (req.method === 'GET' && req.url.includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'gpt-image-2.5-sunburst' }, { id: 'gpt-image-2' }] }))
    return
  }
  if (req.method === 'POST' && req.url.includes('/images/generations')) {
    let 体 = ''
    for await (const 块 of req) 体 += 块
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }] }))
    return
  }
  res.writeHead(404).end()
})
画服务.listen(0, '127.0.0.1')
await once(画服务, 'listening')
const 画端口 = 画服务.address().port

/* ── 模型列表：读的是**填的那个接口**，不是 DSH ─────────── */

const 没填时 = await (await fetch('http://127.0.0.1:' + 端口 + '/dsh-fish-home/models')).json()
报('没填地址密钥时明说先填', 没填时.ok === true && 没填时.providers.length === 0, JSON.stringify(没填时))

await fetch('http://127.0.0.1:' + 端口 + '/dsh-fish-home/save', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ 画图地址: 'http://127.0.0.1:' + 画端口 + '/v1', 画图密钥: 'k'.repeat(20), 画图模型: 'gpt-image-2' }),
})
const 模型 = await (await fetch('http://127.0.0.1:' + 端口 + '/dsh-fish-home/models')).json()
报('模型是从填的那个接口读的（不是 DSH 的）',
  模型.ok === true && 模型.providers.length === 1
    && 模型.providers[0].models.some((m) => m.id === 'gpt-image-2.5-sunburst'),
  JSON.stringify(模型).slice(0, 160))

/* ── 画架：点一下只是跟她说一声，画什么由她定 ─────────── */

const 点画架前 = 收到的话.length
const 通知 = await 客户端.paint()
报('点画架：只跟她说一声，不规定画什么',
  通知.ok === true && 收到的话.length === 点画架前 + 1
    && 收到的话.at(-1).content[0].text === '你走到画架前站了一会儿。想画什么，就画吧。',
  JSON.stringify(通知) + ' / ' + JSON.stringify(收到的话.at(-1)?.content))

// 她自己决定画什么，调工具
打事件('turn/start', { turn: 11 })
await 等到(() => 注册的工具.some((t) => t.name === 'paint'))
const 画工具 = 注册的工具.find((t) => t.name === 'paint')
报('她手上有一个 paint 工具', Boolean(画工具), 注册的工具.map((t) => t.name).join(','))
const 画结果 = await 画工具.execute({ prompt: '窗外的海，傍晚' })
报('她调 paint 就真画了', 画结果.ok === true, JSON.stringify(画结果))
报('画好的图顺着事件流递回房间',
  await 等到(() => 收到事件.some((e) => e.type === 'paint.image' && String(e.data.b64 || '').length > 20)),
  收到事件.map((e) => e.type).join(','))

const 缺 = await (await fetch('http://127.0.0.1:' + 端口 + '/dsh-fish-home/save', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ 画图模型: '' }),
})).json()
const 没配 = await (await fetch('http://127.0.0.1:' + 端口 + '/fish-room/v1/paint/draw', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + 发现.token },
  body: JSON.stringify({ prompt: '随便' }),
})).json()
报('生图：三样没填全就明说没配', 没配.ok === false && String(没配.error && 没配.error.code) === 'PAINT_NOT_CONFIGURED',
  JSON.stringify(没配).slice(0, 120))
画服务.closeAllConnections?.()
画服务.close()

/* ── 收尾 ─────────────────────────────────────────────── */

流.abort?.()
await new Promise((r) => setTimeout(r, 30))
服务.closeAllConnections?.()
服务.close()

console.log('')
console.log(挂 === 0 ? '全过' : ('挂了 ' + 挂 + ' 条'))
process.exit(挂 === 0 ? 0 : 1)
