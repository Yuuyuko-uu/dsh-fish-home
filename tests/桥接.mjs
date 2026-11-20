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
import { DatabaseSync } from 'node:sqlite'

const 家 = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-room-'))
process.env.DSH_HOME = 家

// 会话得自己选 —— 插件**不会**替人认（不选就是不选）
const 会话id = 'session-abcdef12-3456-7890-abcd-ef1234567890'
fs.writeFileSync(path.join(家, 'fish-room.json'), JSON.stringify({ 开: true, 会话: 会话id, 每轮注入现场: true }, null, 2), 'utf8')

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
let preStep;
let 会话活着 = true

const 上下文们 = []          // systemPrompt.context 挂上来的东西
let firstGoRegistration = true;
const 注册的工具 = []        // 挂到 agent 身上的工具
const 假agent = {
  session: { id: 'session-abcdef12-3456-7890-abcd-ef1234567890' },
  followup: async (消息) => { 收到的话.push(消息) },
  ctx: {
    systemPrompt: {
      context: (行) => { 上下文们.push(行); return () => { 行.__卸了 = true } },
    },
    tools: {
      register: (t) => {
        if(t.name==='fish_home_go'&&firstGoRegistration){firstGoRegistration=false;throw new Error('already registered');}
        注册的工具.push(t); return () => { t.__卸了 = true };
      },
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
const demoPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkCgAAAAASUVORK5CYII=','base64');
let photoView;
let photoAttempts=0, movement, livePresence, fakeDuplicateDraw=false, fakeInsufficientExchange=false, movementAttempts=0, movementError=null;
const farmWrites=[];
const farmHome=fs.mkdtempSync(path.join(os.tmpdir(),'fish-home-farm-api-'));
fs.writeFileSync(path.join(farmHome,'dsh-bridge.json'),'{"enabled":false}');
const {createAPI}=await import('file:///'+房间+'/../http.js');
const {createLifeStore}=await import('file:///'+房间+'/../life-store.js');
createLifeStore({dataDir:farmHome}).close();
const fixtureDb=new DatabaseSync(path.join(farmHome,'life.sqlite'));
try {
  const state=JSON.parse(fixtureDb.prepare("SELECT value FROM meta WHERE key='state'").get().value);
  state.coins=15000;
  state.cards.dust=70;
  fixtureDb.prepare("UPDATE meta SET value=? WHERE key='state'").run(JSON.stringify(state));
} finally { fixtureDb.close(); }
const farmAPI=await createAPI({dataDir:farmHome,weatherLookup:async place=>({
  place,weather:place==='海边'?'rain':'snow',temp:12,forecast:[{date:'2026-11-20',weather:'rain',min:8,max:13}],
})});
farmAPI.store.setSettings({autonomy:false});
farmAPI.store.farmSettings({autoCare:false,requestId:'test-disable-care'});
const 活动目录 = [{id:'sit_swing', label:'荡秋千', room:'garden'}]
const 服务 = http.createServer(async (req, res) => {
  const 址 = new URL(req.url, 'http://127.0.0.1')
  if(址.pathname==='/api/command'){
    if(farmAPI.store.getSnapshot().睡着){
      req.resume();
      res.writeHead(409,{'content-type':'application/json'}).end(JSON.stringify({ok:false,code:'ASLEEP',error:'大肥鱼正在睡觉，醒来后才能走。'}));return;
    }
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    movement=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    movementAttempts++;
    if(movementError){
      const failure=movementError;
      movementError=null;
      res.writeHead(409,{'content-type':'application/json'}).end(JSON.stringify({ok:false,...failure}));return;
    }
    livePresence={scene:'garden',visible:true,place:movement.args.dest,action:'idle',at:Date.now()};
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,presence:livePresence}));return;
  }
  if(fakeDuplicateDraw&&址.pathname==='/api/cards/draw'){
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,coins:100,cards:{catalog:[{id:'kimi-classic',title:'Kimi'},{id:'deepseek',title:'DeepSeek'}],owned:{'kimi-classic':{},deepseek:{}},dust:6,starlight:5},results:[{id:'kimi-classic',rarity:'5★',finish:3,first:false,converted:true,starlight:5},{id:'deepseek',rarity:'4★',finish:1,first:false,upgrade:true,dust:6}]}));return;
  }
  if(fakeInsufficientExchange&&址.pathname==='/api/cards/exchange'){
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:false,say:'需要 20 星辉，目前只有 0 星辉。'}));return;
  }
  if(req.method==='POST'&&址.pathname.startsWith('/api/farm/'))farmWrites.push(址.pathname);
  if(址.pathname==='/cards/kimi-classic/thumb.png'){
    res.writeHead(200,{'content-type':'image/png'}).end(demoPng);return;
  }
  if(/^\/api\/(cards|farm|sleep|state|kitchen|weather|settings)(?:$|\/)/.test(址.pathname)&&await farmAPI.handle(req,res))return;
  if(址.pathname==='/api/look'){
    const chunks=[];
    for await(const chunk of req)chunks.push(chunk);
    photoView=JSON.parse(Buffer.concat(chunks)).view;
    if(photoAttempts===2){photoAttempts++;res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:false,code:'DIFFERENT_SCENE',error:'大肥鱼在屋内，当前画面是庭院。切到「屋内」后再拍，她可以留在原地。'}));return;}
    if(++photoAttempts===1){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:false,error:'游戏网页正在重连。'}));return;}
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,url:'/api/shots/shot-123.png'}));return;
  }
  if(址.pathname==='/api/shots/shot-123.png'){
    res.writeHead(200,{'content-type':'image/png'}).end(demoPng);return;
  }
  if(址.pathname==='/api/life/activity'){
    if(址.searchParams.get('summary')==='1'){
      const state=farmAPI.store.getSnapshot();
      res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({
        ok:true,asOf:Date.now(),activity:state.activity,presence:livePresence,mood:state.mood,coins:state.coins,
        睡着:state.睡着,可叫醒:state.settings.可叫醒,
      }));return;
    }
    let input=null;
    if(req.method==='POST'){
      const chunks=[];
      for await(const chunk of req)chunks.push(chunk);
      input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(input?{activity:{...活动目录[0],action:input.id}}:{activity:{id:'old-wake',room:'bedroom',action:'idle',label:'起床'},presence:livePresence,options:活动目录}));
    return;
  }
  const 命中 = 路由表.get(址.pathname)
  if (!命中) { res.writeHead(404).end(); return }
  Promise.resolve(命中(req, res)).catch(() => { try { res.writeHead(500).end() } catch {} })
})
服务.listen(0, '127.0.0.1')
await once(服务, 'listening')
const 端口 = 服务.address().port
process.env.FISH_ROOM_PORT = String(端口);

