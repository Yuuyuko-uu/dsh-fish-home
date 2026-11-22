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
fs.writeFileSync(path.join(家, 'fish-room.json'), JSON.stringify({ 开: true, 会话: 会话id, 每轮注入现场: true, 相伴起始日: '2024-01-01' }, null, 2), 'utf8')

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
let photoAttempts=0, movement, livePresence, fakeDuplicateDraw=false, fakeOldRoomHundred=false, fakeInsufficientExchange=false, movementAttempts=0, movementError=null;
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
let farmAPI=await createAPI({dataDir:farmHome,farmRandom:()=>.99,weatherLookup:async place=>({
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
  if(fakeOldRoomHundred&&址.pathname==='/api/cards/draw'){
    req.resume();res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({ok:false,error:'无效的卡池或抽卡数量。'}));return;
  }
  if(fakeDuplicateDraw&&址.pathname==='/api/cards/draw'){
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,coins:100,cards:{catalog:[{id:'kimi-classic',title:'Kimi'},{id:'deepseek',title:'DeepSeek'}],owned:{'kimi-classic':{},deepseek:{}},dust:6,starlight:5},results:[{id:'kimi-classic',rarity:'5★',finish:3,first:false,converted:true,starlight:5},{id:'deepseek',rarity:'4★',finish:1,first:false,upgrade:true,dust:6},{id:'deepseek',rarity:'4★',finish:2,first:false,upgrade:true,dust:6},{id:'already-pearl',title:'不该显示的三星名称',rarity:'3★',finish:3,first:false,converted:true,dust:2}]}));return;
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
    if(址.searchParams.get('status')==='1'){
      const state=farmAPI.store.getSnapshot();
      res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({
        activity:{id:'old-wake',room:'bedroom',action:'idle',label:'起床'},presence:livePresence,
        needs:{...state.needs,energy:47,satiety:36},mood:62,mood来源:'feiyu-mood',recentBodyActivity:'刚喂过鱼。',
      }));return;
    }
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
报('旧版配置迁移后关闭逐轮现场注入',升级配置.每轮注入现场===false&&升级配置.上下文策略版本===3)

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
const 身体状态文=鱼鱼窝工具.output.render({what:'status'},活动状态)[0].text;
报('一次状态查询带身体感受和唯一的有效心情', 活动状态.ok && 身体状态文.startsWith('当前安排：闲着。')&&身体状态文.includes('有点累，饿了，心情 62/100（鱼的心情）')&&(身体状态文.match(/心情 62/g)||[]).length===1&&身体状态文.includes('推了三下秋千'),身体状态文);
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
报('go 后立即查状态显示实际池边，忽略旧起床记录',池边状态.说.startsWith('活动：庭院 · 池塘边 · 闲着。')&&!池边状态.说.includes('起床'));
const 摘要情景={schema:LIFE_EVENT_SCHEMA,id:'scene-pushed-once',at:Date.now(),kind:'scene',reaction:'swing',text:'推了六下秋千。'};
const 已推前=收到的话.length;
await 客户端.sendLifeEvent(摘要情景);
await 客户端.sendLifeEvent(摘要情景);
const 推后身体状态=await 鱼鱼窝工具.execute({what:'status'});
报('连续推秋千的摘要主动送一次，既不重送也不重复放进状态或上下文',收到的话.length===已推前+1&&收到的话.at(-1).content[0].text.includes('推了六下秋千')&&!推后身体状态.说.includes('推了六下秋千')&&上下文们.every(x=>!x.text().includes('推了六下秋千'))&&推后身体状态.说.includes('刚喂过鱼'),推后身体状态.说);
const 送天气=weather=>客户端.sendPetState({schema:PET_STATE_SCHEMA,at:Date.now(),snapshot:{weather,hour:21.75,period:'夜晚',activity:{action:'idle'}}});
await 送天气('clear');
const 天气通知前=收到的话.filter(m=>m.source.kind==='fish-home-state').length;
await 送天气('cloudy');
await 送天气('clear');
await 送天气('rain');
await 送天气('rain');
await 送天气('clear');
const 天气通知=收到的话.filter(m=>m.source.kind==='fish-home-state').slice(天气通知前);
报('晴阴切换和重复状态静默，雨开始和停各只发一条',天气通知.length===2&&天气通知[0].content[0].text.includes('下雨')&&天气通知[1].content[0].text.includes('雨雪停了'));
await fetch('http://127.0.0.1:'+端口+'/dsh-fish-home/save',{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({每轮注入现场:false}),
});
报('关闭逐轮现场时身体状态仍可直接查询',上下文们.every(context=>context.__卸了)&&(await 鱼鱼窝工具.execute({what:'status'})).说.includes('有点累'));
await fetch('http://127.0.0.1:'+端口+'/dsh-fish-home/save',{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({每轮注入现场:true}),
});
const 自然移动前=movementAttempts;
打事件('turn/start',{turn:10});
打事件('assistant/message',{turn:10,message:{role:'assistant',content:[{type:'text',text:'我先回房间了。'}]}});
打事件('turn/end',{turn:10,reason:{kind:'completed'}});
报('她明确说自己回房间时身体只执行一次并等待到达',await 等到(()=>movementAttempts===自然移动前+1)&&movement.args.dest==='indoor'&&movement.wait===true);
const 农活=注册的工具.find(t=>t.name==='fish_home_farm');
const 列田=await 农活.execute({op:'list'});
const 买种=await 农活.execute({op:'buy',item:'radish',count:8});
const seedBefore=farmAPI.store.钱袋().seeds.radish;
const legacy=await 农活.execute({op:'plant',item:'radish',plotId:'bed-0-0-0'});
const 种下=await 农活.execute({op:'plant',item:'萝卜',count:8});
const 重复种下=await 农活.execute({op:'plant',item:'萝卜',count:8});
const afterPlant=farmAPI.store.farmSnapshot();
报('单格工具参数不再暴露，8 格播种一次且重复请求不再消耗库存',列田.ok&&!列田.说.includes('bed-0-')&&买种.ok&&!legacy.ok&&!Object.hasOwn(农活.parameters.properties,'plotId')&&种下.ok&&!重复种下.ok&&afterPlant.farm.plots.filter(p=>p.cropId==='radish').length===8&&seedBefore-(afterPlant.wallet.seeds.radish||0)===8);
const 浇水=await 农活.execute({op:'water',zone:'vegetable'});
报('批量浇水覆盖所有需要浇水的作物',浇水.ok&&farmAPI.store.farmSnapshot().farm.plots.filter(p=>p.wateredUntil>0).length===8);
await 农活.execute({op:'buy',item:'guppy',count:3});
const stocked=await 农活.execute({op:'stock',item:'guppy',count:3});
farmAPI.store.tick(Date.now()+8*24*3600000);
const 捞鱼=await 农活.execute({op:'catch',item:'guppy',count:2});
const 捞鱼后=farmAPI.store.farmSnapshot();
const pondNow=await 鱼鱼窝工具.execute({what:'pond'});
报('成鱼按批次进鱼篓，查询直接读当前池塘而不是插件快照',stocked.ok&&捞鱼.ok&&捞鱼后.wallet.fish.guppy===2&&捞鱼后.farm.pond.fish.length===1&&pondNow.说.includes('池塘在养 1/8')&&pondNow.说.includes('鱼篓成鱼（已捞、可卖）：guppy×2'),pondNow.说);
const 收成=await 农活.execute({op:'harvest',item:'radish'});
const afterHarvest=farmAPI.store.farmSnapshot();
const 出货=await 农活.execute({op:'sell',item:'radish',count:8});
报('批量收菜写入背包，出售实际入账',收成.ok&&afterHarvest.wallet.crops.radish===8&&!afterHarvest.farm.plots.some(p=>p.cropId)&&出货.ok&&farmAPI.store.钱袋().coins>afterHarvest.wallet.coins);
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
报('旧房间结果也会合并满品质重复卡，同品种多次升级只报最终品质',重复卡.ok&&重复卡.说.includes('重复 4 张，其中 2 张已分解，获得 2 星尘、5 星辉')&&重复卡.说.includes('升级 1 张：DeepSeek·升至镀金')&&!重复卡.说.includes('银箔')&&!重复卡.说.includes('Kimi')&&!重复卡.说.includes('不该显示的三星名称'),重复卡.说);
fakeDuplicateDraw=false;
fakeOldRoomHundred=true;
const 旧房间百连=await 抽卡.execute({pool:'standard',count:100});
报('旧房间拒绝百连时只提示升级，不拆成多笔抽卡',!旧房间百连.ok&&旧房间百连.说.includes('房间更新到 0.1.4'),旧房间百连.说);
fakeOldRoomHundred=false;
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
报('回执保留当时余额，后续查钱包反映之后的交易',laterBuy.ok&&afterLaterBuy.说.includes((drawn.coins-10)+' 金币')&&playerNotices[2].text.includes('结算后金币 '+drawn.coins+'。'));
fakeInsufficientExchange=true;
const denied=await 抽卡.execute({op:'exchange',kind:'card',item:'glm-classic'});
fakeInsufficientExchange=false;
报('兑换材料不足显示所需星辉和当前持有量',!denied.ok&&denied.说.includes('需要 20 星辉，目前只有 0 星辉'));
报('买种、批量播种和抽卡分别只发一条，抽卡通知采用结算摘要',bought.ok&&batch.ok&&drawn.ok&&playerNotices.length===3&&/^正式存档 \d{2}:\d{2}:\d{2}，/.test(playerNotices[0].text)&&playerNotices[0].text.includes('小鱿鱼买了 萝卜种子×2')&&playerNotices[1].text.includes('播种了 2 格萝卜')&&playerNotices[2].text.includes(drawn.summary)&&await 等到(()=>收到的话.some(m=>m.content?.[0]?.text?.includes('小鱿鱼花了 1000 金币，抽了 10 张'))));
farmAPI.bridge.publishLifeEvent=publishOriginal;
const 卖价=await 鱼鱼窝工具.execute({what:'price'});
const 明日行情=await 鱼鱼窝工具.execute({what:'market'});
const 锦鲤卖价=await 鱼鱼窝工具.execute({what:'price',kind:'fish',item:'koi'});
const 巨型萝卜卖价=await 鱼鱼窝工具.execute({what:'price',kind:'giant',item:'萝卜'});
const {market:巨型报价基准}=await fetch('http://127.0.0.1:'+端口+'/api/farm').then(response=>response.json());
const 普通萝卜价=巨型报价基准.items.find(item=>item.id==='radish').sellPrice;
报('DSH 可单独查询巨型售价，与当前普通作物行情一致',巨型萝卜卖价.ok&&巨型萝卜卖价.说.includes('巨型萝卜')&&巨型萝卜卖价.说.includes('今日售 '+Math.round(1.8*9*普通萝卜价)),巨型萝卜卖价.说);
报('行情覆盖整张价目，支持只查一种鱼和查看预告',卖价.说.split('\n').length===41&&明日行情.说.split('\n').length===2&&锦鲤卖价.说.includes('锦鲤')&&!锦鲤卖价.说.includes('孔雀鱼'));
const 紧凑布局=await 农活.execute({op:'list',scope:'layout'});
const 逐格布局=await 农活.execute({op:'list',scope:'layout',bed:0});
报('按需查看六个 3×3 区或展开单畦逐格种植',紧凑布局.ok&&紧凑布局.说.includes('bed-2')&&紧凑布局.说.includes('花田：')&&紧凑布局.说.includes('总空位')&&逐格布局.说.includes('萝卜×2')&&逐格布局.说.includes('萝卜 |')&&!逐格布局.说.includes('bed-1'));
打事件('turn/start',{turn:80});
const conflictBefore=farmWrites.length;
const 错品种=await 农活.execute({op:'batch',actions:[{op:'harvest'},{op:'replant',item:'不存在的作物'}]});
报('未知补种品种在批前拒绝，前面的收获也不落地',!错品种.ok&&错品种.说.includes('整批未执行')&&farmWrites.length===conflictBefore,错品种.说);
farmAPI.store.买('seed','radish',1,'chain-extra-seed');
farmAPI.store.tick(farmAPI.store.getSnapshot().now+3600000);
const 收卖种前=farmAPI.store.farmSnapshot();
const 原地=收卖种前.farm.plots.filter(p=>p.cropId==='radish').map(p=>p.id);
const 现场行情=await fetch('http://127.0.0.1:'+端口+'/api/farm').then(r=>r.json());
const 卖价萝卜=现场行情.market.items.find(x=>x.id==='radish').sellPrice;
const 收卖种单={op:'batch',actions:[{op:'harvest'},{op:'sell'},{op:'replant'}]};
const 收卖种=await 农活.execute(收卖种单);
const 重放收卖种=await 农活.execute(收卖种单);
const 收卖种后=farmAPI.store.farmSnapshot();
报('一张单收、卖、原地补种；按实际行情结算，重复提交不扣种也不重复入账',收卖种.ok&&重放收卖种.ok&&重放收卖种.说.includes('原回执')&&farmWrites.slice(conflictBefore).join()==='/api/farm/harvest-batch,/api/farm/sell,/api/farm/plant-batch'&&原地.length===2&&收卖种后.farm.plots.filter(p=>p.cropId==='radish').map(p=>p.id).join()===原地.join()&&收卖种后.wallet.coins===收卖种前.wallet.coins+2*卖价萝卜&&(收卖种后.wallet.seeds.radish||0)===(收卖种前.wallet.seeds.radish||0)-2&&(收卖种后.wallet.crops.radish||0)===(收卖种前.wallet.crops.radish||0),收卖种.说);
const 局部失败=await 农活.execute({op:'batch',actions:[{op:'water',zone:'vegetable'},{op:'sell',item:'萝卜',kind:'crop',count:999}]});
报('执行中的失败会区分已完成的操作和未入账的操作',!局部失败.ok&&局部失败.说.includes('已完成的操作已入账')&&局部失败.说.includes('浇了水')&&局部失败.说.includes('要卖 999 份萝卜，背包只有 0 份')&&farmAPI.store.farmSnapshot().farm.plots.filter(p=>p.wateredUntil>0).length===2,局部失败.说);
打事件('turn/end',{turn:80,reason:{kind:'completed'}});
farmAPI.store.买('seed','radish',1,'next-case-seed');
打事件('turn/start',{turn:81});
farmAPI.store.tick(farmAPI.store.getSnapshot().now+3600000);
const beforeReplant=farmWrites.length;
const 收后补种=await 农活.execute({op:'replant',item:'萝卜',buyMissing:true});
const 重复补种=await 农活.execute({op:'replant',item:'radish',buyMissing:true});
const 补种后=farmAPI.store.farmSnapshot();
报('一次调用收熟萝卜、补买种子及回种，同一轮改用英文名也不会再执行',收后补种.ok&&收后补种.说.includes('实际收进背包 2 份')&&收后补种.说.includes('补买了 1 份')&&收后补种.说.includes('播种了 2 格萝卜')&&重复补种.ok&&重复补种.说.includes('原回执')&&farmWrites.slice(beforeReplant).join()==='/api/farm/harvest-batch,/api/farm/buy,/api/farm/plant-batch'&&补种后.farm.plots.filter(p=>p.cropId==='radish').length===2,JSON.stringify({收后补种,重复补种}));
打事件('turn/end',{turn:81,reason:{kind:'completed'}});