const ctx = {
  webServer: {
    get port() { return 端口 },
    register: (r) => { 路由表.set(r.path, r.handler); return () => 路由表.delete(r.path) },
  },
  agents: 代理,
  llm: { listProviders: () => [{ id: 'gpt', name: 'GPT' }], listModels: async () => [{ id: 'gpt-image-2', name: 'GPT Image 2' }] },
  workspaceRegistry: { archivedSessionIds: ['session-archived-0000-0000-0000-000000000000'] },
  get: (名) => (名 === 'agents' ? 代理 : (名 === 'sessions' ? { flush: async () => {} } : undefined)),
  on: (名, cb) => { if (名 === 'session/event') 会话监听.push(cb); if(名==='agent/pre-step')preStep=cb; return () => {} },
  effect: (fn) => { const 摘 = fn(); return () => { try { 摘 && 摘() } catch {} } },
  inject: (needs,apply)=>apply({get:name=>name==='attachments'?{
    saveImage:async input=>{
      if(!input.data.equals(demoPng))throw Error('Unexpected image');
      return {attachmentId:'att-fake',mediaType:'image/png',bytes:demoPng.length,width:1,height:1};
    },
  }:undefined}),
  logger: { info() {} },
}

const 插件 = await import('../lib/host.js')
报('插件名字叫 fish-home（鱼鱼窝）', 插件.name === 'fish-home', 插件.name)
报('依赖声明齐全（少了 workspaceRegistry 归档过滤就会失效）',
  Array.isArray(插件.inject) && 插件.inject.join() === 'webServer,agents,sessions,sessionTitle,workspaceRegistry', String(插件.inject))

const 实例 = 插件.apply(ctx)
报('走路注册失败时农活仍挂到已经绑定的会话', 注册的工具.some(t=>t.name==='fish_home_farm'));
const 升级配置=JSON.parse(fs.readFileSync(path.join(家,'fish-room.json'),'utf8'))
报('旧版配置迁移后关闭逐轮现场注入',升级配置.每轮注入现场===false&&升级配置.上下文策略版本===2)

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

const 互动 = (action, id = `touch-${action}`, actorName) => 客户端.sendLifeEvent({ schema: LIFE_EVENT_SCHEMA, kind: 'touch', id, action, at: Date.now(), actorName })
const 互动结果 = await Promise.all(['pet', 'greet', 'kiss'].map(kind => 互动(kind)))
const 收到互动 = 收到的话.filter(m => m.source.kind === 'fish-home-touch')
报('三种底栏互动各自即时送给绑定的会话', 互动结果.every(r => r.delivered) && 收到互动.length === 3 && ['摸了摸', '招呼', '亲了'].every(text => 收到互动.some(m => m.content[0].text.includes(text))))
const 再摸 = await 互动('pet')
报('重放同一个互动编号不会再叫会话', 再摸.duplicate && 收到的话.filter(m => m.source.kind === 'fish-home-touch').length === 3)
报('未设置名字时仍用通用称呼，且只描述动作', 收到互动.find(m => m.content[0].text.includes('摸了摸'))?.content[0].text === '【鱼鱼窝互动】用户刚摸了摸你的头。')
await 客户端.sendPetState({ schema: PET_STATE_SCHEMA, at: Date.now(), snapshot: { settings: { 我的名字: '海盐' } } })
await 互动('greet', 'touch-from-snapshot')
报('旧版房间事件可读取快照里的设置', 收到的话.at(-1).content[0].text === '【鱼鱼窝互动】海盐刚向你打了个招呼。')
await 互动('kiss', 'touch-from-event', '海星')
报('刚改名后以事件携带的名字为准', 收到的话.at(-1).content[0].text === '【鱼鱼窝互动】海星刚亲了你一下。')
await 互动('pet', 'touch-cleared', '  ')
报('清空名字不会复用旧称呼', 收到的话.at(-1).content[0].text === '【鱼鱼窝互动】用户刚摸了摸你的头。')
await 客户端.paint('paint-test')
await 客户端.paint('paint-test')
报('画架明确请求即时送达且同一请求不重复', 收到的话.filter(m => m.source.kind === 'fish-home-paint').length === 1)

打事件('turn/start', { turn: 6 })
打事件('user/message', 收到互动[0])
打事件('assistant/message', { turn: 6, message: { role: 'assistant', content: [{ type: 'text', text: '被你摸头啦。' }] } })
打事件('turn/end', { turn: 6, reason: { kind: 'completed' } })
报('按钮回话不会占用排队中的普通聊天', await 等到(() => 收到事件.some(e => e.type === 'proactive.speak' && e.data.text === '被你摸头啦。')) && !收到事件.some(e => e.type === 'chat.reply' && e.data.requestId === 'req-test-0001'))

打事件('turn/start', { turn: 7 })
打事件('user/message', 收到的话[0])
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
const 开启现场上下文=await (await fetch('http://127.0.0.1:'+端口+'/dsh-fish-home/save',{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({每轮注入现场:true}),
})).json()
报('主动开启时可以重新挂载上下文',开启现场上下文.每轮注入现场===true)
const 之前 = 收到的话.length
await 客户端.sendLifeEvent({ schema: LIFE_EVENT_SCHEMA, id: 'scene-1', at: Date.now(), kind: 'scene', text: '拎起两次；推了三下秋千。' })
报('场景摘要只进入上下文，不发起对话', 收到的话.length === 之前 && 上下文们.some(x => x.text().includes('推了三下秋千')))

/* ── 会话没开着 → 明说，不装死 ───────────────────────── */

会话活着 = false
let 互动没送达 = false
try { await 互动('pet', 'closed-touch') } catch (error) { 互动没送达 = error.code === 'SESSION_SLEEPING' }
报('绑定会话没开时，按钮送达明确失败', 互动没送达)
let 睡着的错 = null
try { await 客户端.chat({ requestId: 'req-test-0003', text: '在吗' }) } catch (error) { 睡着的错 = error }
报('会话没开着 → 明确报错（不是静默丢掉）', 睡着的错 && String(睡着的错.code || '') === 'SESSION_SLEEPING',
  睡着的错 ? String(睡着的错.code) + ' ' + String(睡着的错.message) : '没报错')
会话活着 = true

/* ── 时间同步：房间几点要递进 DSH ─────────────────────── */