const 两种种子 = [
  {op:'buy',item:'radish',count:3}, {op:'buy',item:'tulip',count:2},
  {op:'plant',item:'radish',count:3}, {op:'plant',item:'tulip',count:2},
];
const 备两种作物=await 农活.execute({op:'batch',actions:两种种子});
报('菜和花可同批买种和播种',备两种作物.ok&&备两种作物.说.includes('播种了 2 格郁金香'),备两种作物.说);
farmAPI.store.tick(farmAPI.store.getSnapshot().now+24*3600000);
await 农活.execute({op:'harvest',item:'radish'});
await 农活.execute({op:'harvest',item:'tulip'});
const 多作物 = [
  {op:'sell',item:'萝卜',kind:'crop',count:3}, {op:'sell',item:'郁金香',kind:'crop',count:2},
  ...两种种子,
];
打事件('turn/start',{turn:82});
const 批量前=farmWrites.length;
const 坏批次=await 农活.execute({op:'batch',actions:[多作物[0],{op:'plant',item:'找不到的种子',count:3}]});
报('整单先验证，后面的品种错误不会误执行前面的卖出',!坏批次.ok&&farmWrites.length===批量前);
const 整单=await 农活.execute({op:'batch',actions:多作物});
const 农活结算=farmAPI.store.farmSnapshot();
const 两项补批=await 农活.execute({op:'batch',actions:[{op:'water',zone:'vegetable'},{op:'water',zone:'flower'}]});
const 二批后=farmWrites.length;
const [别名重提,第三批]=await Promise.all([
  农活.execute({op:'batch',actions:多作物.map(action=>({...action,item:({萝卜:'radish',郁金香:'tulip'})[action.item]||action.item}))}),
  农活.execute({op:'batch',actions:[{op:'buy',item:'萝卜',count:4}]}),
]);
报('两种作物卖出、买种、播种整单一次完成，重提与第三批不写存档',整单.ok&&整单.说.split('\n').length===7&&整单.说.includes('余额 '+农活结算.wallet.coins+' 金币')&&农活结算.farm.plots.filter(plot=>plot.cropId==='radish').length===3&&农活结算.farm.plots.filter(plot=>plot.cropId==='tulip').length===2&&两项补批.ok&&别名重提.ok&&别名重提.说.includes('原回执')&&!第三批.ok&&第三批.说.includes('已执行两次')&&二批后===批量前+8&&farmWrites.length===二批后,JSON.stringify({整单,两项补批,第三批}));
await preStep({agent:假agent,messages:[]},()=>({kind:'enter'}));
报('达到写入上限时工具仍可查询，不会突然消失',农活.__卸了!==true&&(await 农活.execute({op:'list',scope:'farm'})).ok);
打事件('turn/end',{turn:82,reason:{kind:'completed'}});
打事件('turn/start',{turn:83});
报('新一轮重新给模型农活工具',注册的工具.some(tool=>tool.name==='fish_home_farm'&&!tool.__卸了));
const 下一轮=await 农活.execute({op:'batch',actions:[{op:'buy',item:'萝卜',count:4}]});
报('新对话轮次恢复农活额度',下一轮.ok&&farmWrites.length===二批后+1);
打事件('turn/end',{turn:83,reason:{kind:'completed'}});
farmAPI.store.tick(farmAPI.store.getSnapshot().now+24*3600000);
打事件('turn/start',{turn:84});
const 自动补种=await 农活.execute({op:'batch',actions:[{op:'replant',buyMissing:true}]});
报('replant 省略品种时自动收获并补种成熟作物',自动补种.ok&&!自动补种.说.includes('找不到作物')&&(自动补种.说.includes('补种')||自动补种.说.includes('播种')),自动补种.说);
打事件('turn/end',{turn:84,reason:{kind:'completed'}});
打事件('turn/start',{turn:85});
const 未熟=await 农活.execute({op:'batch',actions:[{op:'replant',item:'radish'}]});
const 未种=await 农活.execute({op:'batch',actions:[{op:'replant',item:'tomato'}]});
报('没有种和已经种但未熟返回不同原因',!未熟.ok&&未熟.说.includes('没有成熟')&&!未种.ok&&未种.说.includes('没有种植'),未熟.说+' / '+未种.说);
打事件('turn/end',{turn:85,reason:{kind:'completed'}});
farmAPI.store.买('fish','guppy',2,'catch-sell-fry');
farmAPI.store.farmBatch('stock',{item:'guppy',count:2,requestId:'catch-sell-stock'});
farmAPI.store.tick(farmAPI.store.getSnapshot().now+24*3600000);
打事件('turn/start',{turn:86});
const 捞卖前=farmAPI.store.farmSnapshot();
const 捞卖单={op:'batch',actions:[{op:'catch'},{op:'sell'}]};
const 捞卖=await 农活.execute(捞卖单);
const 捞卖后=farmAPI.store.farmSnapshot();
报('一次捞鱼并出售实际捞到的鱼，不动之前的成鱼库存',捞卖.ok&&捞卖.说.includes('实际捞到 '+捞卖前.farm.pond.fish.length+' 条')&&捞卖.说.includes('卖了 '+捞卖前.farm.pond.fish.length+' 份孔雀鱼')&&捞卖后.farm.pond.fish.length===0&&捞卖后.wallet.fish.guppy===捞卖前.wallet.fish.guppy&&捞卖后.wallet.coins>捞卖前.wallet.coins,捞卖.说);
打事件('turn/end',{turn:86,reason:{kind:'completed'}});
farmAPI.store.买('seed','radish',1,'giant-first-blocker');
farmAPI.store.farmPlant({plotId:'bed-2-0-0',cropId:'radish',requestId:'giant-first-blocker-plant'});
const 巨型开单前=farmAPI.store.farmSnapshot();
const 巨型请求前=farmWrites.length;
const 巨型通知前=收到的话.length;
const 巨型单={op:'batch',actions:[{op:'harvest'},{op:'sell'},{op:'plant',item:'番茄',layout:'giant',bed:2,buyMissing:true}]};
打事件('turn/start',{turn:87});
const 巨型单结果=await 农活.execute(巨型单);
const 巨型重复=await 农活.execute(巨型单);
const 巨型种完=farmAPI.store.farmSnapshot();
const 整块番茄=巨型种完.farm.plots.filter(p=>p.cropId==='tomato');
报('一次收菜、卖掉本批、补买并把番茄全种在第二区，第一区有作物就自动跳过',巨型单结果.ok&&巨型单结果.说.includes('第 2 区：种了 9 格番茄')&&巨型单结果.说.includes('补买了 9 份')&&整块番茄.length===9&&整块番茄.every(p=>/^bed-2-\d-[345]$/.test(p.id))&&巨型种完.farm.plots.find(p=>p.id==='bed-2-0-0').cropId==='radish'&&巨型开单前.farm.plots.some(p=>p.ready)&&farmWrites.slice(巨型请求前).join()==='/api/farm/harvest-batch,/api/farm/sell,/api/farm/sell,/api/farm/plant-giant-batch'&&巨型重复.ok&&巨型重复.说.includes('原回执')&&收到的话.length===巨型通知前,巨型单结果.说);
打事件('turn/end',{turn:87,reason:{kind:'completed'}});
打事件('turn/start',{turn:88});
const 没整区单={op:'batch',actions:[{op:'plant',item:'tomato',bed:2,layout:'giant',buyMissing:true}]};
const 没有整区=await 农活.execute(没整区单);
const 没有整区后=farmAPI.store.farmSnapshot();
报('没有整块给一次明确的失败回执，不扣金币、不偷偷普通种',!没有整区.ok&&没有整区.说.includes('没有完整的 3×3 空区，没有买种，也没有播种')&&没有整区后.wallet.coins===巨型种完.wallet.coins&&没有整区后.farm.plots.filter(p=>p.cropId==='tomato').length===9,没有整区.说);
打事件('turn/end',{turn:88,reason:{kind:'completed'}});
// Replay the reported market-and-farm request with a fresh test wallet.
farmAPI.store.买('fish','koi',8,'reported-koi-start');
farmAPI.store.farmBatch('stock',{item:'koi',count:8,requestId:'reported-koi-fill'});
farmAPI.store.tick(farmAPI.store.getSnapshot().now+5*3600000);
farmAPI.store.farmBatch('catch',{item:'koi',count:8,requestId:'reported-koi-catch'});
打事件('turn/start',{turn:89});
const 复现原单=await 农活.execute({op:'batch',actions:[{count:8,item:'锦鲤',kind:'fish',op:'sell'},
  {count:8,item:'锦鲤',kind:'fish',op:'buy'},{count:8,op:'stock'},{item:'萝卜',layout:'giant',buyMissing:true,op:'plant'}]});