await 客户端.sendPetState({
  schema: PET_STATE_SCHEMA, revision: 2, at: Date.now(), sessionId: 假agent.session.id,
  room:{url:'http://127.0.0.1:'+端口},
  snapshot: {
    name: '大肥鱼', ageDays: 3, mood: 68, affection: 60, needs: {},
    activity: { id:'seen', label: '看书', action: 'read', room: 'study' }, thought: '', now: Date.now(),
    hour: 21.75, period: '夜晚', weather: 'rain', realtime: true,
    observation: { activityId:'seen', phase: 'arrived', scene: 'indoor', at:Date.now() },
  },
  recent: [], recentChat: [],
})
打事件('turn/start', { turn: 9 })
报('一开口就把「房间时间」挂进系统提示词', await 等到(() => 上下文们.length > 0), String(上下文们.length))
const 那句 = 上下文们.length ? String(上下文们[0].text()) : ''
报('那句话里有几点、夜里、下雨、她在干嘛',
  /21:4\d/.test(那句) && 那句.includes('夜晚') && 那句.includes('下雨') && 那句.includes('书房') && 那句.includes('看书'), 那句)
const 日常工具 = 注册的工具.find(t=>t.name==='fish_home_activity');
const 目录结果 = await 日常工具.execute();
报('会话能查询日常活动目录', 目录结果.ok && 目录结果.options?.[0]?.id==='sit_swing');
const 选择结果 = await 日常工具.execute({id:'sit_swing'});
报('会话能选择已知活动并拿到接受结果', 选择结果.ok && 选择结果.activity?.action==='sit_swing' && 选择结果.说.includes('已安排'));
const 鱼鱼窝工具 = 注册的工具.find(t=>t.name==='fish_home');
const 活动状态 = await 鱼鱼窝工具.execute({what:'status'});
报('状态工具按 DSH 的参数顺序渲染实际结果', 活动状态.ok && 鱼鱼窝工具.output.render({what:'status'},活动状态)[0].text==='活动：闲着。');
const 看一眼=注册的工具.find(t=>t.name==='fish_home_look');
const 照片=await 看一眼.execute({说明:'庭院'});
报('看一眼默认从角色第一人称拍摄并返回图片附件', photoView==='dayu' && 看一眼.output.render({说明:'庭院'},照片).some(block=>block.type==='image'&&block.attachment.attachmentId==='att-fake'));
报('临时重连后截图重试并提供可打开的 .png', photoAttempts===2 && 照片.file?.endsWith('.png') && fs.readFileSync(照片.file).equals(demoPng) && 照片.url?.endsWith('.png'));
const 错场=await 看一眼.execute();
报('截图场景不匹配明确指出要切到哪里，无需重试',!错场.ok&&错场.说.includes('切到「屋内」')&&photoAttempts===3);
const 走路=注册的工具.find(t=>t.name==='fish_home_go');
const 到菜田=await 走路.execute({to:'field'});
报('英文地点别名送达并要求到达确认', 到菜田.ok && movement.args.dest==='field' && movement.wait===true);
const attemptsBeforeRetry=movementAttempts;
movementError={code:'VIEW_CHANGED',error:'画面已变更，未能确认到达。'};
const 到池塘=await 走路.execute({dest:'pond'});
报('切换画面时走路自动重试一次并等实际到达',到池塘.ok&&movement.args.dest==='pond'&&movementAttempts===attemptsBeforeRetry+2);
const attemptsBeforeBlocked=movementAttempts;
movementError={error:'鱼鱼现在走不开。'};
const blocked=await 走路.execute({dest:'pond'});
报('角色走不开时不自动再次打断',!blocked.ok&&movementAttempts===attemptsBeforeBlocked+1);
const 池边状态=await 鱼鱼窝工具.execute({what:'status'});
报('go 后立即查状态显示实际池边，忽略旧起床记录',池边状态.说==='活动：庭院 · 池塘边 · 闲着。');
const 自然移动前=movementAttempts;
打事件('turn/start',{turn:10});
打事件('assistant/message',{turn:10,message:{role:'assistant',content:[{type:'text',text:'我先回房间了。'}]}});
打事件('turn/end',{turn:10,reason:{kind:'completed'}});
报('她明确说自己回房间时身体只执行一次并等待到达',await 等到(()=>movementAttempts===自然移动前+1)&&movement.args.dest==='indoor'&&movement.wait===true);
const 农活=注册的工具.find(t=>t.name==='fish_home_farm');
const 列田=await 农活.execute({op:'list'});
const 买种=await 农活.execute({op:'buy',item:'radish',count:10});
const seedBefore=farmAPI.store.钱袋().seeds.radish;
const legacy=await 农活.execute({op:'plant',item:'radish',plotId:'bed-0-0-0'});
const 种下=await 农活.execute({op:'plant',item:'萝卜',count:10});
const 重复种下=await 农活.execute({op:'plant',item:'萝卜',count:10});
const afterPlant=farmAPI.store.farmSnapshot();
报('单格工具参数不再暴露，10 格播种一次且重复请求不再消耗库存',列田.ok&&!列田.说.includes('bed-0-')&&买种.ok&&!legacy.ok&&!Object.hasOwn(农活.parameters.properties,'plotId')&&种下.ok&&!重复种下.ok&&afterPlant.farm.plots.filter(p=>p.cropId==='radish').length===10&&seedBefore-(afterPlant.wallet.seeds.radish||0)===10);
const 浇水=await 农活.execute({op:'water',zone:'vegetable'});
报('批量浇水覆盖所有需要浇水的作物',浇水.ok&&farmAPI.store.farmSnapshot().farm.plots.filter(p=>p.wateredUntil>0).length===10);
await 农活.execute({op:'buy',item:'guppy',count:3});
const stocked=await 农活.execute({op:'stock',item:'guppy',count:3});
farmAPI.store.tick(Date.now()+8*24*3600000);
const 捞鱼=await 农活.execute({op:'catch',item:'guppy',count:2});
const 捞鱼后=farmAPI.store.farmSnapshot();
const pondNow=await 鱼鱼窝工具.execute({what:'pond'});
报('成鱼按批次进鱼篓，查询直接读当前池塘而不是插件快照',stocked.ok&&捞鱼.ok&&捞鱼后.wallet.fish.guppy===2&&捞鱼后.farm.pond.fish.length===1&&pondNow.说.includes('池塘在养 1/8')&&pondNow.说.includes('鱼篓成鱼（已捞、可卖）：guppy×2'),pondNow.说);
const 收成=await 农活.execute({op:'harvest',item:'radish'});
const afterHarvest=farmAPI.store.farmSnapshot();
const 出货=await 农活.execute({op:'sell',item:'radish',count:10});
报('批量收菜写入背包，出售实际入账',收成.ok&&afterHarvest.wallet.crops.radish===10&&!afterHarvest.farm.plots.some(p=>p.cropId)&&出货.ok&&farmAPI.store.钱袋().coins>afterHarvest.wallet.coins);
const 概率=await 鱼鱼窝工具.execute({what:'pity'});
const 抽卡=注册的工具.find(t=>t.name==='fish_home_draw');
const 抽之前=JSON.stringify(farmAPI.store.cardState());
const 钱之前=farmAPI.store.钱袋().coins;
const 错池=await 抽卡.execute({pool:'nonsense',count:1});
const 错数=await 抽卡.execute({pool:'standard',count:2});
报('错卡池和错数量不改变金币或保底', !错池.ok&&!错数.ok&&钱之前===farmAPI.store.钱袋().coins&&抽之前===JSON.stringify(farmAPI.store.cardState()));
const 抽到=await 抽卡.execute({pool:'standard',count:1});
报('保底可单独查询，抽卡返回更新后的保底与下一抽概率', 概率.ok && 概率.说.includes('还差 90 抽') && 抽到.ok && 抽到.pity.top>=89 && Object.hasOwn(抽到.rates,'top'));
fakeDuplicateDraw=true;
const 重复卡=await 抽卡.execute({pool:'standard',count:10});
报('重复卡清楚区分品质升级、分解与新增收藏数量',重复卡.ok&&重复卡.说.includes('Kimi（5★） · 已拥有 · 珠光重复分解')&&重复卡.说.includes('DeepSeek（4★） · 已拥有 · 升至银箔')&&重复卡.说.includes('卡册 2/2，本次新收藏 0 张'),重复卡.说);
fakeDuplicateDraw=false;
const 工具名=name=>注册的工具.find(t=>t.name===name);
const 看卡=工具名('fish_home_card');
const 卡面=await 看卡.execute({card:'kimi-classic'});
报('卡面按需只返回一个图片附件，抽卡只返回文字',卡面.ok&&看卡.output.render({},卡面).filter(b=>b.type==='image').length===1&&抽卡.output.render({},抽到).every(b=>b.type==='text'));
let dust=farmAPI.store.cardState().dust;
for(let i=0;i<12&&dust<65;i++){
  const value=await 抽卡.execute({pool:'standard',count:10});
  if(!value.ok)break;
  dust=farmAPI.store.cardState().dust;
}
const 兑换前=farmAPI.store.cardState();
const 星辉=await 抽卡.execute({op:'exchange',kind:'starlight',quantity:2});
const 兑换后=farmAPI.store.cardState();
报('星尘换星辉实际记账，扣 30 尘加 2 辉',星辉.ok&&兑换后.starlight===兑换前.starlight+2&&兑换后.dust===兑换前.dust-30,星辉.说);
const 换钱=await 抽卡.execute({op:'exchange',kind:'coins',quantity:1});
const 待换卡=farmAPI.store.cardState().catalog.find(c=>c.exchange?.cost===15&&!farmAPI.store.cardState().owned[c.id]);
const 换卡=待换卡&&await 抽卡.execute({op:'exchange',kind:'card',item:待换卡.id});
报('金币和指定卡通过同一工具兑换',换钱.ok&&换钱.说.includes('8 金币')&&换卡?.ok&&farmAPI.store.cardState().owned[待换卡.id]);
const playerNotices=[];
const publishOriginal=farmAPI.bridge.publishLifeEvent;
farmAPI.bridge.publishLifeEvent=async event=>{
  playerNotices.push(event);
  return 客户端.sendLifeEvent({schema:LIFE_EVENT_SCHEMA,...event});
};
const roomPost=async(route,data)=>fetch('http://127.0.0.1:'+端口+route,{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data),
}).then(r=>r.json());
const purchase={kind:'seed',id:'radish',数量:2,requestId:'notice-player-buy'};
farmAPI.store.setSettings({我的名字:'小鱿鱼'});
const bought=await roomPost('/api/farm/buy',purchase);
await roomPost('/api/farm/buy',purchase);
const batch=await roomPost('/api/farm/plant-batch',{cropId:'radish',count:2,requestId:'notice-player-plant'});
const walletBeforeDraw=farmAPI.store.cardState();
await 客户端.sendPetState({schema:PET_STATE_SCHEMA,at:Date.now(),snapshot:{
  coins:walletBeforeDraw.coins,卡册:{尘:walletBeforeDraw.dust,星辉:walletBeforeDraw.starlight},
}});
const drawn=await roomPost('/api/cards/draw',{pool:'standard',count:10,requestId:'notice-player-draw'});
const walletNow=await 鱼鱼窝工具.execute({what:'wallet'});
报('钱包即时读取同一正式存档的结算结果，不用上次同步的金额',walletNow.ok&&drawn.coins===walletBeforeDraw.coins-1000&&walletNow.说.includes(drawn.coins+' 金币、'+drawn.cards.dust+' 星尘、'+drawn.cards.starlight+' 星辉'));
const laterBuy=await 农活.execute({op:'buy',item:'radish',count:1});
const afterLaterBuy=await 鱼鱼窝工具.execute({what:'wallet'});
报('回执保留当时余额，后续查钱包反映之后的交易',laterBuy.ok&&afterLaterBuy.说.includes((drawn.coins-10)+' 金币')&&playerNotices[2].text.includes('结算后余额 '+drawn.coins+' 金币'));
fakeInsufficientExchange=true;
const denied=await 抽卡.execute({op:'exchange',kind:'card',item:'glm-classic'});
fakeInsufficientExchange=false;
报('兑换材料不足显示所需星辉和当前持有量',!denied.ok&&denied.说.includes('需要 20 星辉，目前只有 0 星辉'));
const titles=drawn.results.filter(d=>d.id).map(d=>drawn.cards.catalog.find(c=>c.id===d.id)?.title);
报('买种、批量播种和抽卡分别只发一条，抽卡通知列出卡名',bought.ok&&batch.ok&&drawn.ok&&playerNotices.length===3&&/^正式存档 \d{2}:\d{2}:\d{2}，/.test(playerNotices[0].text)&&playerNotices[0].text.includes('小鱿鱼买了 萝卜种子×2')&&playerNotices[1].text.includes('播种了 2 格萝卜')&&titles.every(title=>playerNotices[2].text.includes(title))&&await 等到(()=>收到的话.some(m=>m.content?.[0]?.text?.includes('小鱿鱼花了 1000 金币，抽了 10 张'))));
farmAPI.bridge.publishLifeEvent=publishOriginal;
const 卖价=await 鱼鱼窝工具.execute({what:'price'});
const 明日行情=await 鱼鱼窝工具.execute({what:'market'});
const 锦鲤卖价=await 鱼鱼窝工具.execute({what:'price',kind:'fish',item:'koi'});
报('行情覆盖整张价目，支持只查一种鱼和查看预告',卖价.说.split('\n').length===41&&明日行情.说.split('\n').length===2&&锦鲤卖价.说.includes('锦鲤')&&!锦鲤卖价.说.includes('孔雀鱼'));
const 紧凑布局=await 农活.execute({op:'list',scope:'layout'});
const 逐格布局=await 农活.execute({op:'list',scope:'layout',bed:0});
报('按需查看六个 3×3 区或展开单畦逐格种植',紧凑布局.ok&&紧凑布局.说.includes('bed-2')&&!紧凑布局.说.includes(' | ')&&逐格布局.说.includes('萝卜×2')&&逐格布局.说.includes('萝卜 |')&&!逐格布局.说.includes('bed-1'));
打事件('turn/start',{turn:81});
farmAPI.store.tick(farmAPI.store.getSnapshot().now+3600000);
const beforeReplant=farmWrites.length;
const 收后补种=await 农活.execute({op:'replant',item:'萝卜',buyMissing:true});
const 重复补种=await 农活.execute({op:'replant',item:'radish',buyMissing:true});
const 补种后=farmAPI.store.farmSnapshot();
报('一次调用收熟萝卜、补买种子及回种，同一轮改用英文名也不会再执行',收后补种.ok&&收后补种.说.includes('实际收进背包 2 份')&&收后补种.说.includes('补买了 1 份')&&收后补种.说.includes('播种了 2 格萝卜')&&重复补种.ok&&重复补种.说.includes('原回执')&&farmWrites.slice(beforeReplant).join()==='/api/farm/harvest-batch,/api/farm/buy,/api/farm/plant-batch'&&补种后.farm.plots.filter(p=>p.cropId==='radish').length===2,JSON.stringify({收后补种,重复补种}));
打事件('turn/end',{turn:81,reason:{kind:'completed'}});
const 菜谱=工具名('fish_home_recipe');
const 今天的菜=await 菜谱.execute();
const 菜谱详情=await 菜谱.execute({detail:true});
farmAPI.store.setSettings({学菜:false});
const 仅菜名=await 菜谱.execute({detail:true});
const 菜谱排版=await 菜谱.execute({query:'麻婆豆腐',detail:true});
报('菜谱默认简短，按需给做法，关闭学菜即不返回详情',今天的菜.ok&&!今天的菜.说.includes('**做法**')&&菜谱详情.说.includes('**做法**')&&仅菜名.说.includes('只显示菜名')&&!仅菜名.说.includes('**做法**')&&菜谱排版.说.startsWith('麻婆豆腐')&&!菜谱排版.说.includes('meat_dish/'));
const 设置天气=async settings=>fetch('http://127.0.0.1:'+端口+'/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(settings)});
await 设置天气({天气同步:true,天气地区:'海边'});
const 下雨=await 鱼鱼窝工具.execute({what:'weather'});
await 设置天气({天气地区:'山里'});
const 下雪=await 鱼鱼窝工具.execute({what:'weather'});
await 设置天气({天气同步:false,手动天气:'clear'});
const 预报=await 鱼鱼窝工具.execute({what:'forecast'});
报('天气读取跟随地区变动，手动晴天和当地预报分别显示',下雨.说.includes('庭院：雨')&&下雪.说.includes('庭院：雪')&&预报.说.includes('庭院：晴（手动天气）')&&预报.说.includes('2026-11-20 雨'),预报.说);
const 睡眠工具=注册的工具.find(t=>t.name==='sleep');
const beforeWake = 收到的话.length;
const probe=(agent=假agent,messages=[{role:'user'}])=>preStep({agent,messages},()=>({kind:'enter'}));
farmAPI.store.setSettings({可叫醒:false});
const sleeping=await 睡眠工具.execute({asleep:true});
报('不可叫醒时只拦绑定的会话',sleeping.ok && (await probe()).kind==='reject' && (await probe(假归档agent)).kind==='enter');
const nightEnd=farmAPI.store.getSnapshot().activity.until;
farmAPI.store.tick(nightEnd+1);
await 客户端.sendPetState({schema:PET_STATE_SCHEMA,at:Date.now(),snapshot:{activity:farmAPI.store.getSnapshot().activity}});
报('自然醒后会话恢复，睡眠变化不主动投递消息',(await probe()).kind==='enter'&&收到的话.length===beforeWake);
farmAPI.store.setSettings({可叫醒:true});
await 睡眠工具.execute({asleep:true});
报('允许叫醒时无新消息继续睡，有消息才叫醒',(await probe(假agent,[])).kind==='enter'&&farmAPI.store.getSnapshot().睡着&&(await probe()).kind==='enter'&&!farmAPI.store.getSnapshot().睡着);
const oldMessage={role:'user',id:'previous-sleep-request'};
await probe(假agent,[oldMessage]);
await 睡眠工具.execute({asleep:true});
const beforeSleepMove=movementAttempts;
await probe(假agent,[{...oldMessage},{role:'tool',id:'sleep-tool-result'}]);
const asleepGo=await 走路.execute({dest:'garden'});
报('同一条用户消息随工具回执重现时不叫醒，睡着也不会发出移动命令',!asleepGo.ok&&asleepGo.说.includes('正在睡觉')&&farmAPI.store.getSnapshot().睡着&&movementAttempts===beforeSleepMove);
const wakeProbe=await probe(假agent,[{role:'user',id:'user-asks-to-go-garden'}]);
const afterWakeGo=await 走路.execute({dest:'garden'});
报('允许叫醒的新消息使走路回执注明先叫醒',wakeProbe.kind==='enter'&&afterWakeGo.ok&&afterWakeGo.说.includes('已先叫醒')&&afterWakeGo.说.includes('已到达')&&!farmAPI.store.getSnapshot().睡着);
await 客户端.sendPetState({schema:PET_STATE_SCHEMA,at:Date.now(),snapshot:{activity:{room:'garden',action:'idle'},presence:livePresence}});
livePresence={scene:'indoor',visible:true,place:'bedroom',action:'idle',at:Date.now()};
const currentPanel=await fetch('http://127.0.0.1:'+端口+'/dsh-fish-home/state').then(r=>r.json());
报('DSH 状态栏无需主动查询 status 就显示当前卧室画面',currentPanel.房间那句.includes('屋内 · 卧室')&&!currentPanel.房间那句.includes('庭院'));
await probe(假agent,[]);
报('会话上下文也会在下一步前读当前卧室画面',上下文们.some(c=>c.name==='fish-home'&&c.text().includes('屋内 · 卧室')));
const beforeNotices=收到的话.length;
const publishNotice=(id,kind,extra)=>客户端.sendLifeEvent({schema:LIFE_EVENT_SCHEMA,id,at:Date.now(),kind,text:'这里是生活通知。',...extra});
await publishNotice('milestone-1','milestone');
await publishNotice('milestone-1','milestone');
await publishNotice('wallet-1','wallet');
await publishNotice('swing-batch-1','scene',{reaction:'swing'});
await publishNotice('wrong-session-1','milestone',{sessionId:'session-wrong'});
报('成熟、抽卡和一批推秋千各送一次，并且旧会话的通知不会串线', 收到的话.length===beforeNotices+3 && 收到的话.slice(-3).every(m=>m.source.kind==='fish-home-life'));
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
    && 收到的话.at(-1).source.kind === 'fish-home-paint'
    && 收到的话.at(-1).content[0].text === '【鱼鱼窝互动】用户刚在画架上点了「画画」。',
  JSON.stringify(通知) + ' / ' + JSON.stringify(收到的话.at(-1)?.content))

// 她自己决定画什么，调工具
打事件('turn/start', { turn: 11 })
await 等到(() => 注册的工具.some((t) => t.name === 'paint'))
const 画工具 = 注册的工具.find((t) => t.name === 'paint')
报('她手上有一个 paint 工具', Boolean(画工具), 注册的工具.map((t) => t.name).join(','))
farmAPI.store.setSettings({画图:false});
const 关闭画图=await 画工具.execute({prompt:'不调用生图'});
报('关闭画图时会话工具不会生图',!关闭画图.ok&&关闭画图.说.includes('开关关着'));
farmAPI.store.setSettings({画图:true});
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
await farmAPI.close();
画服务.close()

const oldDays=await 客户端.days();
const oldSession=await (await fetch(发现.url+'/days',{headers:{Authorization:'Bearer '+发现.token}})).json();
const switchReply=await fetch('http://127.0.0.1:'+端口+'/dsh-fish-home/save',{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({会话:归档会话id}),
});
const newDays=await 客户端.days();
const newMemories=await 客户端.memories();
报('换绑定后天数和记忆一起改用新会话', switchReply.ok&&oldDays.days>0&&oldSession.sessionId===会话id&&newDays.days>0&&newMemories.total===0);
报('换绑的事件立即同步给鱼鱼窝', await 等到(()=>收到事件.some(e=>e.type==='bridge.notice'&&e.data.code==='BINDING_CHANGED')));

/* ── 收尾 ─────────────────────────────────────────────── */

流.abort?.()
await new Promise((r) => setTimeout(r, 30))
服务.closeAllConnections?.()
服务.close()

console.log('')
console.log(挂 === 0 ? '全过' : ('挂了 ' + 挂 + ' 条'))
process.exit(挂 === 0 ? 0 : 1)