报('原单一次完成：放苗承接唯一鱼种，萝卜也能种整块',复现原单.ok&&复现原单.说.includes('放养了 8 条锦鲤鱼苗')&&复现原单.说.includes('种了 9 格萝卜'),复现原单.说);
打事件('turn/end',{turn:89,reason:{kind:'completed'}});
打事件('turn/start',{turn:90});
打事件('turn/start', { turn: 39 });
const 花田播种前=farmAPI.store.farmSnapshot();
const 花田播种=await 农活.execute({op:'batch',actions:[{op:'plant',item:'仙女玫瑰',layout:'giant',buyMissing:true}]});
const 花田播种后=farmAPI.store.farmSnapshot();
报('旧的巨型播种参数遇到花种时只种一格，只补买一份种子',花田播种.ok&&花田播种.说.includes('播种了 1 格仙女玫瑰')&&花田播种.说.includes('补买了 1 份种子')&&花田播种后.farm.plots.filter(plot=>plot.cropId==='fairy_rose').length===1&&花田播种前.farm.plots.filter(plot=>!plot.cropId).length===花田播种后.farm.plots.filter(plot=>!plot.cropId).length+1,花田播种.说);
打事件('turn/start', { turn: 40 });
const 种满前=farmAPI.store.farmSnapshot();
const 种满单={op:'batch',actions:[{item:'萝卜',op:'plant',fill:true,buyMissing:true},{item:'郁金香',op:'plant',zone:'flower',fill:true,buyMissing:true}]};
const 种满=await 农活.execute(种满单);
const 种满后=farmAPI.store.farmSnapshot();
const 空菜=种满前.farm.plots.filter(p=>!p.cropId&&!p.id.startsWith('flower-')).length;
const 空花=种满前.farm.plots.filter(p=>!p.cropId&&p.id.startsWith('flower-')).length;
const 应花=Math.max(0,空菜-(种满前.wallet.seeds.radish||0))*10+Math.max(0,空花-(种满前.wallet.seeds.tulip||0))*25;
报('普通播种找完菜田和花田所有空格，只买实际缺的份数，不改已种作物',种满.ok&&种满后.farm.plots.every(p=>p.cropId)&&种满后.wallet.coins===种满前.wallet.coins-应花&&种满前.farm.plots.filter(p=>p.cropId).every(p=>种满后.farm.plots.find(q=>q.id===p.id).plantId===p.plantId),种满.说);
打事件('turn/end',{turn:90,reason:{kind:'completed'}});
打事件('turn/start',{turn:91});
const 未熟畦=[0,1,2].find(bed=>{
  const rows=种满后.farm.plots.filter(p=>p.id.startsWith(`bed-${bed}-`)&&p.cropId==='radish');
  return rows.length>0&&!rows.some(p=>p.ready);
});
const 早收=await 农活.execute({op:'batch',actions:[{op:'harvest',item:'萝卜',bed:未熟畦}]});
const 未种菜=await 农活.execute({op:'batch',actions:[{op:'harvest',item:'甜瓜',bed:未熟畦}]});
报('收获失败明确指出菜畦，区分未种和未熟',未熟畦!==undefined&&!早收.ok&&早收.说.includes(`菜畦 ${未熟畦}`)&&早收.说.includes('没有成熟')&&!未种菜.ok&&未种菜.说.includes(`菜畦 ${未熟畦}`)&&未种菜.说.includes('没有种植甜瓜'),早收.说+' / '+未种菜.说);
const 前回执余额=farmAPI.store.钱袋().coins;
const 独立失败=await 农活.execute({op:'batch',actions:[{op:'buy',item:'锦鲤',count:1},{op:'plant',item:'不存在的果实',layout:'giant',buyMissing:true}]});
报('巨型品种错误只跳过播种，已买的鱼苗保留',!独立失败.ok&&独立失败.说.includes('买了 1 份锦鲤鱼苗')&&独立失败.说.includes('这一步没买种或播种')&&farmAPI.store.钱袋().coins===前回执余额-200,独立失败.说);
打事件('turn/end',{turn:91,reason:{kind:'completed'}});
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

// Use a deterministic mature bed and two flowers. Both DSH tools go through the real HTTP API.
const {createFarmState}=await import('file:///'+房间+'/../farm-state.js');
const {cropTiming}=await import('file:///'+房间+'/../farm.js');
const cardsCatalog=JSON.parse(fs.readFileSync(path.resolve(房间,'../card-catalog.json'),'utf8'));
const 巨型存档 = new DatabaseSync(path.join(farmHome,'life.sqlite'));
try {
  const state=JSON.parse(巨型存档.prepare("SELECT value FROM meta WHERE key='state'").get().value);
  const at=state.lastTick;
  state.farm=createFarmState();
  state.bag.crops={};
  state.bag.giants={radish:1,tulip:1};
  state.coins=45000;
  state.cards.owned=Object.fromEntries(cardsCatalog.map(card=>[card.id,{finish:3,copies:['SP','hidden'].includes(card.rarity)?1:4}]));
  const 菜格=state.farm.plots.filter(plot=>/^bed-0-[0-2]-[0-2]$/.test(plot.id));
  const 花格=state.farm.plots.filter(plot=>plot.id==='flower-0');
  for (const [id,cropId,anchorPlotId,plots] of [
    ['giant-test-radish','radish','bed-0-1-1',菜格],
    ['giant-test-tulip','tulip','flower-0',花格],
  ]) {
    state.farm.giants.push({id,cropId,anchorPlotId,plotIds:plots.map(plot=>plot.id),formedAt:at});
    for (const plot of plots) Object.assign(plot,{cropId,plantId:`plant-${plot.id}`,plantedAt:at,
      updatedAt:at,progressMs:cropTiming(cropId).totalMs,giantId:id});
  }
  Object.assign(state.farm.plots.find(plot=>plot.id==='flower-1'),{cropId:'tulip',plantId:'ordinary-tulip',
    plantedAt:at,updatedAt:at,progressMs:cropTiming('tulip').totalMs});
  巨型存档.prepare("UPDATE meta SET value=? WHERE key='state'").run(JSON.stringify(state));
} finally { 巨型存档.close(); }
farmAPI=await createAPI({dataDir:farmHome});
farmAPI.store.setSettings({autonomy:false});
farmAPI.store.设睡觉(false);
const 报价=await fetch('http://127.0.0.1:'+端口+'/api/farm').then(response=>response.json());
const 普通花价=报价.market.items.find(item=>item.id==='tulip').sellPrice;
const 巨型花价=Math.round(普通花价*1.8);
const 巨型菜价=Math.round(报价.market.items.find(item=>item.id==='radish').sellPrice*9*1.8);
const 查花价=await 鱼鱼窝工具.execute({what:'price',kind:'giant',item:'tulip'});
const 查巨型田=await 鱼鱼窝工具.execute({what:'farm'});
报('巨型查价按一份普通花折算，田里按实际可收的巨型数量回报',查花价.ok&&查花价.说.includes('今日售 '+巨型花价+' /')&&查巨型田.说.includes('巨型萝卜×1、巨型郁金香×1，共占 10 格')&&查巨型田.说.includes('tulip 0 格生长、1 格成熟'),查花价.说+' / '+查巨型田.说);
打事件('turn/start',{turn:110});
const 本批巨型单={op:'batch',actions:[{op:'harvest'},{op:'sell'}]};
const 巨型写入前=farmWrites.length;
const 本批巨型=await 农活.execute(本批巨型单);
const 本批巨型重试=await 农活.execute(本批巨型单);
const 收卖完=farmAPI.store.farmSnapshot();
const 到账=巨型花价+巨型菜价+普通花价;
报('巨型菜九格、巨型花一格，各收一份，批量出售按真实单价入账且重试不重复',本批巨型.ok&&本批巨型.说.includes('实际收进背包 3 份')&&本批巨型.说.includes('本次共收了 11 格')&&本批巨型.说.includes('巨型萝卜×1、巨型郁金香×1、郁金香×1')&&本批巨型.说.includes(`卖了 1 份巨型郁金香，入账 ${巨型花价} 金币`)&&本批巨型.说.includes(`卖了 1 份巨型萝卜，入账 ${巨型菜价} 金币`)&&本批巨型.说.includes(`余额 ${报价.coins+到账} 金币`)&&本批巨型重试.说.includes('原回执')&&farmWrites.length===巨型写入前+4&&收卖完.wallet.coins===报价.coins+到账&&收卖完.wallet.giants.radish===1&&收卖完.wallet.giants.tulip===1&&收卖完.farm.plots.every(plot=>!plot.cropId),本批巨型.说);
打事件('turn/end',{turn:110,reason:{kind:'completed'}});
打事件('turn/start',{turn:111});
const 超卖=await 农活.execute({op:'sell',kind:'giant',item:'郁金香',count:2});
const 卖一朵=await 农活.execute({op:'sell',kind:'giant',item:'郁金香'});
const 单卖完=farmAPI.store.farmSnapshot();
报('指定巨型出售支持品种别名，库存不足回报准确余量',!超卖.ok&&超卖.说.includes('要卖 2 份巨型郁金香，背包只有 1 份')&&卖一朵.ok&&卖一朵.说.includes(`每份 ${巨型花价} 金币，背包还剩 0 份巨型郁金香`)&&单卖完.wallet.coins===收卖完.wallet.coins+巨型花价&&单卖完.wallet.giants.radish===1&&!单卖完.wallet.giants.tulip,超卖.说+' / '+卖一朵.说);
打事件('turn/end',{turn:111,reason:{kind:'completed'}});
const compactNotices=[];
farmAPI.bridge.publishLifeEvent=async event=>{compactNotices.push(event);return 客户端.sendLifeEvent({schema:LIFE_EVENT_SCHEMA,...event});};
for(const count of [10,100]){
  const before=farmAPI.store.cardState();
  const request={pool:'sp',count,requestId:'compact-player-'+count};
  const drew=await roomPost('/api/cards/draw',request);
  await roomPost('/api/cards/draw',request);
  const gainDust=drew.cards.dust-before.dust,gainStar=drew.cards.starlight-before.starlight;
  const breakdown=[gainDust&&`${gainDust} 星尘`,gainStar&&`${gainStar} 星辉`].filter(Boolean).join('、');
  const expected=(count>=100?'大批量仅展示五星及以上。':'')+`重复 ${count} 张，分解获得 ${breakdown}。`;
  const matches=compactNotices.filter(event=>event.id==='draw:'+request.requestId);
  报(`网页 ${count} 连：只推一次短回执，分解数与货币实际入账一致`,drew.ok&&drew.results.length===count&&drew.cost===count*100&&drew.summary===expected&&matches.length===1&&matches[0].text.includes(expected)&&matches[0].text.length<150&&farmAPI.store.cardState().coins===before.coins-drew.cost,matches[0]?.text);
}
const 抽百前=farmAPI.store.cardState();
const 工具百连=await 抽卡.execute({pool:'standard',count:100});
const 抽百后=farmAPI.store.cardState();
报('工具百连一次结算，满珠光只报分解，保留保底字段，不再推一遍通知',工具百连.ok&&工具百连.说.includes('抽了 100 张，花费 10000 金币')&&工具百连.说.includes('重复 100 张，分解获得')&&工具百连.说.length<200&&!工具百连.说.includes('undefined')&&工具百连.pity.top>0&&抽百后.coins===抽百前.coins-10000&&compactNotices.length===2,工具百连.说);
await farmAPI.close();

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
