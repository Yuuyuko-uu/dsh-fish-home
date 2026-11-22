import {drawSummaryText} from './draw-summary.js';
// 鱼鱼窝 · 宿主半边
//
// 它干的事只有一件：让「大肥鱼的小日子」那个房间和 DSH 里的会话说上话。
//   · 房间那边打字  → 送进绑定的会话（DSH 里就是她本人说的一句话）
//   · 会话里回了话  → 顺着事件流递回房间
//   · 她在 DSH 窗口里自己打字 / 插件让她主动开口 → 房间那边也看得见
//   · 房间里的生活数据（饿不饿、在干嘛）→ 存在这儿，随时能看
//
// 走的是本机 HTTP + SSE，只认 127.0.0.1，令牌对不上就一律 401。
// 房间那边读 ~/.dsh/fish-room.discovery.json 自动找到地址和令牌，不用手填。
// ⚠ `/fish-room/v1` 这个路径和那个发现文件的名字是**房间那边的代码写死的**，
//   插件改名也不跟着改 —— 改了房间就找不着了。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { createSelfUpdate } from './selfupdate.mjs'
import { setTimeout as 睡 } from 'node:timers/promises'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { 读星汐, 收回忆, 筛回忆, 收天数 } from './memory.mjs'
import { 鱼鱼窝图标 } from './icon.mjs'
import { 识别身体意图 } from './body-intent.mjs'

export const name = 'fish-home'
// 这几个都是宿主必备的服务；写进 inject 才能直接 ctx.agents 这么用
// （没声明的服务连 ctx.get('x') 都会抛 —— 归档名单就是栽在这上面：
//   workspaceRegistry 没声明 → 拿到 undefined → 归档过滤整个失效 → 列表里全是归档会话）
export const inject = ['webServer', 'agents', 'sessions', 'sessionTitle', 'workspaceRegistry']

const 桥版本 = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const 前缀 = '/fish-room/v1'

const SCHEMA = 'dsh.fish-room/1'
const EVENT_SCHEMA = 'dsh.fish-room.event/1'
const CHAT_SCHEMA = 'dsh.fish-room.chat/1'
const PET_STATE_SCHEMA = 'dsh.fish-room.pet-state/1'
const LIFE_EVENT_SCHEMA = 'dsh.fish-room.life-event/1'
const CARE_TTL_MS = 60000
const SCENE_TTL_MS = 120000
const CARE_TEXT = { pet: '刚摸了摸你的头。', greet: '刚向你打了个招呼。', kiss: '刚亲了你一下。' }
const DISCOVERY_SCHEMA = 'dsh.fish-room.discovery/1'

const 事件白名单 = new Set([
  'bridge.hello', 'stream.reset', 'chat.user', 'chat.reply', 'chat.thinking', 'chat.error',
  'proactive.speak', 'activity.bili', 'activity.desk', 'paint.image', 'pet.state.ack', 'bridge.notice',
])

const 家 = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const 配置路 = path.join(家, 'fish-room.json')
const 发现路 = path.join(家, 'fish-room.discovery.json')
const 房间记录路 = path.join(家, 'fish-room.room.json')

// 房间本体从哪儿找，按这个顺序：
//   ① 环境变量 FISH_ROOM_DIR 指哪算哪（老用户/开发时用）
//   ② $DSH_HOME/fish-home-room/ —— 从 Releases 下下来解压到这儿就行，不放在 node_modules 里，
//      升级插件不会把它冲掉
//   ③ 随插件放的那份 ../room/（本地开发时才有）
// ⚠ 为什么不再默认塞在包内：房间三百多兆（3D 模型 + 卡牌素材），npm 的 tarball 上限是 100 MB，装不下。
const 家外房间 = path.join(家, 'fish-home-room')
const 房间目录 = process.env.FISH_ROOM_DIR
  ? path.resolve(process.env.FISH_ROOM_DIR)
  : fs.existsSync(path.join(家外房间, 'app-server.js'))
    ? 家外房间
    : fileURLToPath(new URL('../room/', import.meta.url))
const 使用内置房间 = 房间目录 === 家外房间 || 房间目录.startsWith(fileURLToPath(new URL('../room/', import.meta.url)))
const 房间档案 = process.env.DAYU_DATA_DIR || (使用内置房间 ? path.join(家, 'fish-home-data') : '')
const 房间端口 = Math.max(1, Math.trunc(Number(process.env.FISH_ROOM_PORT) || 5178))
const 房间地址 = 'http://127.0.0.1:' + 房间端口

const 换行 = String.fromCharCode(10)

/* ───────────────────────── 配置 ───────────────────────── */

const 默认配置 = {
  开: true,
  会话: '',
  令牌: '',
  // DSH 起来的时候顺手把房间后台拉起来。默认关 —— 要不要她一直在后台，本人说了算。
  开机自启: false,
  转发主动开口: true,
  心跳秒: 20,
  // 画架生图：地址 + 密钥 + 模型，三个都填上就能画
  画图地址: '',
  画图密钥: '',
  画图模型: '',
  画图尺寸: '1024x1024',
  // 房间那两个开关的「本地那份」：房间没开时先记这儿，等它起来再补推。
  // 键名跟房间 /api/settings 的一样（学菜 / 画图），省得到处翻译。
  学菜: true,
  画图: true,
  待推设置: [],
  // 睡着就不理人：关掉 = pre-step 完全放行（最后一道逃生门）
  睡着不理: true,
  // 动态现场默认不塞进每一轮 runtime-context；需要时用 fish_home 查明细。
  每轮注入现场: false,
  上下文策略版本: 3,
  状态变化通知: true,
  主动生活通知: { milestone: true, wallet: true, scene: true },
  文本记忆路径: '',
  文本日记路径: '',
  相伴起始日: '',
}

function 读配置() {
  let 存 = {}
  try { 存 = JSON.parse(fs.readFileSync(配置路, 'utf8')) } catch (e) { 存 = {} }
  const 合 = { ...默认配置, ...(存 && typeof 存 === 'object' ? 存 : {}) }
  // 0.1.0 曾把现场上下文默认塞进每一轮。升级后强制迁移一次，
  // 否则旧的 fish-room.json 会把新默认值重新覆盖回 true。
  const 上下文迁移 = Number(存?.上下文策略版本 || 0)
  if (上下文迁移 < 2) {
    合.每轮注入现场 = false
  }
  if (上下文迁移 < 3) {
    // 0.1.1 早期版本在没有星汐日记时把「今天」误写成相伴起始日，
    // 让存档天数兜底看起来像从更新当天重新开始。只有这个自动生成的
    // 近两天日期才清掉；用户在设置里填过的旧日期保留。
    const 今天 = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())
    const 旧日 = String(存?.相伴起始日 || '')
    const 今天毫秒 = Date.parse(今天 + 'T00:00:00Z')
    const 旧日毫秒 = Date.parse(旧日 + 'T00:00:00Z')
    const 近两天自动日 = /^\d{4}-\d{2}-\d{2}$/.test(旧日) && Number.isFinite(旧日毫秒) && Math.abs(今天毫秒 - 旧日毫秒) <= 2 * 86400000
    if (近两天自动日 && !String(存?.文本日记路径 || '').trim() && !String(存?.文本记忆路径 || '').trim()) 合.相伴起始日 = ''
  }
  if (上下文迁移 < 3) {
    合.上下文策略版本 = 3
    try { fs.mkdirSync(家, { recursive: true }); fs.writeFileSync(配置路, JSON.stringify(合, null, 2), 'utf8') } catch {}
  }
  合.开 = 合.开 !== false
  合.开机自启 = 合.开机自启 === true
  合.转发主动开口 = 合.转发主动开口 !== false
  合.学菜 = 合.学菜 !== false
  合.画图 = 合.画图 !== false
  合.待推设置 = Array.isArray(合.待推设置)
    ? 合.待推设置.filter((键) => 键 === '学菜' || 键 === '画图')
    : []
  delete 合.上次醒来招呼
  合.睡着不理 = 合.睡着不理 !== false
  合.每轮注入现场 = 合.每轮注入现场 === true
  合.上下文策略版本 = 3
  合.状态变化通知 = 合.状态变化通知 !== false
  合.主动生活通知 = Object.fromEntries(['milestone','wallet','scene'].map(key=>[key,合.主动生活通知?.[key]!==false]))
  合.文本记忆路径 = String(合.文本记忆路径 || '').trim()
  合.文本日记路径 = String(合.文本日记路径 || '').trim()
  合.相伴起始日 = /^\d{4}-\d{2}-\d{2}$/.test(String(合.相伴起始日 || '')) ? String(合.相伴起始日) : ''
  // 没有来源时保持空白，让房间自己的存档天数作为兜底。

  合.会话 = String(合.会话 || '').trim()
  合.令牌 = String(合.令牌 || '').trim()
  const 秒 = Number(合.心跳秒)
  合.心跳秒 = Number.isFinite(秒) ? Math.max(5, Math.min(120, Math.trunc(秒))) : 20
  return 合
}

function 写配置(补丁) {
  try {
    fs.mkdirSync(家, { recursive: true })
    const 新 = { ...读配置(), ...补丁 }
    fs.writeFileSync(配置路, JSON.stringify(新, null, 2), 'utf8')
    return 新
  } catch (error) {
    return null
  }
}

/** 令牌没配就现造一个，写回配置 —— 房间那边从发现文件里读，不用人抄。 */
function 保证令牌() {
  const 配置 = 读配置()
  if (配置.令牌 && 配置.令牌.length >= 16) return 配置
  const 新 = 写配置({ 令牌: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 8) })
  return 新 || { ...配置, 令牌: '' }
}

/* ───────────────────────── 小工具 ───────────────────────── */

function 会话键(id) {
  const s = String(id == null ? '' : id).trim()
  return s.startsWith('session-') ? s : (s ? 'session-' + s : '')
}

function 短id(id) {
  const s = String(id || '')
  return s.length <= 8 ? s : s.slice(-8)
}

/** 从消息里抠出纯文字（只要 text 块；思考、图片都不算）。 */
function 提取正文(message) {
  const 内容 = message && message.content
  if (typeof 内容 === 'string') return 内容
  if (!Array.isArray(内容)) return ''
  const 段 = []
  for (const 块 of 内容) {
    if (!块) continue
    if (块.type === 'text' && typeof 块.text === 'string') 段.push(块.text)
    else if (块.type === 'text-chunk' && typeof 块.text === 'string') 段.push(块.text)
  }
  return 段.join('')
}

/** 机器塞进来的那些注入（运行环境、时间、技能表……）不是「她说的」。 */
function 是注入(类) {
  const k = String(类 || '')
  return k !== '' && k !== 'user' && k !== 'fish-home'
}

/* ───────────────────── 房间后台进程 ───────────────────── */
// 房间是另一个程序，跟 DSH 共用一台机器、一个后台。这里只干四件事：
//   看它活没活、拉起来、停掉、把窗口叫出来。
// 「在不在跑」只认 /api/health —— 进程可能早就死了，而 pid 文件还躺在那儿。

const 健康超时 = 2000

async function 读房间健康(超时毫秒 = 健康超时) {
  try {
    const response = await fetch(房间地址 + '/api/health', {
      signal: AbortSignal.timeout(超时毫秒), cache: 'no-store',
    })
    if (!response.ok) return null
    const health = await response.json()
    return health?.ok === true ? health : null
  } catch (error) {
    return null
  }
}

function 是目标房间(health) {
  return Boolean(health && (!使用内置房间 || health.edition === 'dsh-fish-home'))
}

function 是旧版房间(health) {
  return 使用内置房间 && health?.edition == null && health?.version === 2
    && Number.isInteger(health.gardenRevision) && Number.isInteger(health.cardsRevision)
}

export async function 探健康(超时毫秒 = 健康超时) {
  return 是目标房间(await 读房间健康(超时毫秒))
}

/** 房间 /api/state 里的两个开关。字段缺了就 null，由调用方回落到本地配置。 */
// 读 state 比健康检查慢：房间可能会顺便去问 DSH 桥，5 秒够它把话说完
export async function 读房间设置(超时毫秒 = 5000, origin = 房间地址) {
  const 控 = new AbortController()
  const 定 = setTimeout(() => 控.abort(), 超时毫秒)
  try {
    const r = await fetch(origin + '/api/state?local=1', { signal: 控.signal, cache: 'no-store' })
    if (!r.ok) return { 学菜: null, 画图: null }
    const j = await r.json()
    const 快照 = j && j.settings
    if (!快照 || typeof 快照 !== 'object') return { 学菜: null, 画图: null }
    return {
      学菜: typeof 快照.学菜 === 'boolean' ? 快照.学菜 : null,
      画图: typeof 快照.画图 === 'boolean' ? 快照.画图 : null,
    }
  } catch (error) {
    return { 学菜: null, 画图: null }
  } finally {
    clearTimeout(定)
  }
}

/** 把开关 POST 给房间；返回 true 才算真送到（房间没开或版本旧都会是 false）。 */
export async function 写房间设置(补丁, 超时毫秒 = 3000) {
  const 要的 = {}
  for (const 键 of ['学菜', '画图']) {
    if (补丁 && typeof 补丁[键] === 'boolean') 要的[键] = 补丁[键]
  }
  if (!Object.keys(要的).length) return false
  const 控 = new AbortController()
  const 定 = setTimeout(() => 控.abort(), 超时毫秒)
  try {
    const r = await fetch(房间地址 + '/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(要的),
      signal: 控.signal,
    })
    return r.ok
  } catch (error) {
    return false
  } finally {
    clearTimeout(定)
  }
}

/* ── 睡觉：房间里的状态 ── */
// pre-step 每个步骤都会问一次，缓存几秒：她躺下/起来不会那么快变，
// 房间没开的时候也别每一步都等一次超时。
let 睡眠缓存 = { at: 0, 值: null }

/** 读房间的睡着 / 可叫醒。读不到就 ok:false（调用方一律放行）。 */
export async function 读房间睡眠(超时毫秒 = 1500, 缓存毫秒 = 4000) {
  const cached = 睡眠缓存.值;
  const dueToWake = cached?.睡着 && Number.isFinite(cached.until) && cached.until<=Date.now();
  if (cached && !dueToWake && Date.now()-睡眠缓存.at<缓存毫秒) return cached;
  const 控 = new AbortController()
  const 定 = setTimeout(() => 控.abort(), 超时毫秒)
  try {
    const r = await fetch(房间地址 + '/api/state', { signal: 控.signal, cache: 'no-store' })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const j = await r.json()
    if (!j || typeof j.睡着 !== 'boolean') throw new Error('没报睡着')
    const 设 = j.settings && typeof j.settings === 'object' ? j.settings : {}
    const 活动 = j.activity && typeof j.activity === 'object' ? j.activity : {}
    const 起床点 = Number(活动.until)
    const 值 = {
      ok: true,
      睡着: j.睡着 === true,
      可叫醒: 设.可叫醒 !== false,
      活动: typeof 活动.label === 'string' ? 活动.label : '',
      until: Number.isFinite(起床点) && 起床点 > 0 ? 起床点 : null,
    }
    睡眠缓存 = { at: Date.now(), 值 }
    return 值
  } catch (error) {
    // 失败也记一下，别让每个步骤都卡在同一个超时上
    const 值 = { ok: false }
    睡眠缓存 = { at: Date.now(), 值 }
    return 值
  } finally {
    clearTimeout(定)
  }
}

/** 把她放倒 / 叫起来（房间的 /api/sleep）。 */
export async function 设置睡眠(睡, 超时毫秒 = 3000, origin = 房间地址) {
  const 控 = new AbortController()
  const 定 = setTimeout(() => 控.abort(), 超时毫秒)
  try {
    const r = await fetch(origin + '/api/sleep', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 睡: Boolean(睡) }),
      signal: 控.signal,
    })
    if (!r.ok) return { ok: false, 说: '房间回了 ' + r.status }
    const j = await r.json().catch(() => null)
    const 睡着 = j && typeof j.睡着 === 'boolean' ? j.睡着 : Boolean(睡)
    // The response includes the current setting. Avoid assuming wake permission on cold starts.
    const snapshot = j?.snapshot;
    睡眠缓存 = snapshot?.settings ? {at:Date.now(),值:{ok:true,睡着,可叫醒:snapshot.settings.可叫醒!==false,until:snapshot.activity?.until}} : {at:0,值:null};
    return { ok: true, 睡着 }
  } catch (error) {
    return { ok: false, 说: '叫不动房间：' + String((error && error.message) || error) }
  } finally {
    clearTimeout(定)
  }
}

/** 房间上报的开关跟本地那份对齐；还在待推的键不被房间里的旧值盖掉。 */
function 对齐本地设置(房) {
  const 旧 = 读配置()
  const 待 = new Set(旧.待推设置)
  const 补 = {}
  for (const 键 of ['学菜', '画图']) {
    if (待.has(键)) continue
    if (typeof 房[键] === 'boolean' && 旧[键] !== 房[键]) 补[键] = 房[键]
  }
  if (Object.keys(补).length) 写配置(补)
}

let 正在补推 = false

/**
 * 房间起来了就把还没送到的开关补推一次。
 * 已经确认在跑的时候传 已知在跑=true，省一次健康检查。
 */
export async function 补推房间设置(记 = () => {}, 已知在跑 = false) {
  if (正在补推) return false
  const 配置 = 读配置()
  const 待 = 配置.待推设置.filter((键) => 键 === '学菜' || 键 === '画图')
  if (!待.length) return false
  if (!已知在跑 && !(await 探健康())) return false
  正在补推 = true
  try {
    const 发 = {}
    for (const 键 of 待) 发[键] = 配置[键] !== false
    if (!(await 写房间设置(发))) return false
    // 只清掉「发出去的那个值」：补推期间她又点了一下的话，新值还得留着待推
    const 旧 = 读配置()
    写配置({ 待推设置: 旧.待推设置.filter((键) => !待.includes(键) || 旧[键] !== 发[键]) })
    记('房间设置补推成功：' + 待.join('、'))
    return true
  } catch (error) {
    return false
  } finally {
    正在补推 = false
  }
}

function 读房间记录() {
  try {
    const j = JSON.parse(fs.readFileSync(房间记录路, 'utf8'))
    const pid = Math.trunc(Number(j && j.pid))
    return Number.isFinite(pid) && pid > 0 ? { pid, at: Number(j.at) || 0 } : null
  } catch (error) {
    return null
  }
}

function 写房间记录(pid) {
  try {
    fs.mkdirSync(家, { recursive: true })
    fs.writeFileSync(房间记录路, JSON.stringify({
      pid, at: Date.now(), 目录: 房间目录, 端口: 房间端口,
    }, null, 2), 'utf8')
  } catch (error) {}
}

function 删房间记录() {
  try { fs.rmSync(房间记录路, { force: true }) } catch (error) {}
}

function 进程还在(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 是「进程在，只是轮不到我们问」；ESRCH 才是真没了
    return Boolean(error && error.code === 'EPERM')
  }
}

/** pid 记录不可用时按端口找。只认 LISTENING 那行 —— 客户端连接的本地地址也是这个端口。 */
function 按端口找pid() {
  try {
    const 出 = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    for (const 原行 of 出.split(/\r?\n/)) {
      const 格 = 原行.trim().split(/\s+/)
      if (格[0] !== 'TCP' || 格.length < 5) continue
      if (!String(格[1] || '').endsWith(':' + 房间端口)) continue
      if (String(格[3] || '').toUpperCase() !== 'LISTENING') continue
      const pid = Math.trunc(Number(格[4]))
      if (Number.isFinite(pid) && pid > 0) return pid
    }
  } catch (error) {}
  return 0
}

/** 编译版本号：Vite 产物文件名里的内容哈希。读不到就空着，不编一个出来。 */
function 编译版本号() {
  try {
    const 文 = fs.readFileSync(path.join(房间目录, 'dist', 'index.html'), 'utf8')
    const m = /\/assets\/main-([A-Za-z0-9_-]+)\.js/.exec(文)
    return m ? m[1] : ''
  } catch (error) {
    return ''
  }
}

export async function 房间状态() {
  const health = await 读房间健康()
  const 旧版 = 是旧版房间(health)
  return { 运行中: 是目标房间(health) || 旧版, 地址: 房间地址, 练习: 旧版 ? '' : 编译版本号(), 旧版 }
}

/** 房间要一个真的 node；DSH 自己跑在 Electron 里，process.execPath 不是它。 */
function 找node() {
  const 候选 = [
    path.join(房间目录, 'runtime', 'node.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
    'node',
  ]
  for (const node of 候选) {
    if (node !== 'node' && !fs.existsSync(node)) continue
    try {
      const version = execFileSync(node, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 2000 }).trim()
      const match = /^v(\d+)\.(\d+)\./.exec(version)
      if (match && (+match[1] > 22 || (+match[1] === 22 && +match[2] >= 13))) return node
    } catch (error) {}
  }
  throw new Error('请先安装 Node.js 22.13 或更新版本。')
}

function 找浏览器() {
  const 候选 = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ]
  for (const 一个 of 候选) {
    try { if (一个 && fs.existsSync(一个)) return 一个 } catch (error) {}
  }
  return ''
}

// 启动是异步的，自动自启和侧栏连点可能在同一个瞬间都来 —— 只许起一次
let 正在起 = null

export async function 启动房间(记 = () => {}) {
  if (正在起) return 正在起
  正在起 = 真启动(记).finally(() => { 正在起 = null })
  return 正在起
}

async function 真启动(记) {
  const 版本 = 编译版本号()
  const 健康 = await 读房间健康()
  if (是目标房间(健康)) {
    return { ok: true, 已启动: false, 说: '已经在跑', 状态: { 运行中: true, 地址: 房间地址, 练习: 版本 } }
  }
  if (是旧版房间(健康)) {
    return { ok: true, 已启动: false, 说: '原来的鱼鱼窝正在运行', 状态: { 运行中: true, 地址: 房间地址, 练习: '', 旧版: true } }
  }
  if (健康) {
    return { ok: false, 已启动: false, 说: '端口 ' + 房间端口 + ' 已被占用，请为鱼鱼窝换一个端口。', 状态: { 运行中: false, 地址: 房间地址, 练习: 版本 } }
  }

  const 入口 = path.join(房间目录, 'app-server.js')
  if (!fs.existsSync(入口)) {
    return {
      ok: false,
      已启动: false,
      // ⚠ 房间三百多兆（3D 模型 + 卡牌素材），npm 装不下，所以本体是**单独下载**的。
      //   这里必须说清"去哪拿、放到哪"，只回一句"找不到路径"等于让人干瞪眼。
      说: '房间本体还没装。它是另一份程序（三百多兆，装不进 npm）—— 去 Releases 下载后解压，' +
        '把目录填到设置里的「房间目录」（或者设环境变量 FISH_ROOM_DIR 指过去）。' +
        '现在找的位置：' + 房间目录,
      状态: { 运行中: false, 地址: 房间地址, 练习: 版本 },
    }
  }

  let 子
  try {
    const env = { ...process.env }
    if (房间档案) env.DAYU_DATA_DIR = 房间档案
    if (使用内置房间 && !env.DAYU_DSH_BRIDGE) env.DAYU_DSH_BRIDGE = 'discover'
    子 = spawn(找node(), [入口, '--production', '--port', String(房间端口)], {
      cwd: 房间目录,
      env,
      detached: true,      // DSH 退了，房间还该继续活
      stdio: 'ignore',
      windowsHide: true,   // 不弹黑框
    })
  } catch (error) {
    return { ok: false, 已启动: false, 说: '拉不起来：' + String((error && error.message) || error), 状态: { 运行中: false, 地址: 房间地址, 练习: 版本 } }
  }

  // spawn 的失败是异步冒出来的：等「真起来了」再等健康检查，免得白等 20 秒
  const 起没起 = await new Promise((resolve) => {
    const 定 = setTimeout(() => resolve(true), 800)
    子.once('spawn', () => { clearTimeout(定); resolve(true) })
    子.once('error', (错误) => { clearTimeout(定); resolve(String((错误 && 错误.message) || 错误)) })
  })
  if (起没起 !== true) {
    return { ok: false, 已启动: false, 说: '拉不起来：' + 起没起, 状态: { 运行中: false, 地址: 房间地址, 练习: 版本 } }
  }
  if (子.pid) 写房间记录(子.pid)
  子.unref()   // 别让 DSH 退出时把房间一起带走

  // 最多等 20 秒：房间要读 sqlite、补算离线生活，慢的时候真能拖几秒
  for (let i = 0; i < 40; i++) {
    await 睡(500)
    if (await 探健康()) {
      if (子.pid) 记('房间在后台起来了（pid ' + 子.pid + '）')
      // 房间刚起来，别拿它没开时的失败缓存去判断睡没睡
      睡眠缓存 = { at: 0, 值: null }
      // 房间刚起来，正是补推「上次没送达」的那两个开关的时候
      await 补推房间设置(记, true)
      return { ok: true, 已启动: true, pid: 子.pid || 0, 说: '起来了', 状态: { 运行中: true, 地址: 房间地址, 练习: 编译版本号() } }
    }
  }
  return {
    ok: false, 已启动: true, pid: 子.pid || 0, 说: '进程拉起来了，但 20 秒内健康检查没通过',
    状态: { 运行中: false, 地址: 房间地址, 练习: 版本 },
  }
}

export async function 停止房间(记 = () => {}) {
  const 原状态 = await 房间状态()
  if (原状态.旧版) {
    return { ok: false, 停止: false, 说: '当前打开的是原来的鱼鱼窝，请在房间右上角退出。', 状态: 原状态 }
  }
  if (!原状态.运行中) {
    删房间记录()
    return { ok: true, 停止: false, 说: '本来就没在跑', 状态: await 房间状态() }
  }

  if (使用内置房间) {
    try {
      const response = await fetch(房间地址 + '/api/shutdown', {
        method: 'POST',
        headers: { Origin: 房间地址, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(健康超时),
      })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      for (let i = 0; i < 12 && await 探健康(); i++) await 睡(150)
      const 状态 = await 房间状态()
      if (状态.运行中) throw new Error('退出后后台仍在运行')
      删房间记录()
      记('房间后台已退出')
      return { ok: true, 停止: true, 说: '房间后台已退出', 状态 }
    } catch (error) {
      return { ok: false, 停止: false, 说: '没能关闭房间：' + error.message, 状态: await 房间状态() }
    }
  }

  const 记录 = 读房间记录()
  let pid = 记录 && 进程还在(记录.pid) ? 记录.pid : 0
  let 按 = '记下的 pid'
  if (!pid) { pid = 按端口找pid(); 按 = 房间端口 + ' 端口' }
  if (!pid) {
    return { ok: false, 停止: false, 说: '端口上确实有服务，但找不到它的进程号', 状态: await 房间状态() }
  }

  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 })
  } catch (error) {
    // taskkill 报错不代表没停成（进程可能刚好自己退了）；下面以健康检查为准
  }
  删房间记录()

  for (let i = 0; i < 20; i++) {
    await 睡(250)
    if (!(await 探健康(1000))) break
  }
  const 状态 = await 房间状态()
  if (状态.运行中) {
    return { ok: false, 停止: false, pid, 说: '进程停过，但端口还在答话（可能是别的程序占着）', 状态 }
  }
  记('房间停了（按' + 按 + '找的 pid ' + pid + '）')
  return { ok: true, 停止: true, pid, 状态 }
}

// 3 秒内连点只开一次；做不到精确判断窗口开没开，这样至少不会叠一串窗口
let 上次开窗 = 0

export async function 打开房间窗口(记 = () => {}) {
  const 起 = await 启动房间(记)
  if (!起.ok) return { ok: false, 窗口: false, 说: 起.说, 状态: 起.状态 }

  const 现在 = Date.now()
  if (现在 - 上次开窗 < 3000) {
    return { ok: true, 窗口: false, 去重: true, 说: '刚开过', 状态: 起.状态 }
  }
  // 自测用：不真弹一个窗口出来（验的是「起没起来 / 去重没有」，不是窗口长什么样）
  if (process.env.FISH_ROOM_NO_WINDOW === '1') {
    上次开窗 = 现在
    return { ok: true, 窗口: false, 去重: false, 说: '自测模式：没开窗口', 状态: 起.状态 }
  }

  const 档案 = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'DayuLittleRoom', 'browser-profile')
  const 浏览器 = 找浏览器()
  try {
    let 子
    if (浏览器) {
      // 跟 打开大肥鱼.cmd 用同一个 profile：窗口位置、设置、缓存都还在那儿
      子 = spawn(浏览器, [
        '--app=' + 房间地址,
        '--user-data-dir=' + 档案,
        '--no-first-run',
        '--no-default-browser-check',
        '--start-maximized',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
      ], { detached: true, stdio: 'ignore', windowsHide: true })
    } else {
      // 没装 Chrome / Edge 就交给系统默认浏览器
      子 = spawn('cmd.exe', ['/c', 'start', '', 房间地址], { windowsHide: true, detached: true, stdio: 'ignore' })
    }
    await new Promise((resolve, reject) => {
      子.once('spawn', resolve)
      子.once('error', reject)
    })
    子.unref()
    上次开窗 = 现在
  } catch (error) {
    return { ok: false, 窗口: false, 说: '打开窗口失败：' + String((error && error.message) || error), 状态: 起.状态 }
  }
  记('房间窗口叫出来了')
  return { ok: true, 窗口: true, 去重: false, 状态: 起.状态 }
}

/* ───────────────────────── 插件本体 ───────────────────────── */

export function apply(ctx, 配置参数 = {}) {
  // ⚠ 整个 apply 包一层：这个插件出什么事都不能把宿主带下去。
  //   （2026-11-12 有一次宿主在起来 40 秒后堆爆到 4GB —— 没证据说是这里，
  //     但「插件不许连累宿主」这条没得商量。）
  try {
    return 起来(ctx, 配置参数)
  } catch (error) {
    try { ctx.logger?.info?.('fish-home: 起不来（不影响 DSH）：' + String((error && error.message) || error)) } catch (e2) {}
    return { 状态: () => ({ ok: false, 说: String((error && error.message) || error) }) }
  }
}

function 起来(ctx, 配置参数 = {}) {
  let 配置 = 保证令牌()

  const 日志 = []
  const 记一笔 = (话) => {
    const d = new Date()
    const 补 = (n) => String(n).padStart(2, '0')
    const 时 = `${补(d.getHours())}:${补(d.getMinutes())}:${补(d.getSeconds())}`
    日志.push({ 时, 话: String(话) })
    if (日志.length > 200) 日志.shift()
    try { ctx.logger?.info?.('fish-home: ' + 话) } catch (error) {}
  }

  /* ── 事件流 ── */
  const epoch = randomUUID().slice(0, 8)
  let seq = 0
  const 历史 = []          // 环形缓冲，断线重连时按 since 补发
  const 历史上限 = 400
  const 连接们 = new Set()

  function 封事件(type, data) {
    return {
      schema: EVENT_SCHEMA,
      v: 1,
      id: 'evt_' + randomUUID(),
      seq: ++seq,
      epoch,
      at: Date.now(),
      type: 事件白名单.has(type) ? type : 'bridge.notice',
      data: data && typeof data === 'object' ? data : {},
    }
  }

  function 写一帧(res, 事件) {
    try {
      res.write('id: ' + 事件.seq + 换行
        + 'event: ' + 事件.type + 换行
        + 'data: ' + JSON.stringify(事件) + 换行 + 换行)
    } catch (error) {}
  }

  function 发事件(type, data, 不进历史 = false) {
    const 事件 = 封事件(type, data)
    // ⚠ 带图的（paint.image）不进环形缓冲：一张 base64 好几 MB，攒 400 条就把内存吃光了
    if (!不进历史) {
      历史.push(事件)
      if (历史.length > 历史上限) 历史.shift()
    }
    for (const res of 连接们) 写一帧(res, 事件)
    return 事件
  }

  /* ── 房间那边报上来的东西 ── */
  let 最近状态 = null
  let 现场状态 = null
  let 自动叫醒 = null
  // 房间自己的地址（它每次报状态的时候一起带上来）。
  // 有了它插件才能反过来问房间：田里明细、卡池、抽一发。
  const 默认房间地址 = 'http://127.0.0.1:' + 房间端口;
  let 房间地址 = ''
  let 状态版本 = 0
  const 生活事件 = []
  let 最近场景 = null
  const 互动送达中 = new Set()
  const 已请求画画 = new Map()
  let 最近说过的 = ''
  let 最近说话时 = 0
  let 上次状态通知 = { key: '', at: 0 }
  // 房间里的钟：几点、白天夜里、天气（房间那边每隔几秒报一次）
  let 房间环境 = null
  let 事件计数 = 0
  let 上次身体意图 = { key: '', at: 0 }

  async function 跟随身体意图(text, sid) {
    const intent = 识别身体意图(text)
    if (!intent || !配置.开 || !房间地址 || sid!==目标会话()) return
    const at = Date.now()
    if (intent.key === 上次身体意图.key && at - 上次身体意图.at < 10000) return
    上次身体意图 = { key: intent.key, at }
    try {
      const result = await roomRequest('/api/command', {
        name: intent.command, args: intent.args, wait: true,
      }, 30000)
      if (!result?.ok) 记一笔('身体跟随未执行：' + String(result?.error || result?.说 || '房间没有接受动作'))
    } catch (error) {
      // 失败只记本地日志，不再把解释发回会话，避免形成“她说话→插件再发命令”的回声。
      记一笔('身体跟随跳过：' + String(error?.message || error))
    }
  }

  function 收下环境(来源) {
    if (!来源 || typeof 来源 !== 'object') return
    const 时 = Number(来源.hour)
    if (!Number.isFinite(时) && !来源.weather) return
    房间环境 = {
      hour: Number.isFinite(时) ? Math.max(0, Math.min(24, 时)) : undefined,
      period: String(来源.period || ''),
      weather: String(来源.weather || ''),
      realtime: 来源.realtime !== false,
      at: Date.now(),
    }
  }

  /** 递给 DSH 的那一句：房间里现在几点、外面什么天、她在干嘛。 */
  function 互动者名字(actorName) {
    // New room versions include the saved name on the event, even before the next state sync.
    const saved = typeof actorName === 'string' ? actorName : 最近状态?.snapshot?.settings?.我的名字;
    return (typeof saved === 'string' ? saved.replace(/\s+/g, ' ').trim().slice(0, 16) : '') || '用户';
  }

  async function 读现场状态() {
    try {
      const live = await roomRequest('/api/life/activity?summary=1', undefined, 1200);
      if (!Number.isSafeInteger(live.asOf) || typeof live.睡着 !== 'boolean') return null;
      if (!现场状态 || live.asOf >= 现场状态.asOf) 现场状态 = live;
      return 现场状态;
    } catch {
      return null;
    }
  }

  function 房间那句(live = undefined) {
    const fresh = 现场状态 && Date.now()-现场状态.asOf < 5000 && 现场状态.asOf >= (最近状态?.at || 0);
    const 现场 = live === undefined ? (fresh ? 现场状态 : null) : live;
    const 快 = 现场 || 最近状态?.snapshot;
    const 房 = 房间环境
    // 取整到 10 分钟：免得每一轮都变、白白把上下文搅动一遍
    const 总分 = Number.isFinite(房?.hour) ? Math.floor(房.hour * 60 / 10) * 10 : 0
    const hh = String(Math.floor(总分 / 60) % 24).padStart(2, '0')
    const mm = String(总分 % 60).padStart(2, '0')
    const 段 = 房?.period ? '，' + 房.period : ''
    const 时间 = Number.isFinite(房?.hour) ? '房间里现在是 ' + hh + ':' + mm + 段 + '。' : ''
    const 天 = { clear: '窗外是晴天', rain: '外面在下雨', snow: '外面在下雪', cloudy: '天有点阴', storm: '外面在打雷' }[房?.weather] || ''
    const 在 = 快?.activity || 快?.presence ? 活动简报(快.activity, 快.observation, 快.presence) : ''
    const 心情 = Number.isFinite(快?.mood) ? '心情 ' + Math.round(快.mood) + '/100。' : ''
    // 家当一行：钱、田、池塘、卡册。
    // 为什么只放这么点：她得知道自己「有什么」，才想得起来去看明细；
    // 但每轮都塞 65 块地的清单，上下文很快就被吃干净了。
    const 家当 = []
    if (快 && Number.isFinite(Number(快.coins))) 家当.push('金币 ' + Math.round(Number(快.coins)))
    if (快 && 快.farm) 家当.push('田 ' + (Number(快.farm.planted) || 0) + ' 块' + (Number(快.farm.ready) ? '（' + 快.farm.ready + ' 块熟）' : ''))
    if (快 && 快.pond) 家当.push('池塘 ' + (Number(快.pond.条数) || 0) + '/' + (Number(快.pond.容量) || 8))
    if (快 && 快.卡册) 家当.push('卡册 ' + (Number(快.卡册.已集) || 0) + '/' + (Number(快.卡册.总) || 0))
    const 攒 = 家当.length ? (现场 ? '' : '上次同步：') + 家当.join(' · ') + '。' : ''
    const 最近 = 生活事件.filter(e => e.sessionId === 目标会话() && Date.now() - e.at < 5 * 60000 && !e.notified && ['milestone','farm'].includes(e.kind)).slice(-2)
      .map((x) => String((x && x.text) || '').trim())
      .filter(Boolean)
      .map((t) => (t.length > 24 ? t.slice(0, 24) + '…' : t))
    const 刚才 = 最近.length ? '刚才：' + 最近.join('；') + '。' : ''
    const 场景 = 最近场景?.sid === 目标会话() && Date.now() - 最近场景.at < SCENE_TTL_MS ? '刚才在场景里：' + 最近场景.text : ''
    const 醒 = 自动叫醒?.sessionId === 目标会话() && Date.now()-自动叫醒.at < 120000
      ? '这轮收到新消息时已叫醒大肥鱼。' : ''
    const 正文 = 时间 + (天 ? 天 + '。' : '') + 在 + 醒 + 心情 + 攒 + 刚才 + 场景
    return 正文 && '【鱼鱼窝】' + 正文
  }

  function 状态通知文本(previous, next, oldWeather = '') {
    const lines = []
    const after = next?.snapshot || {}
    const newWeather = String(after.weather || '')
    const labels = { clear: '晴天', cloudy: '阴天', rain: '下雨', snow: '下雪', storm: '雷雨' }
    const affectsOutdoors = value => ['rain','snow','storm'].includes(value);
    if (Object.hasOwn(labels,oldWeather) && Object.hasOwn(labels,newWeather) && oldWeather !== newWeather &&
        (affectsOutdoors(oldWeather)||affectsOutdoors(newWeather))) {
      lines.push(affectsOutdoors(newWeather) ? '窗外天气变了：'+labels[newWeather]+'。' : '窗外的雨雪停了。');
    }
    return lines
  }

  function 推送状态变化(previous, next, oldWeather = '') {
    if (!配置.开 || !配置.状态变化通知 || !previous?.snapshot || !next?.snapshot || !目标会话()) return
    const agent = 找agent(目标会话())
    if (!agent || typeof agent.followup !== 'function') return
    const lines = 状态通知文本(previous, next, oldWeather)
    if (!lines.length) return
    const key = lines.join('|')
    if (key === 上次状态通知.key && Date.now() - 上次状态通知.at < 30000) return
    上次状态通知 = { key, at: Date.now() }
    void agent.followup({
      id: randomUUID(), role: 'user', source: { kind: 'fish-home-state' },
      content: [{ type: 'text', text: '【鱼鱼窝状态更新】' + lines.join(' ') }],
    }).catch(() => {})
  }

  const 地点名字={bedroom:'卧室',living:'客厅',kitchen:'厨房',bathroom:'洗漱区',study:'书房',studio:'画画区',garden:'庭院',observatory:'观星区'};
  const 实际地点 = {...地点名字, field:'菜田', pond:'池塘边', swing:'秋千旁', indoor:'屋内'};
  const 实际活动 = {idle:'闲着', walk:'走路', sit:'坐着', sleep:'睡觉', nap:'小憩', cook:'料理', clean:'整理', paint:'画画', music:'听音乐', water:'浇水', wash:'洗手', brush:'洗漱', exercise:'锻炼', stargaze:'观星', stretch:'伸懒腰', plant:'播种', harvest:'收菜', stock:'放鱼苗', pickup:'被拎起来了'};
  function 活动简报(activity, observation, presence) {
    const fresh = value => value && Number.isFinite(value.at) && Date.now()-value.at<36000;
    const visible = fresh(presence) && presence.visible;
    const arrived = fresh(observation) && observation.phase==='arrived' && observation.activityId===activity?.id && (!visible || observation.scene===presence.scene);
    const label = activity?.action==='idle' || activity?.label==='起床' ? '闲着' : String(activity?.label||'闲着').slice(0,30);
    if (visible) {
      const scene = presence.scene==='garden'?'庭院':'屋内';
      const destination = 实际地点[presence.place] || (arrived ? 地点名字[activity?.room] : '');
      const action = presence.action==='sit' && arrived ? label : 实际活动[presence.action] || (arrived ? label : '');
      return '活动：'+[scene,destination!==scene?destination:'',action].filter(Boolean).join(' · ')+'。';
    }
    if (fresh(presence) && presence.characterScene) {
      const actual=presence.characterScene==='garden'?'庭院':'屋内';
      return '位置：'+actual+'。当前画面在'+(presence.scene==='garden'?'庭院':'屋内')+'。';
    }
    if (arrived) return '活动：'+[地点名字[activity?.room],label].filter(Boolean).join(' · ')+'。';
    if (label==='闲着') return '活动：闲着。';
    return '当前安排：'+[地点名字[activity?.room],label].filter(Boolean).join(' · ')+'。';
  }

  function 身体简报(live) {
    const lines=[活动简报(live.activity,live.observation,live.presence)];
    const observation=live.observation;
    const fresh = value => Number.isFinite(value?.at)&&Date.now()-value.at<36000;
    if (lines[0]==='活动：闲着。') lines[0]='当前安排：闲着。';
    if (fresh(live.presence) && live.presence.visible && observation?.activityId===live.activity?.id &&
        ['moving','blocked'].includes(observation?.phase) && fresh(observation)) {
      const dest=地点名字[live.activity?.room];
      if (dest) lines.push((observation.phase==='moving'?'正在去':'暂时没走到')+dest+'，安排是'+String(live.activity.label||'').slice(0,30)+'。');
    }
    const feelings=[];
    const {energy,satiety,hygiene}=live.needs||{};
    if (Number.isFinite(energy)&&energy<55) feelings.push(energy<35?'很累':'有点累');
    if (Number.isFinite(satiety)&&satiety<54) feelings.push(satiety<40?'饿了':'有点饿');
    if (Number.isFinite(hygiene)&&hygiene<65) feelings.push(hygiene<35?'想洗漱':'想洗洗手');
    if (Number.isFinite(energy)&&Number.isFinite(satiety)&&Number.isFinite(hygiene)&&!feelings.length) feelings.push('状态还好');
    if (Number.isFinite(live.mood)) {
      const source=live.mood来源==='feiyu-mood'?'（鱼的心情）':live.mood来源==='local'?'（本地）':'';
      feelings.push('心情 '+Math.round(live.mood)+'/100'+source);
    }
    if (feelings.length) lines.push('身体：'+feelings.join('，')+'。');
    const scene=最近场景?.sid===目标会话() && Date.now()-最近场景.at<SCENE_TTL_MS ? 最近场景.text : '';
    const recent=scene || live.recentBodyActivity;
    if (recent) lines.push('刚才：'+String(recent).trim().slice(0,100).replace(/[。！？]+$/,'')+'。');
    return lines.join('');
  }

  // 房间时间 + 画架工具，都挂在绑定的那间会话上（跟心情插件一样按 agent 实例记）
  const 上下文挂着 = new Map() // scoped registrations and their disposers
  function 画工具() {
    return {
      name: 'paint',
      description: '在鱼鱼窝画画。描述要画的内容，使用设置里的生图接口生成一张，送到画架并收进画册。只返回简短状态。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '图像内容' },
          reference: { type: 'string', description: '可选参考图：本机图片路径、http(s) 图片地址或 data:image/...；填写后使用图生图' },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, 说: { type: 'string' }, attachment: { type: 'object', additionalProperties: true } },
          required: ['ok'],
        },
        render: (_args, 结果) => [
          { type: 'text', text: String((结果 && 结果.说) || '') },
          ...(结果?.attachment ? [{ type: 'image', attachment: 结果.attachment }] : []),
        ],
      },
      async execute(args = {}) {
        const 话 = String((args && args.prompt) || '').trim()
        if (!话) return { ok: false, 说: '要画什么？' }
        const 设置 = await 读房间设置(5000, 房间地址 || 默认房间地址)
        if ((设置.画图 ?? 配置.画图) === false) return {ok:false, 说:'鱼鱼窝的画图开关关着。'}
        if (!连接们.size) return {ok:false, 说:'鱼鱼窝后台还没连上，画架暂时收不到画。'}
        const 结果 = await 画一张(话, args.reference)
        if (!结果.ok) return { ok: false, 说: 结果.说 }
        // 图太大，不进历史缓冲，只发给现在连着的
        发事件('paint.image', { b64: 结果.b64, mime: 结果.mime, prompt: 话.slice(0, 200) }, true)
        const out = { ok:true, 说:连接们.size ? '画好了，已发往鱼鱼窝的画架和画册。' : '画好了，但鱼鱼窝刚刚断开，画作没有送到。' }
        const attachments = imageContext?.get('attachments')
        if (attachments?.saveImage) {
          try {
            const data = Buffer.from(结果.b64, 'base64')
            const attachment = await attachments.saveImage({ data, mediaType: 结果.mime || 'image/png', name: '鱼鱼窝画作.png' })
            out.attachment = attachment
          } catch (error) {}
        }
        return out
      },
    }
  }

  // 「说完晚安之后自己躺下」——不是看到「晚安」两个字就自动睡，那样连那句晚安都回不出去。
  function 睡眠工具() {
    return {
      name: 'sleep',
      description: '设置角色的睡眠状态。asleep=true 躺下，asleep=false 醒来。',
      parameters: {
        type: 'object',
        properties: {
          asleep: { type: 'boolean', description: 'true = 躺下睡觉，false = 起来' },
        },
        required: ['asleep'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, 说: { type: 'string' } },
          required: ['ok'],
        },
        render: (_args, 结果) => [{ type: 'text', text: String((结果 && 结果.说) || '') }],
      },
      async execute(args = {}) {
        const 睡 = args?.asleep ?? args?.睡
        if (typeof 睡 !== 'boolean') return { ok: false, 说: '要说清楚是睡（true）还是起（false）。' }
        const 结果 = await 设置睡眠(睡, 3000, 房间地址 || 默认房间地址)
        if (结果.ok) 自动叫醒 = null;
        if (!结果.ok) return { ok: false, 说: '房间那边没答话：' + (结果.说 || '没成。') }
        return { ok: true, 说: 睡 ? '躺下了' : '起来了' }
      },
    }
  }

  /* ── 鱼鱼窝：她自己看自己的日子 ──
   * 这个工具就是她的说明书：工具描述里写着能看什么，她不用被告知「原来还能种菜」。
   * 数据来自房间每十几秒报上来的那份状态，不额外查库，也不占上下文 ——
   * 只有她真的调这个工具，才会读出来一屏。
   */
  function 鱼鱼窝工具() {
    return {
      name: 'fish_home',
      description: '鱼鱼窝的生活数据。what 的可选范围：status（实际地点、身体感受、心情和一条近期身体经历）、farm（田里种的、还有多久熟、剩什么种子和收成）、pond（池塘几条鱼、什么鱼、多久能捞）、cards（卡册集了多少、还差哪几张、哪几张还没到珠光）、pity（卡池保底和下一抽概率，不花金币）、price（完整价目，可按类别 kind 或品名 item 筛选）、market（今天和明天的行情摘要）、wallet（正式存档的当前金币、星尘和星辉）、today（今天做过什么）、weather（庭院当前天气）、forecast（设置地区的三天预报）、all（全看一遍）。',
      parameters: {
        type: 'object',
        properties: {
          what: { type: 'string', enum: ['status','farm','pond','cards','pity','wallet','price','market','today','weather','forecast','all'], description:'要看哪一块' },
          kind: {type:'string',enum:['crop','flower','fish','giant','all'],description:'价目类别。giant 查巨型作物，省略时列出普通商品。'},
          item: {type:'string',description:'价目查询可填一个品名或 ID'},
        },
        required: ['what'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, 说: { type: 'string' } },
          required: ['ok'],
        },
        render: (_args, 结果) => [{ type: 'text', text: String((结果 && 结果.说) || '') }],
      },
      async execute(args = {}, exec) {
        const 要 = String(args.what || 'all')
        if (要 === 'weather' || 要 === 'forecast') {
          try {
            const result=await roomRequest('/api/weather'+(要==='forecast'?'?forecast=1':''),undefined,26000,exec?.signal);
            const labels={clear:'晴',cloudy:'阴或多云',rain:'雨',snow:'雪',storm:'雷雨'};
            const source={real:'同步当地天气',manual:'手动天气',fallback:'同步暂不可用，采用手动天气'}[result.source];
            const lines=['庭院：'+labels[result.weather]+'（'+source+'）。'];
            if(result.real){
              const real=result.real;
              lines.push(real.place+'：'+labels[real.weather]+(Number.isFinite(real.temp)?'，'+real.temp+'°C':'')+'。');
              if(要==='forecast')for(const day of real.forecast||[]){
                lines.push(day.date+' '+(labels[day.weather]||'天气未知')+(Number.isFinite(day.min)&&Number.isFinite(day.max)?' '+day.min+'～'+day.max+'°C':''));
              }
            }
            if(result.warning)lines.push(result.warning);
            return {ok:true,说:lines.join('\n')};
          } catch(error) {return {ok:false,说:'天气暂时查不到：'+String(error.message||error)};}
        }
        if (要==='market'||要==='price') {
          try {
            if(args.kind==='giant'){
              const {market,giantItems=[]}=await roomRequest('/api/farm',undefined,8000,exec?.signal);
              const query=String(args.item||'').trim().toLowerCase();
              const matches=giantItems.filter(item=>!query||item.id.includes(query)||item.name.toLowerCase().includes(query));
              if(!matches.length)return {ok:false,说:'没有匹配的巨型作物。'};
              const lines=matches.map(item=>`${item.name} · 今日售 ${item.sellPrice} / 明日售 ${item.tomorrowSellPrice} 金币`);
              return {ok:true,说:[`巨型作物单份售价（${market.today.date}）`,...lines].join('\n')};
            }
            const {market}=await roomRequest('/api/farm/market',undefined,8000,exec?.signal);
            const lines=[market.today.date+' · '+market.today.note,market.tomorrow.date+' 预告 · '+market.tomorrow.note];
            if (要==='market'&&!args.item&&!args.kind) return {ok:true,说:lines.join('\n')};
            const q=String(args.item||'').trim().toLowerCase();
            const items=market.items.filter(x=>(!args.kind||args.kind==='all'||x.kind===args.kind)&&(!q||x.id.includes(q)||x.name.toLowerCase().includes(q)));
            if (!items.length) return {ok:true,说:'价目表没有匹配的商品。'};
            for(const row of items){
              const profit=Math.round((row.sellPrice-row.price)*60/row.minutes);
              const change=row.sellPrice-row.baseSellPrice;
              lines.push(row.name+' ('+row.id+') · 买 '+row.price+' / 今日售 '+row.sellPrice+(change?' ('+(change>0?'+':'')+change+')':'')+' / 明日售 '+row.tomorrowSellPrice+' · '+row.minutes+' 分钟 / 净赚约 '+profit+'/小时');
            }
            return {ok:true,说:lines.join('\n')};
          } catch(error) {return {ok:false,说:'价目暂时没拿到：'+error.message};}
        }
        if (要 === 'pity') {
          try {
            const result = await roomRequest('/api/cards');
            const pools = result.cards?.pools?.map(cardOdds) || [];
            if (!pools.length) return {ok:false, 说:'没有读到卡池。'};
            return {ok:true, 说:pools.map(formatOdds).join('\n')};
          } catch (error) { return {ok: false, 说: error.message}; }
        }
        if (要==='farm'||要==='pond') {
          try {
            return {ok:true,说:farmSummary(await roomRequest('/api/farm',undefined,8000,exec?.signal),要)};
          } catch (error) { return {ok:false,说:'没读到最新农场状态：'+error.message}; }
        }
        const 段 = [];
        if (要 === 'wallet' || 要 === 'all') {
          try {
            const {cards}=await roomRequest('/api/cards',undefined,8000,exec?.signal);
            if(![cards?.coins,cards?.dust,cards?.starlight].every(Number.isSafeInteger))throw new Error('房间没有返回完整余额。');
            const 余额='正式存档当前余额 '+cards.coins+' 金币、'+cards.dust+' 星尘、'+cards.starlight+' 星辉。';
            if(要==='wallet')return {ok:true,说:余额};
            段.push(余额);
          } catch(error) {
            const 说='暂时读不到当前余额：'+error.message;
            if(要==='wallet')return {ok:false,说};
            段.push(说);
          }
        }
        if (要 === 'status' || 要 === 'all') {
          try {
            const live = await roomRequest('/api/life/activity?status=1', undefined, 5000, exec?.signal);
            const 说 = 身体简报(live);
            if (要 === 'status') return {ok:true, 说};
            段.push(说);
          } catch (error) {
            if (要 === 'status') return {ok:false, 说: '暂时读不到鱼鱼窝的当前状态。'};
          }
        }
        if (要 === 'farm' || 要 === 'all') {
          try {
            const data = await roomRequest('/api/farm', undefined, 8000, exec?.signal);
            const 说 = farmSummary(data, 'farm');
            if (要 === 'farm') return {ok:true,说};
            段.push(说);
          } catch (error) {
            const 说 = '暂时读不到当前田地：' + error.message;
            if (要 === 'farm') return {ok:false,说};
            段.push(说);
          }
        }
        const 快 = 最近状态 && 最近状态.snapshot
        if (!快 && 段.length) return {ok:true, 说:段.join('\n\n')};
        if (!快) return { ok: false, 说: '房间那边还没报上来，等一下再问。' }
        const 池 = 快.pond || null
        const 册 = 快.卡册 || null

        if (要 === 'all')段.push('行情可用 fish_home 的 market 或 price 单独查看。');
        if ((要 === 'pond' || 要 === 'all') && 池) {
          const 行 = [`池塘 ${池.条数}/${池.容量} 条`]
          for (const 鱼 of 池.鱼 || []) 行.push(`  ${鱼.species}：` + (鱼.ready ? '能捞了' : `还要 ${鱼.剩余分钟} 分钟`))
          if (池.鱼?.some(鱼=>鱼.ready)) 行.push('捞鱼用 fish_home_farm 的 catch，可指定品种和数量。');
          段.push(行.join('\n'))
        }
        if ((要 === 'cards' || 要 === 'all') && 册) {
          const 行 = [`卡册 ${册.已集}/${册.总}，其中到珠光的 ${册.珠光} 张`]
          if ((册.缺 || []).length) 行.push(`还差 ${册.缺.length} 张：${册.缺.slice(0, 20).join('、')}`)
          if ((册.未满 || []).length) 行.push(`有 ${册.未满.length} 张还没到珠光：${册.未满.slice(0, 20).join('、')}`)
          段.push(行.join('\n'))
        }
        if ((要 === 'today' || 要 === 'all') && Array.isArray(快.今日) && 快.今日.length) {
          段.push('今天做过：\n' + 快.今日.map((x) => `  ${x.time} ${x.label}`).join('\n'))
        }
        if (!段.length) return { ok: true, 说: '这会儿没有可看的东西。' }
        return { ok: true, 说: 段.join('\n\n') }
      },
    }
  }

  function 日常工具() {
    return {
      name: 'fish_home_activity',
      description: '查看鱼鱼窝当前活动、可选活动地点和活动编号，或选择一项日常活动。',
      parameters: {
        type:'object', properties:{ id:{type:'string',description:'活动编号。省略时返回当前活动和目录。'} },
        additionalProperties:false,
      },
      output: {
        schema:{type:'object',properties:{ok:{type:'boolean'},说:{type:'string'},activity:{type:'object'},observation:{type:'object'},options:{type:'array',items:{type:'object'}}},required:['ok','说']},
        render: (_args, result) => [{type:'text',text: result.说+(result.options?.length?'\n'+result.options.map(o=>o.id+' · '+o.label+'（'+(地点名字[o.room]||o.room)+'）').join('\n'):'')}],
      },
      async execute(args={}) {
        if(!房间地址)return {ok:false,说:'鱼鱼窝尚未连接。'};
        const id=typeof args.id==='string'?args.id.trim():'';
        try {
          const response=await fetch(房间地址+'/api/life/activity',id?{
            method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id}),redirect:'error',signal:AbortSignal.timeout(5000),
          }:{redirect:'error',signal:AbortSignal.timeout(5000)});
          const result=await response.json();
          if(!response.ok)return {ok:false,说:result.error||'活动暂不可用。'};
          const 说=id ? '已安排：'+(result.activity?.label||id)+'。' : 活动简报(result.activity,result.observation,result.presence);
          if(id){标记本轮身体工具();return {ok:true,说,activity:result.activity};}
          return {ok:true,说,activity:result.activity,observation:result.observation,options:result.options};
        }catch{return {ok:false,说:'鱼鱼窝暂未连通。'};}
      },
    };
  }

  /* ── 抽卡：她自己抽，抽到什么这一轮就知道 ── */
  function 抽卡工具() {
    return {
      name: 'fish_home_draw',
      description: '鱼鱼窝抽卡或兑换，结果为文字。抽卡用 draw、pool、count，兑换用 exchange、kind、quantity，换卡另填 item。查看卡面使用 fish_home_card。',
      parameters: {
        type: 'object',
        properties: {
          op: {type:'string', enum:['draw','exchange'], description:'操作，默认 draw'},
          pool: {type:'string', enum:['standard','sp','encore'], description:'抽卡池：海边常驻、鱼鱼表情、万圣节'},
          count: {type:'integer', enum:[1,10,100,1000], description:'单抽、十连、百连或千连'},
          kind: {type:'string', enum:['coins','starlight','card'], description:'星尘换金币、星尘换星辉、兑换指定卡'},
          quantity: {type:'integer', minimum:1, description:'coins 填要花的星尘，starlight 填要换到的星辉，card 每次一张'},
          item: {type:'string', description:'换卡时填卡名或卡 ID'},
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, 说: { type: 'string' }, pity: { type: 'object', additionalProperties: true }, rates: { type: 'object', additionalProperties: true } },
          required: ['ok'],
        },
        render: (_args, 结果) => [{ type: 'text', text: String((结果 && 结果.说) || '') }],
      },
      async execute(args = {}, exec) {
        const {op = 'draw', pool:池, count:次} = args ?? {};
        if (op === 'exchange') return 换卡或货币(args, exec?.signal);
        if (op !== 'draw') return {ok:false, 说:'可用操作是 draw（抽卡）和 exchange（兑换）。'};
        if (!['standard','sp','encore'].includes(池)) return {ok:false, 说:'无效的卡池。请选择 standard（海边常驻）、sp（鱼鱼表情）或 encore（万圣节）。'};
        if (![1,10,100,1000].includes(次)) return {ok:false, 说:'抽卡数量只能是 1、10、100 或 1000。'};
        try {
          const 结果 = await roomRequest('/api/cards/draw', {pool:池, count:次, requestId:randomUUID(), actor:'dayu'}, 15000, exec?.signal)
          const cards = 结果.cards;
          const summary = 结果.summary ?? drawSummaryText(结果.results, cards?.catalog);
          const 当前池 = cards?.pools?.find(p => p.id === 池);
          const odds = 当前池 ? cardOdds(当前池) : null;
          const cost = Number.isFinite(结果.cost) ? `，花费 ${结果.cost} 金币` : '';
          const wallet = cards ? `余额 ${结果.coins} 金币、${cards.dust} 星尘、${cards.starlight} 星辉。` : '';
          const 说 = [`抽了 ${次} 张${cost}。${summary}`, wallet,
            odds && `距${当前池.top}保底 ${odds.pity.top} 抽，距四星及以上保底 ${odds.pity.fourOrAbove} 抽。`].filter(Boolean).join('\n');
          return { ok: Boolean(结果.ok), 说: 说.trim() || '抽卡没成，房间那边没回话。', ...(odds ? {pity: odds.pity, rates: odds.rates} : {}) }
        } catch (error) {
          if (次>=100 && error?.message==='无效的卡池或抽卡数量。') return {ok:false,说:`房间还不支持${次===1000?'千连':'百连'}，请把鱼鱼窝房间更新到 0.1.4。`};
          return { ok: false, 说: '抽卡没成：' + String((error && error.message) || error) }
        }
      },
    }
  }

  const 卡名 = card => [card.title, card.subtitle || card.edition].filter(Boolean).join(' · ');
  function 查一卡(cards, query, allowFirst=false) {
    const key = String(query ?? '').trim().toLowerCase();
    if (!key) throw new Error('需要指定一张卡的名字或 ID。');
    const catalog = cards.catalog;
    const id = catalog.find(card => card.id === key);
    if (id) return id;
    const labels = card => [card.title, card.subtitle, 卡名(card)].filter(Boolean).map(label => label.toLowerCase());
    const exact = catalog.filter(card => labels(card).includes(key));
    const matches = exact.length ? exact : catalog.filter(card => labels(card).some(label => label.includes(key)));
    if (matches.length === 1) return matches[0];
    if (!matches.length) throw new Error('卡册里没找到这张卡。');
    if (allowFirst) return {...matches[0], alternativeCount:matches.length-1};
    throw new Error('找到多张，请选一张：'+matches.slice(0,6).map(card => 卡名(card)+'（'+card.id+'）').join('、')+'。');
  }

  async function 换卡或货币({kind, item, quantity=1}, signal) {
    if (!['coins','starlight','card'].includes(kind)) return {ok:false, 说:'请选择 coins（金币）、starlight（星辉）或 card（卡牌）。'};
    if (!Number.isSafeInteger(quantity) || quantity < 1 || (kind === 'card' && quantity !== 1)) return {ok:false, 说:'数量须为正整数，指定卡每次换一张。'};
    try {
      let card;
      if (kind === 'card') {
        const {cards} = await roomRequest('/api/cards', undefined, 8000, signal);
        card = 查一卡(cards, item);
      }
      const result = await roomRequest('/api/cards/exchange', {kind, quantity, ...(card ? {item:card.id} : {}), actor:'dayu', requestId:randomUUID()}, 15000, signal);
      const {cards} = result;
      return {ok:true, 说:result.say+' 余额 '+cards.coins+' 金币、'+cards.dust+' 星尘、'+cards.starlight+' 星辉。'};
    } catch (error) {
      return {ok:false, 说:'兑换没成：'+String(error.message || error)};
    }
  }

  function 卡面工具() {
    return {
      name:'fish_home_card',
      description:'按卡名或 ID 查看一张卡的卡面。只在要看图时调用，每次返回一张，抽卡后无须调用。',
      parameters:{type:'object', properties:{card:{type:'string', description:'一张卡的卡名或卡 ID'}}, required:['card'], additionalProperties:false},
      output:{
        schema:{type:'object', properties:{ok:{type:'boolean'}, 说:{type:'string'}, url:{type:'string'}, attachment:{type:'object', additionalProperties:true}}, required:['ok','说']},
        render:(_args,result)=>[
          {type:'text',text:result.说+(result.url && !result.attachment ? '\n[打开卡面]('+result.url+')' : '')},
          ...(result.attachment ? [{type:'image',attachment:result.attachment}] : []),
        ],
      },
      async execute(args={}, exec) {
        const signal=exec?.signal;
        try {
          const origin=房间地址 || 默认房间地址;
          const {cards}=await roomRequest('/api/cards', undefined, 8000, signal);
          const card=查一卡(cards,args.card,true);
          if (!/^[a-z0-9][a-z0-9_-]{0,80}$/.test(card.id)) throw new Error('卡面地址无效。');
          const url=origin+'/cards/'+card.id+'/thumb.png';
          const owned=Object.hasOwn(cards.owned||{},card.id)?cards.owned[card.id]:null;
          const finish=['普通','银箔','镀金','珠光'][owned?.finish];
          const status=owned?'已拥有'+(finish?' · '+finish:''):'未拥有';
          const chosen=card.alternativeCount?'。找到 '+(card.alternativeCount+1)+' 张，先展示这一张（'+card.id+'）':'';
          const result={ok:true, 说:卡名(card)+'（'+card.rarity+'） · '+status+chosen,url};
          const attachments=imageContext?.get('attachments');
          if (!attachments?.saveImage) return result;
          const maxBytes=Math.min(2*1024*1024, attachments.imageLimits?.maxImageBytes || Infinity, attachments.imageLimits?.maxMessageImageBytes || Infinity);
          const deadline=AbortSignal.timeout(8000);
          const picture=await fetch(url,{redirect:'error',signal:signal ? AbortSignal.any([deadline,signal]) : deadline});
          if (!picture.ok || picture.headers.get('content-type')?.split(';')[0] !== 'image/png') throw new Error('卡面图片暂时读不到。');
          if (Number(picture.headers.get('content-length')) > maxBytes) {
            await picture.body.cancel();
            return result;
          }
          const chunks=[];
          let size=0;
          for await (const chunk of picture.body) {
            size+=chunk.byteLength;
            if (size>maxBytes) return result;
            chunks.push(chunk);
          }
          const data=Buffer.concat(chunks,size);
          if (data.subarray(0,8).toString('hex') !== '89504e470d0a1a0a') throw new Error('卡面图片无效。');
          try {
            result.attachment=await attachments.saveImage({data,mediaType:'image/png',name:card.id+'.png'});
          } catch { /* 附件服务不可用时仍保留卡面链接。 */ }
          return result;
        } catch (error) {
          return {ok:false,说:String(error.message || error)};
        }
      },
    };
  }

  function 菜谱工具() {
    return {
      name:'fish_home_recipe',
      description:'查鱼鱼窝菜谱。无参数时看今天挂的菜名，query 按菜名或 ID 查，detail=true 读一道菜的食材和做法。关掉学菜时只读菜名。',
      parameters:{type:'object', properties:{query:{type:'string', description:'菜名、关键词或菜谱 ID'}, detail:{type:'boolean', description:'是否查看一道菜的食材与步骤，默认只看摘要'}}, additionalProperties:false},
      output:{schema:{type:'object', properties:{ok:{type:'boolean'}, 说:{type:'string'}}, required:['ok','说']}, render:(_args,result)=>[{type:'text',text:result.说}]},
      async execute(args={},exec) {
        const query=new URLSearchParams();
        if (typeof args.query === 'string') query.set('q',args.query.trim().slice(0,120));
        if (args.detail === true) query.set('detail','1');
        try {
          const result=await roomRequest('/api/kitchen/query?'+query,undefined,8000,exec?.signal);
          const dish=result.菜;
          if (!dish) {
            const names=(result.候选 || []).map(c=>c.名+'（'+c.id+'）').join('、');
            return {ok:true,说:names ? '找到 '+result.找到+' 道菜：'+names+'。' : '没有找到这道菜。'};
          }
          const lines=[(result.今天 ? '今天的菜谱 · ' : '')+dish.名];
          if (result.学菜 && args.detail === true) {
            for (const [key,title] of [['原料','食材'],['计算','用量'],['步骤','做法']]) {
              if (!dish[key]?.length) continue;
              const items=dish[key].map((line,i)=>key==='步骤'?(i+1)+'. '+line:'- '+line);
              lines.push('**'+title+'**\n'+items.join('\n'));
            }
          } else if (!result.学菜 && args.detail === true) lines.push('学菜开关关着，目前只显示菜名。');
          return {ok:true,说:lines.join('\n\n')};
        } catch (error) {
          return {ok:false,说:'菜谱暂时翻不开：'+String(error.message || error)};
        }
      },
    };
  }

  async function roomRequest(route, params, timeout = 8000, signal) {
    const origin = 房间地址 || 默认房间地址;
    const deadline = AbortSignal.timeout(timeout);
    const response = await fetch(origin + route, {
      redirect: 'error', signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      ...(params === undefined ? {} : { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(params) }),
    });
    if (route==='/api/farm/plant-giant-batch' && response.status===404) {
      throw new Error('当前房间还没更新到支持整块 3×3 播种的版本；这一步没有买种或播种。');
    }
    const result = await response.json();
    if (result.ok === false || !response.ok) throw Object.assign(new Error(result.say || result.说 || result.error || '鱼鱼窝没有完成这次操作。'),{code:result.code,result});
    return result;
  }

  function cardOdds(pool) {
    return {name: pool.name, top: pool.top, pity: {top: pool.topRemaining, fourOrAbove: pool.fourRemaining}, rates: pool.rates};
  }

  function formatOdds({name, top, pity, rates}) {
    if (!rates) return name + '的概率暂时没有读到。';
    const pct = x => Number((x * 100).toFixed(2)) + '%';
    return name + '：' + top + '最多还差 ' + pity.top + ' 抽，四星及以上最多还差 ' + pity.fourOrAbove + ' 抽。下一抽 ' + top + ' ' + pct(rates.top) + ' / 4★ ' + pct(rates.four) + ' / 3★ ' + pct(rates.three) + '。';
  }

  const destinations = {
    garden: ['outdoor','庭院','院子'], field: ['farm','farm-care','田','菜园','菜田','田地','花田'],
    pond: ['courtyard-pond','池塘','鱼塘'], swing: ['courtyard-swing','秋千'], indoor: ['inside','home','屋里','屋内','室内'],
    bedroom: ['卧室'], living: ['客厅','沙发'], kitchen: ['厨房'], bathroom: ['洗漱区','卫生间'],
    study: ['书房','书桌'], studio: ['画画区','画架'], observatory: ['观星区','望远镜'],
  };
  const aliases = Object.keys(destinations).flatMap(key => [[key,key], ...destinations[key].map(value => [value,key])]);
  const destinationByName = new Map(aliases);
  const string = (value) => typeof value === 'string' ? value.trim() : '';
  const replySchema = {type:'object',properties:{ok:{type:'boolean'},说:{type:'string'}},required:['ok','说']};
  const textOutput = {schema:replySchema,render:(_args,result)=>[{type:'text',text:result.说}]};

  function 走过去工具() {
    return {
      name: 'fish_home_go',
      description: '让大肥鱼走到指定地点，等待网页确认到达。dest 可用 field 菜田、pond 池塘、garden 庭院、swing 秋千、indoor 屋内或具体房间。',
      parameters: {
        type:'object',
        properties:{
          dest:{type:'string',description:'field / pond / garden / swing / indoor / bedroom / living / kitchen / bathroom / study / studio / observatory'},
          to:{type:'string',description:'dest 的旧别名'},
          place:{type:'string',description:'dest 的旧别名'},
        },
        additionalProperties:false,
      },
      output:textOutput,
      async execute(args={}, exec) {
        const raw = [args.dest,args.to,args.place,args.where,args.location,args.spot,args.target,args.id,args.去哪].map(string).find(Boolean);
        if (!raw) return {ok:false,说:'需要地点参数 dest，例如 {"dest":"field"}。'};
        const dest = destinationByName.get(raw.toLowerCase());
        if (!dest) return {ok:false,说:'找不到「'+raw+'」。可用地点：'+Object.keys(destinations).join(' / ')+'。'};
        const woke = 自动叫醒?.sessionId === 目标会话() && Date.now()-自动叫醒.at < 120000;
        if (woke) 自动叫醒 = null;
        const beforeMove = woke ? '刚才收到消息时已先叫醒。' : '';
        try {
          const signal=exec?.signal;
          const move=()=>roomRequest('/api/command',{name:'moveTo',args:{dest},wait:true},30000,signal);
          let result;
          try {
            result=await move();
          } catch(error) {
            // Older game tabs may report the text without the new code.
            const viewChanged=error.code==='VIEW_CHANGED'||error.message==='画面已变更，未能确认到达。';
            if(!viewChanged||signal?.aborted)throw error;
            await 睡(600,undefined,{signal});
            result=await move();
          }
          if(!result.presence?.visible||result.presence.place!==dest)return {ok:false,说:beforeMove+'页面还没有确认到达。刷新鱼鱼窝后再试。'};
          const location=实际地点[dest]||raw;
          标记本轮身体工具()
          return {ok:true,说:beforeMove+'已到达「'+location+'」。'+活动简报(null,null,result.presence)};
        } catch (error) { return {ok:false,说:beforeMove+'没走成：'+error.message}; }
      },
    };
  }

  function inventoryLine(items={}) {
    return Object.entries(items).map(([id,n])=>id+'×'+n).join('、')||'空';
  }

  function saleReceipt(result) {
    const {id,name,n,unitPrice} = result.卖出;
    const summary = `卖了 ${n} 份${name}，入账 ${result.得了} 金币。`;
    if (!id.startsWith('giant_')) return summary;
    const remaining = result.wallet?.giants?.[id.slice('giant_'.length)] || 0;
    return `${summary} 每份 ${unitPrice} 金币，背包还剩 ${remaining} 份${name}。`;
  }

  function farmSummary(data,scope='all') {
    const farm=data.farm;
    const lines=[];
    if(scope!=='pond') {
      const groups=new Map();
      const giants=farm.giants || [];
      const giantNames=new Map((data.giantItems || []).map(item=>[item.cropId,item.name]));
      const giantName=cropId=>giantNames.get(cropId) || `巨型${cropId}`;
      const occupiedByGiants=new Set(giants.flatMap(item=>item.plotIds));
      let emptyVegetables=0,emptyFlowers=0;
      for(const plot of farm.plots){
        if(!plot.cropId){
          if(plot.id.startsWith('flower-'))emptyFlowers++;
          else emptyVegetables++;
          continue;
        }
        if (occupiedByGiants.has(plot.id)) continue;
        const group=groups.get(plot.cropId)||{growing:0,ready:0};
        if(plot.ready)group.ready++;
        else group.growing++;
        groups.set(plot.cropId,group);
      }
      lines.push(`总空位 ${emptyVegetables+emptyFlowers} 格：菜田 ${emptyVegetables}、花田 ${emptyFlowers}。`);
      if(groups.size)lines.push([...groups].map(([id,g])=>id+' '+g.growing+' 格生长、'+g.ready+' 格成熟').join('；')+'。');
      if (giants.length) {
        const counts=new Map();
        for (const giant of giants) counts.set(giant.cropId,(counts.get(giant.cropId)||0)+1);
        const mature=[...counts].map(([id,n])=>`${giantName(id)}×${n}`).join('、');
        lines.push(`田里已长成：${mature}，共占 ${occupiedByGiants.size} 格。`);
      }
      const inventory=Object.entries(data.giants||{}).map(([id,n])=>`${giantName(id)}×${n}`).join('、');
      lines.push(`种子：${inventoryLine(data.seeds)}。普通收成：${inventoryLine(data.crops)}。巨型收成：${inventory||'空'}。`);
      if(farm.autoCare&&data.自动播种开启)lines.push('自动补种已开，鱼鱼会使用背包种子种空地。');
    }
    if(scope!=='farm'){
      const pond=farm.pond;
      const fish=pond.fish.map(f=>f.species+(f.ready?' 已长成':' '+Math.max(1,Math.ceil(f.remainingMs/60000))+' 分钟'));
      lines.push('池塘在养 '+fish.length+'/'+pond.capacity+' 条'+(fish.length?'：'+fish.join('、'):'')+'。');
      lines.push('鱼篓待放养鱼苗：'+inventoryLine(data.fry)+'。鱼篓成鱼（已捞、可卖）：'+inventoryLine(data.fish)+'。');
    }
    return lines.join('\n');
  }

  function 鱼塘回执(result,op,name) {
    const change=result.pondChange;
    if(!change)return result.say;
    const pond=result.farm.pond;
    const lines=[result.say];
    if(op==='stock'){
      if(change.speciesBefore)lines.push('下苗前池里已有 '+change.speciesBefore+' 条'+name+'。');
      lines.push('池里现在有 '+change.speciesInPond+' 条'+name+'，鱼篓剩 '+change.remainingFry+' 条鱼苗。');
    } else lines.push('鱼篓可卖成鱼：'+inventoryLine(result.wallet.fish)+'。');
    lines.push('池塘共 '+change.after+'/'+pond.capacity+' 条。');
    return lines.join(' ');
  }

  const 每轮农活上限 = 2;

  function 农活工具() {
    const operations = ['plant','water','harvest','replant','buy','sell','stock','feed','catch'];
    const actionFields = {
      op: {type:'string',enum:operations},
      item: {type:'string',description:'品种 ID 或中文名。replant 省略时处理成熟作物；sell 省略时卖本批新收获，指定巨型收成用巨型品名或 kind=giant 加普通品名；stock 省略时接同一批中唯一买过的鱼种。'},
      count: {type:'integer',minimum:1,maximum:999,description:'数量。收获、浇水、补种和捞鱼默认全部符合条件的。'},
      kind: {type:'string',enum:['seed','fish','crop','giant'],description:'仅用于买卖。'},
      zone: {type:'string',enum:['vegetable','flower'],description:'限制浇水和收获范围。播种自动选对应田地。'},
      bed: {type:'integer',minimum:0,maximum:2,description:'可指定 0 到 2 号菜畦播种、浇水或收获。'},
      buyMissing: {type:'boolean',description:'用于 plant 或 replant。允许花金币时填 true，只买实际种得下且缺的种子。'},
      fill: {type:'boolean',description:'仅用于普通 plant；种满用 true，按执行时的空格数播种，省略 count。'},
      layout: {type:'string',enum:['giant'],description:'只用于菜田的 plant，giant 会找完整 3×3。花田普通播种，每朵花成熟时独立判定。'},
      fallback: {type:'string',enum:['normal'],description:'仅用于 layout=giant。用户明确接受没整区时普通种，才填 normal。'},
    };
    let pending = Promise.resolve();

    async function plan(args, catalog) {
      const {op, zone, bed, kind, layout, fallback} = args;
      const item = string(args.item);
      if (layout!==undefined&&(op!=='plant'||layout!=='giant')||fallback!==undefined&&(layout!=='giant'||fallback!=='normal')) {
        throw new Error('整块和备用布局只能用于 plant；layout 填 giant，允许普通备用时 fallback 填 normal。');
      }
      const count = args.count ?? (['harvest','water','replant'].includes(op) ? 65 : op==='catch' ? 8 : 1);
      if (args.fill!==undefined&&(typeof args.fill!=='boolean'||op!=='plant'||layout==='giant'||(args.fill&&args.count!==undefined))) throw new Error('种满用普通 plant 加 fill=true，不用填写 count。');
      if (args.buyMissing!==undefined&&(typeof args.buyMissing!=='boolean'||!['plant','replant'].includes(op))) throw new Error('buyMissing 只用于播种或补种。');
      if (!operations.includes(op)) throw new Error('请选择有效的农活。');
      if (args.plotId!==undefined) throw new Error('使用品种和数量批量操作，不需要地块编号。');
      if (!Number.isSafeInteger(count) || count<1 || count>999) throw new Error('数量必须是 1 到 999 的整数。');
      if (['plant','water','harvest','replant'].includes(op) && count>65) throw new Error('田地操作一次最多 65 格。');
      if (['stock','catch'].includes(op) && count>8) throw new Error('池塘操作一次最多 8 条。');
      if (zone!==undefined && !['vegetable','flower'].includes(zone)) throw new Error('请选择菜田或花田。');
      if (bed!==undefined && (![0,1,2].includes(bed)||zone==='flower'||!['plant','water','harvest','replant'].includes(op))) throw new Error('请指定 0 到 2 号菜畦；花田不按菜畦编号。');
      if (op==='feed') return {op, route:'feed', payload:{}};
      if (op==='sell' && !item) {
        if (args.count!==undefined || kind!==undefined) throw new Error('只卖本批收获时不用填 count 或 kind；要指定数量或分类请填品种。');
        return {op,route:'sell-current',payload:{}};
      }
      if (op==='replant' && !item) {
        if (zone!==undefined || bed!==undefined) throw new Error('原地补种不需要指定田地。');
        return {op,route:op,payload:{count,buyMissing:args.buyMissing===true}};
      }
      if (['water','harvest'].includes(op) && !item) return {op, route:op+'-batch', payload:{count,zone,bed}};
      if (op==='catch' && !item) return {op, route:'catch-batch', payload:{count}};

      const data = await catalog();
      const seeds = data.商店 || [], fish = data.鱼 || [], giants = data.giantItems || [];
      const match = list => list.find(x => x.id===item || x.name===item);
      if (op==='buy' || op==='sell') {
        const goods = op==='buy' && kind==='fish' ? fish : op==='buy' && kind==='seed' ? seeds : [...seeds,...fish,...(op==='sell'?giants:[])];
        const found = op==='sell' && kind==='giant'
          ? match(giants) || giants.find(giant=>giant.cropId===match(seeds)?.id)
          : match(goods);
        if (!found) throw new Error('找不到商品 '+item+'。');
        const category = fish.includes(found) ? 'fish' : giants.includes(found) ? 'giant' : op==='buy' ? 'seed' : 'crop';
        if (kind && kind!==category) throw new Error(found.name+'的商品分类不符。');
        if (op==='buy' && count>99) throw new Error('一次可以买 1 到 99 份。');
        return {op, route:op, name:found.name, payload:{kind:category,id:found.id,数量:count}};
      }
      if (op==='stock' || op==='catch') {
        const species = match(fish);
        if (!species) throw new Error('请指定有效的鱼种。');
        return {op, route:op+'-batch', name:species.name, payload:{item:species.id,count}};
      }
      if (op==='replant') {
        if (zone!==undefined || bed!==undefined) throw new Error('原地补种不需要指定田地。');
        const crop = item && match(seeds);
        if (item && !crop) throw new Error('商店里没有「'+item+'」这个作物品种。');
        return {op, route:op, name:crop?.name, payload:{item:crop?.id,count,buyMissing:args.buyMissing===true}};
      }
      const crop = match(seeds);
      if (!crop && layout==='giant') return {op,route:'invalid-giant',payload:{item,bed},localError:`${bed===undefined?'巨型播种':'菜畦 '+bed}：商店里没有「${item||'未指定品种'}」这种种子，这一步没买种或播种。`};
      if (!crop) throw new Error('商店里没有「'+item+'」这种作物；这与田里是否成熟无关。');
      if (op==='plant' && (zone && zone!==(Number(crop.tier)===5?'flower':'vegetable') || bed!==undefined&&Number(crop.tier)===5)) {
        throw new Error(`${crop.name}要种在${Number(crop.tier)===5?'花田，不指定菜畦':'菜田'}。`);
      }
      if (layout==='giant' && Number(crop.tier)!==5) {
        if (args.count!==undefined && count!==9) return {op,route:'invalid-giant',payload:{item,bed},localError:'菜田 3×3 固定种 9 格，count 可以省略。'};
        if (!crop.巨大) return {op,route:'invalid-giant',payload:{item,bed},localError:crop.name+'在当前房间不能长成巨型。可尝试：'+seeds.filter(seed=>seed.巨大).map(seed=>seed.name).join('、')+'。'};
        return {op,route:'plant-giant-batch',name:crop.name,payload:{cropId:crop.id,bed,buyMissing:args.buyMissing===true,fallback}};
      }
      const payload = op==='plant' ? {cropId:crop.id,count,bed,...(args.fill?{fill:true}:{}),...(args.buyMissing?{buyMissing:true}:{})} : {item:crop.id,count,zone,bed};
      return {op, route:op+'-batch', name:crop.name, payload};
    }

    // Previous harvests in this batch provide exact plot IDs for a subsequent replant.
    async function harvestForBatch(payload, write, work) {
      const before = await work.farm();
      const harvested = await write('harvest-batch',payload);
      work.update(harvested);
      const plots = new Map(before.plots.map(plot=>[plot.id,plot]));
      const claimed = harvested.harvestedPlots || (harvested.plotIds||[]).map(id=>({id,cropId:payload.item||plots.get(id)?.cropId}));
      for (const {id,cropId} of claimed) if (cropId) work.harvested.set(id,cropId);
      harvested.claimed = claimed;
      return harvested;
    }

    async function executeAction(action, write, work, harvestOptions) {
      const {op, route, payload, name} = action;
      if (action.localError) return {ok:false,说:action.localError,wallet:work.wallet};
      if (route==='sell-current') {
        if (!work.lots.size) return {ok:false,说:'本批没有新收获可在此步出售，现有库存没有扣减。',wallet:work.wallet};
        const lines=[];
        let ok=true;
        const lots=[...work.lots.values()];
        for (const {id,kind,name,quantity} of lots) {
          try {
            const sold=await write('sell',{id,kind,数量:quantity});
            work.update(sold);
            work.consume(id,sold.卖出.n);
            lines.push(saleReceipt(sold));
          } catch(error) {
            ok=false; work.update(error.result||{}); lines.push(`${name}没有卖出：${error.message}`);
          }
        }
        if (lots.some(lot=>lot.kind==='fish')) lines.push('卖完后鱼篓成鱼：'+inventoryLine(work.wallet?.fish)+'。');
        return {ok,说:lines.join(' '),wallet:work.wallet};
      }
      if (op==='replant') {
        const {item,count,buyMissing} = payload;
        const prior = [...work.harvested].filter(([,crop])=>!item || crop===item);
        const lines = [];
        let wallet, allOk = true;
        if (!prior.length) {
          const result = await harvestForBatch({item,count,forReplant:true},write,work);
          work.collect(result.collectedItems);
          lines.push(result.say); wallet=result.wallet;
        }
        const exact = prior.length ? prior.slice(0,count) : [...work.harvested].filter(([,crop])=>!item || crop===item);
        const groups = new Map();
        for (const [id,crop] of exact) {
          if (!groups.has(crop)) groups.set(crop,[]);
          groups.get(crop).push(id);
        }
        wallet ??= work.wallet;
        if (!groups.size) return {ok:false,说:lines.join(' ')||'没有可补种的地块。',wallet};
        for (const [crop,plotIds] of groups) {
          try {
            const missing=Math.max(0,plotIds.length-(wallet.seeds?.[crop]||0));
            if (buyMissing && missing) {
              const bought=await write('buy',{kind:'seed',id:crop,数量:missing}); work.update(bought); wallet=bought.wallet;
              lines.push(`补买了 ${bought.买到.n} 份种子，花费 ${bought.花了} 金币。`);
            }
            if (!(wallet.seeds?.[crop]>0)) {
              allOk=false; lines.push(`收成已入账，缺少种子，${plotIds.length} 格未补种。`); continue;
            }
            const planted=await write('plant-batch',{cropId:crop,count:plotIds.length,plotIds});
            work.update(planted); wallet=planted.wallet; lines.push(planted.say);
            for (const id of planted.plotIds||[]) work.harvested.delete(id);
            if (planted.count<plotIds.length) { allOk=false; lines.push(`还有 ${plotIds.length-planted.count} 格未补种。`); }
          } catch(error) { work.update(error.result || {}); wallet=work.wallet; allOk=false; lines.push('收成已入账，补种未全部完成：'+error.message); }
        }
        return {ok:allOk,说:lines.join(' '),wallet};
      }
      const result = op==='harvest' && harvestOptions.forReplant
        ? await harvestForBatch({...payload,...harvestOptions},write,work)
        : await write(route,{...payload,...harvestOptions});
      work.update(result);
      let 说 = result.say;
      if (op==='buy') 说 = `买了 ${result.买到.n} 份${name}${payload.kind==='fish'?'鱼苗':'种子'}，花费 ${result.花了} 金币。`;
      if (op==='sell') {
        work.consume(payload.id,result.卖出.n);
        说 = saleReceipt(result);
      }
      work.collect(result.collectedItems);
      if (op==='stock' || op==='catch') 说 = 鱼塘回执(result,op,name);
      return {ok:true,说,wallet:result.wallet,claimed:result.claimed};
    }

    return {
      name:'fish_home_farm',
      description:'种田、养鱼和买卖。用一次 batch 交全单。收、卖、原地补种可按 actions 顺序填 harvest → sell → replant；replant 会用本批刚收的地。sell 不填品种和数量，只卖本批刚收获或刚捞的，免查背包。只收后补种时，actions 里放一项 replant（可填 item）。种满某片田用 plant + fill=true，不查地、不猜数量；菜田巨型候选用 plant + layout=giant 找 3×3。花田普通播种，每朵花成熟时独立有 15% 概率变异。获准花钱才用 buyMissing，不另加 buy。stock 可用同批唯一买过的鱼种。没空区直接回报，允许普通备选才填 fallback=normal。以回执为准，无需重复查询。',
      parameters:{type:'object',properties:{
        op:{type:'string',enum:['batch','list']},
        actions:{type:'array',minItems:1,maxItems:16,items:{type:'object',properties:actionFields,required:['op'],additionalProperties:false},description:'batch 的完整操作列表，按顺序执行。多个品种各放一项，数量填 count。'},
        scope:{type:'string',enum:['farm','pond','layout','all'],description:'list 的查询范围。'},
        bed:{type:'integer',minimum:0,maximum:2,description:'list + layout 时展开指定菜畦。'},
      },required:['op'],additionalProperties:false},
      output:textOutput,
      async execute(args={}, exec) {
        const {op,bed} = args;
        const request = (route,params) => roomRequest('/api/farm'+route,params,8000,exec?.signal);

        try {
          if(op==='list') {
            if(args.scope!=='layout')return {ok:true,说:farmSummary(await request(''),args.scope)};
            if(bed!==undefined&&![0,1,2].includes(bed))throw new Error('菜畦编号为 0 到 2。');
            const {beds,flowers}=await request('/layout'+(bed===undefined?'':'?bed='+bed));
            const emptyVeg=beds.reduce((n,field)=>n+field.blocks.reduce((sum,b)=>sum+b.empty,0),0);
            const emptyFlowers=flowers?.filter(p=>!p.cropId).length;
            const lines=[bed===undefined?(flowers?`总空位 ${emptyVeg+emptyFlowers} 格：菜田 ${emptyVeg}、花田 ${emptyFlowers}。`:`菜田共空 ${emptyVeg} 格。`):`菜畦 ${bed} 共空 ${emptyVeg} 格。`];
            for(const field of beds){
              const blocks=field.blocks.map((block,i)=>{
                const marks=block.crops.map(c=>c.name+'×'+c.count);
                if(block.empty)marks.push('空×'+block.empty);
                if(block.giantFormed)marks.push('已长成巨型');
                else if(block.giantPossible)marks.push('符合巨型成片条件');
                return ['第 '+(i+1)+' 区 '+marks.join('、'),...(bed===undefined?[]:block.rows.map(row=>row.join(' | ')))].join('\n');
              });
              lines.push('bed-'+field.bed+'\n'+blocks.join('\n'));
            }
            if (flowers) lines.push('花田：'+flowers.map(p=>p.cropId?(p.giant?'巨型 ':'')+p.cropId:'空').join(' · '));
            return {ok:true,说:lines.join('\n\n')};
          }
          // Keep accepting old single-action requests while the model learns the new schema.
          const entries = op==='batch' ? args.actions : [args];
          if (!Array.isArray(entries) || !entries.length || entries.length>16) throw new Error('请在 actions 中填写 1 到 16 项农活。');
          let catalog;
          const getCatalog = () => catalog ??= request('');
          const turn = 当前轮.get(目标会话());
          const actions = [];
          for (const [index, entry] of entries.entries()) {
            try {
              if (!entry || typeof entry!=='object' || Array.isArray(entry)) throw new Error('请填写操作对象。');
              if (op==='batch' && Object.keys(entry).some(key=>!Object.hasOwn(actionFields,key))) throw new Error('该项包含不支持的参数。');
              let normalized=entry;
              if (entry.op==='stock' && !string(entry.item)) {
                const purchased=new Set(actions.filter(step=>step.op==='buy'&&step.payload.kind==='fish').map(step=>step.payload.id));
                if (purchased.size!==1) throw new Error('放苗请指定鱼种；同一批前面只买了一种鱼苗时可以省略。');
                normalized={...entry,item:[...purchased][0]};
              }
              const action=await plan(normalized,getCatalog);
              if (action.route==='sell-current' && !actions.some(prev=>['harvest','replant','catch'].includes(prev.op))) {
                throw new Error('只卖本批收获时，请在 sell 前安排收获或捞鱼；要卖背包库存请指定品种和数量。');
              }
              actions.push(action);
            } catch (error) {
              throw new Error(op==='batch' ? `整批未执行：第 ${index+1} 项：${error.message.replace(/[。；]+$/,'')}。前面的项目也没有提交。` : error.message);
            }
          }
          const run = async () => {
            const progress = turn ? (turn.farmWork ??= {batches:0,receipts:new Map()}) : {batches:0,receipts:new Map()};
            const keys = actions.map(({route,payload},index)=>JSON.stringify([route,payload,...(route==='sell-current'
              ? [actions.slice(0,index).filter(action=>['harvest','replant','catch'].includes(action.op)).map(action=>[action.route,action.payload])]
              : [])]));
            const hasNewWork = keys.some(key=>!progress.receipts.has(key));
            if (hasNewWork && progress.batches>=每轮农活上限) return {ok:false,说:'本轮已执行两次农活操作。请根据已有回执回复，剩余操作下一轮再安排。'};
            let committed=false;
            const write=async (route,payload)=>{
              const result=await request('/'+route,{...payload,requestId:randomUUID(),actor:'dayu'});
              if (result.code!=='ALREADY_FULL') committed=true;
              return result;
            };
            let currentFarm;
            const work = {harvested:new Map(),lots:new Map(),wallet:null,
              collect(items){for (const item of items||[]) {
                const lot=this.lots.get(item.id);
                this.lots.set(item.id,{...item,quantity:(lot?.quantity||0)+item.quantity});
              }},consume(id,quantity){
                const lot=this.lots.get(id);
                if (!lot) return;
                lot.quantity-=quantity;
                if (lot.quantity<=0) this.lots.delete(id);
              },async farm(){
              if (!currentFarm) { const data=await getCatalog(); currentFarm=data.farm; this.wallet ??= data.wallet||data; }
              return currentFarm;
            },update(data){
              if (data.farm) currentFarm=data.farm;
              if (data.wallet) this.wallet=data.wallet;
            }};
            let lastWallet;
            const results = [];
            for (const [index, action] of actions.entries()) {
              if (exec?.signal?.aborted) break;
              const key = keys[index];
              let result = progress.receipts.get(key);
              const repeated = Boolean(result);
              if (!repeated) {
                const harvestOptions = {};
                if (action.op==='harvest') {
                  const next=actions.slice(index+1);
                  if (next.some(step=>step.op==='replant' &&
                    (!step.payload.item || !action.payload.item || step.payload.item===action.payload.item))) harvestOptions.forReplant=true;
                  const giant=next.find(step=>step.route==='plant-giant-batch');
                  if (giant) harvestOptions.forGiant={cropId:giant.payload.cropId,bed:giant.payload.bed};
                }
                try { result = await executeAction(action,write,work,harvestOptions); }
                catch (error) { work.update(error.result || {}); result = {ok:false,说:error.message,wallet:error.result?.wallet}; }
                progress.receipts.set(key,result);
              }
              if (repeated && result.claimed) {
                const farm=await work.farm();
                const empty=new Set(farm.plots.filter(plot=>!plot.cropId).map(plot=>plot.id));
                for (const {id,cropId} of result.claimed) if (cropId&&empty.has(id)) work.harvested.set(id,cropId);
              }
              if (!repeated && result.wallet) lastWallet = result.wallet;
              const label = action.name ? action.name+'：' : '';
              const receipt = repeated ? '本轮已提交，原回执：'+result.说 : result.说;
              results.push({ok:result.ok,说:op==='batch'?`${index+1}. ${label}${receipt}`:receipt});
            }
            if (committed) progress.batches++;
            const lines = results.map(row=>row.说);
            if (op==='batch' && results.some(row=>!row.ok)) lines.unshift('各项独立结算，已完成的操作已入账；未完成的见下。');
            if (results.length<actions.length) lines.push(`已停止，还有 ${actions.length-results.length} 项未提交。`);
            if (lastWallet && (op==='batch' || ['replant','buy','sell'].includes(op))) lines.push(`余额 ${lastWallet.coins} 金币。`);
            return {ok:results.length===actions.length&&results.every(row=>row.ok),说:lines.join(op==='batch'?'\n':' ')};
          };
          const receipt = pending.then(run);
          pending = receipt.catch(()=>{});
          return await receipt;
        } catch (error) {
          return {ok:false,说:error.message};
        }
      },
    };
  }

  // Reuse DSH's native attachment store. Older hosts keep the text fallback.
  let imageContext
  ctx.inject?.(['attachments'], scope => { imageContext = scope })

  function 看一眼工具() {
    return {
      name: 'fish_home_look',
      description: '拍下大肥鱼眼前的游戏画面。view 为 scene 时拍当前游戏镜头。结果附带图片预览、PNG 链接和可交付的 .png 文件路径 file。需要打开鱼鱼窝网页。',
      parameters: {
        type: 'object',
        properties: {
          view: { type: 'string', enum: ['dayu','scene'], description: '大肥鱼视角或当前游戏镜头，默认 dayu' },
          caption: { type: 'string', description: '照片说明' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, 说: { type: 'string' }, url: { type: 'string' }, file: { type: 'string' }, attachment: { type: 'object', additionalProperties: true } },
          required: ['ok', '说'],
        },
        render: (_args, result) => {
          const blocks = [{ type: 'text', text: result.说 + (result.url ? '\n[打开 PNG 图片](' + result.url + ')' : '') }]
          if (result.attachment) blocks.push({ type: 'image', attachment: result.attachment })
          return blocks
        },
      },
      async execute(args = {}, exec) {
        const view = args.view === 'scene' ? 'scene' : 'dayu'
        let url = '', file;
        const fallback = () => ({ok: true, 说: '照片已保存，可打开 PNG。', url, ...(file ? {file} : {})});
        try {
          const signal = exec?.signal;
          let result;
          for (let attempt=0; attempt<2; attempt++) {
            const origin = 房间地址 || 默认房间地址;
            try {
              result = await roomRequest('/api/look',{view},8500,signal);
              if (!/^\/api\/shots\/shot-(?:[0-9a-f-]{36}|\d+)\.png$/i.test(result.url)) throw new Error('照片地址无效。');
              url = origin + result.url;
              break;
            } catch (error) {
              if (attempt || signal?.aborted || ['DIFFERENT_SCENE','ASLEEP'].includes(error.code)) throw error;
              await 睡(550);
            }
          }
          const picture = await fetch(url,{redirect:'error',signal:AbortSignal.timeout(8000)});
          if (!picture.ok || picture.headers.get('content-type')?.split(';')[0]!=='image/png') throw new Error('读取 PNG 失败。');
          const data = Buffer.from(await picture.arrayBuffer());
          if (data.subarray(0,8).toString('hex')!=='89504e470d0a1a0a') throw new Error('截图不是有效 PNG。');
          const name = (view==='dayu'?'大肥鱼第一视角-':'鱼鱼窝全景-') + path.basename(result.url);
          const dir = path.join(家,'fish-home-shots');
          try {
            await fs.promises.mkdir(dir,{recursive:true});
            const saved = path.join(dir,name);
            await fs.promises.writeFile(saved,data);
            file = saved;
          } catch {}
          const attachments = imageContext?.get('attachments');
          if (!attachments?.saveImage) return fallback();
          const maxBytes = Math.min(8*1024*1024,attachments.imageLimits?.maxImageBytes || Infinity,attachments.imageLimits?.maxMessageImageBytes || Infinity);
          if (data.length>maxBytes) return fallback();
          const attachment = await attachments.saveImage({data,mediaType:'image/png',name});
          const title = view==='dayu'?'拍下了大肥鱼眼前的画面。':'拍下了当前游戏镜头。';
          return {...fallback(),说:title,attachment};
        } catch (error) {
          return url ? fallback() : {ok:false,说:'照片没拍到：'+String(error?.message || error)};
        }
      },
    }
  }

  function 卸agent工具(sid) {
    const entry = 上下文挂着.get(sid);
    if (!entry) return;
    for (const off of entry.off们.values()) {
      try { if (typeof off==='function') off(); } catch {}
    }
    上下文挂着.delete(sid);
  }

  function 挂agent工具(agent = 找agent(目标会话())) {
    const target = 配置.开 ? 目标会话() : '';
    for (const sid of 上下文挂着.keys()) if (sid!==target) 卸agent工具(sid);
    if (!agent?.ctx || !target || 会话键(agent.session?.id)!==target) return;
    const previous = 上下文挂着.get(target);
    if (previous && previous.agent!==agent) 卸agent工具(target);
    const entry = 上下文挂着.get(target) || {agent, off们:new Map(), failures:new Set()};
    上下文挂着.set(target,entry);
    function register(name, add) {
      if (entry.off们.has(name)) return;
      try {
        entry.off们.set(name,add());
        entry.failures.delete(name);
      } catch (error) {
        if (!entry.failures.has(name)) 记一笔(name+' 挂不上：'+String(error?.message||error));
        entry.failures.add(name);
      }
    }
    const contextKey='fish-home context';
    if (配置.每轮注入现场 && typeof agent.ctx.systemPrompt?.context==='function') {
      register(contextKey,()=>agent.ctx.systemPrompt.context({name:'fish-home',order:950,text:()=>房间那句()}));
    } else if (entry.off们.has(contextKey)) {
      try { entry.off们.get(contextKey)?.() } catch {}
      entry.off们.delete(contextKey)
    }
    if (typeof agent.ctx.tools?.register==='function') {
      for (const create of [画工具,睡眠工具,鱼鱼窝工具,日常工具,抽卡工具,卡面工具,菜谱工具,走过去工具,农活工具,看一眼工具]) {
        const tool = create();
        register(tool.name,()=>agent.ctx.tools.register(tool));
      }
    }
  }

  /* ── 聊天：房间 → DSH ── */
  const 待回 = new Map()    // sid -> Map<DSH message id, room request>
  const 当前轮 = new Map()  // sid -> { turn, replies, direct }
  const 上一轮 = new Map()  // sid -> { turn, text }

  function 拿服务(名) {
    try { return typeof ctx.get === 'function' ? ctx.get(名) : undefined } catch (error) { return undefined }
  }

  const 代理服务 = ctx.agents || 拿服务('agents')

  function 找agent(id) {
    const 原 = String(id == null ? '' : id).trim()
    if (!原) return undefined
    const 候选 = [原]
    if (原.startsWith('session-')) 候选.push(原.slice('session-'.length))
    else 候选.push('session-' + 原)
    for (const 一个 of 候选) {
      try {
        const a = 代理服务 && typeof 代理服务.get === 'function' ? 代理服务.get(一个) : undefined
        if (a) return a
      } catch (error) {}
    }
    return undefined
  }

  /** 绑的是哪一间：配置里写的是哪间就是哪间。**没写就是没绑，不替人猜。** */
  function 目标会话() {
    return 配置.会话 ? 会话键(配置.会话) : ''
  }

  function 标记本轮身体工具() {
    const 轮=当前轮.get(目标会话())
    if(轮)轮.身体工具=true
  }

  /* ── 会话事件：DSH → 房间 ── */
  function 收到会话事件(session, event) {
    if (!配置.开) return
    const sid = 会话键(session && session.id)
    const 目标 = 目标会话()
    事件计数 += 1
    if (!目标 || sid !== 目标) return
    if (!event || !event.type) return

    // 会话一醒就把房间时间挂上（这时候才有 agent.ctx.systemPrompt 可挂）
    if (event.type === 'turn/start') {
      const existing = 当前轮.get(sid);
      if (existing && existing.turn===event.data?.turn) return;
      当前轮.set(sid, { turn: event.data?.turn, replies: [], direct: false, 身体工具:false })
      挂agent工具(找agent(sid))
      // 「她开始想了」——房间那边收到就冒个气泡，别让人干等
      发事件('chat.thinking', { at: Date.now() })
      return
    }

    if (event.type === 'user/message') {
      const d = event.data || {}
      const 源 = d.source || (d.message && d.message.source) || null
      const 类 = String((源 && 源.kind) || '')
      const 轮 = 当前轮.get(sid)
      if (轮 && 类 === 'fish-home') {
        const 票 = 待回.get(sid)?.get(d.message?.id || d.id)
        if (票 && !轮.replies.includes(票)) 轮.replies.push(票)
      }
      if (轮 && (类 === 'fish-home-touch' || 类 === 'fish-home-paint' || 类 === 'fish-home-life' || 类 === 'fish-home-state')) 轮.direct = true
      if (类 === 'fish-home' || 类 === 'fish-home-life' || 类 === 'fish-home-state') return // 房间自己说的话，不再回声
      if (是注入(类)) return                              // 运行环境 / 时间 / 别的插件
      const 文 = String(提取正文(d.message || d) || '').trim()
      if (!文) return
      发事件('chat.user', { origin: 'dsh', text: 文.slice(0, 6000), at: Date.now() })
      return
    }

    if (event.type === 'assistant/message') {
      const d = event.data || {}
      if (d.interrupted) return
      const 文 = String(提取正文(d.message) || '').trim()
      if (!文) return
      上一轮.set(sid, { turn: d.turn, text: 文 })
      return
    }

    if (event.type === 'turn/end') {
      自动叫醒 = null;
      const d = event.data || {}
      const 轮 = 当前轮.get(sid)
      if (轮?.turn === d.turn) 当前轮.delete(sid)
      const 完成 = !!(d.reason && d.reason.kind === 'completed')
      const 上 = 上一轮.get(sid)
      上一轮.delete(sid)
      const 单 = 轮?.turn === d.turn ? 轮.replies.filter(x => !x.done) : []
      for (const 一单 of 单) {
        一单.done = true
        待回.get(sid)?.delete(一单.id)
        if (!完成 || !上 || 上.turn !== d.turn) 发事件('chat.error', { requestId: 一单.requestId, message: '这次对话没有完成。' })
      }
      if (!完成 || !上 || 上.turn !== d.turn) return
      const 文 = String(上.text || '').trim()
      if (!文) return
      // 工具调用是首选；如果模型只在自然回复里说了明确动作，
      // 这里把一次身体意图交给房间执行，避免“嘴上已经坐下，画面还站着”。
      if (!轮?.身体工具 && !轮?.direct && (单.length || 配置.转发主动开口)) void 跟随身体意图(文, sid)
      if (单.length) {
        // DSH can claim several followups in one turn; emit the reply once.
        发事件('chat.reply', { requestId: 单[0].requestId, requestIds: 单.map(x => x.requestId), text: 文, messageId: 上.messageId || '', turn: d.turn })
        最近说过的 = 文
        最近说话时 = Date.now()
        return
      }
      if (轮?.direct || 配置.转发主动开口) {
        发事件('proactive.speak', { text: 文, turn: d.turn })
        最近说过的 = 文
        最近说话时 = Date.now()
      }
    }
  }

  try {
    ctx.effect(() => {
      const 摘 = ctx.on('session/event', (session, event) => {
        try { 收到会话事件(session, event) } catch (error) { 记一笔('转发时出错：' + String((error && error.message) || error)) }
      })
      return () => { try { if (typeof 摘 === 'function') 摘() } catch (error) {} }
    })
  } catch (error) {
    记一笔('挂不上 session/event（不影响别的）：' + String((error && error.message) || error))
  }

  /* ── 睡着了就别理人 ── */
  // agent/pre-step 是 waterfall：返回 { kind:'reject' } 时 agent-loop 直接 turnEnds=blocked，
  // 连 step/start 都不会写，模型请求根本不会发。
  // 只拦她绑定的那间；别的会话一律放行。
  // 也只看「有新消息要回」的步骤 —— 她自己调完 sleep 之后那个收尾步骤不该把她叫醒。
  const 已处理消息 = new WeakMap();
  function 收到新用户消息(payload) {
    const message = Array.isArray(payload.messages) ? payload.messages.findLast(m=>m?.role==='user') : null;
    if (!message) return false;
    const key = message.id || message;
    if (已处理消息.get(payload.agent) === key) return false;
    已处理消息.set(payload.agent,key);
    return true;
  }
  async function 睡着该不该拦(payload) {
    const 目标 = 目标会话()
    const 这间 = 会话键(payload?.agent?.session?.id)
    if (!配置.开 || !目标 || 这间 !== 目标) return { 拦: false }
    const 有新消息 = 收到新用户消息(payload);
    const live = await 读现场状态();
    if (配置.睡着不理 === false) return { 拦: false }
    const 睡 = live ? {ok:true, 睡着:live.睡着, 可叫醒:live.可叫醒, until:live.activity?.until} : await 读房间睡眠()
    if (!睡.ok) return { 拦: false }
    if (!睡.睡着) return { 拦: false }

    // 保险丝：屋里该醒没醒（起床点已经过去 60 秒）—— 房间 tick 停了 / 数据坏了 / 我们改错了。
    // 优先于「不可叫醒」和「有没有新消息」：放行这一步，并顺手把她叫醒。
    if (Number.isFinite(睡.until) && Date.now() - 睡.until > 60000) {
      const 过了 = Math.round((Date.now() - 睡.until) / 1000)
      记一笔('屋里该醒没醒（起床点已过 ' + 过了 + ' 秒），自己放行并叫醒')
      // 叫醒本身也绝不能卡住这一步：1.5 秒超时，失败照样放行
      const 醒 = await 设置睡眠(false, 1500, 房间地址 || 默认房间地址)
      if (!醒.ok) 记一笔('保险丝想叫醒她但房间没答话（照常放行）：' + String(醒.说 || ''))
      return { 拦: false }
    }

    if (!有新消息) {
      // 她自己回合里的收尾步骤（比如刚调完 sleep）：
      // 可叫醒也别叫 —— 刚躺下就被自己叫起来像什么话；不可叫醒就连这一步也不叫她。
      if (睡.可叫醒 === false) {
        记一笔('她睡着了（可叫醒=否），收尾步骤也不叫她')
        return { 拦: true }
      }
      return { 拦: false }
    }
    if (睡.可叫醒 === false) {
      记一笔('她睡着了（可叫醒=否），这一步不叫她')
      return { 拦: true }
    }
    // 可叫醒：先把她叫起来，再放这一步正常回话
    const 醒 = await 设置睡眠(false, 1500, 房间地址 || 默认房间地址)
    if (!醒.ok || 醒.睡着) 记一笔('想叫醒她但房间没答话（这一步照常放行）：' + String(醒.说 || ''))
    else if (目标会话() === 目标) {
      自动叫醒 = {sessionId:目标, at:Date.now()};
      await 读现场状态();
      记一笔('收到新消息，已叫醒大肥鱼')
    }
    return { 拦: false }
  }

  try {
    ctx.effect(() => {
      const created = ctx.on('agent/created', ({agent})=>挂agent工具(agent));
      const disposed = ctx.on('agent/disposed', ({agent})=>{
        const sid=会话键(agent?.session?.id);
        if(上下文挂着.get(sid)?.agent===agent)卸agent工具(sid);
      });
      const 摘 = ctx.on('agent/pre-step', async (payload, next) => {
        if (payload?.agent) 挂agent工具(payload.agent);
        let 判 = { 拦: false }
        try { 判 = await 睡着该不该拦(payload) } catch (error) {
          记一笔('睡着拦截出错（放行）：' + String((error && error.message) || error))
        }
        return 判.拦 ? { kind: 'reject' } : next()
      })
      return () => { for (const off of [created,disposed,摘]) { try { if (typeof off==='function') off(); } catch {} } }
    })
  } catch (error) {
    记一笔('挂不上 agent/pre-step（睡着拦截不生效）：' + String((error && error.message) || error))
  }

  /* ───────────────────────── HTTP ───────────────────────── */

  function 回(res, 码, 体) {
    try {
      res.statusCode = 码
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(体))
    } catch (error) {}
  }

  function 回错(res, 码, 代号, 说) {
    回(res, 码, { ok: false, schema: SCHEMA, error: { code: 代号, message: 说 } })
  }

  async function 读体(req, 上限 = 256 * 1024) {
    const 块们 = []
    let 共 = 0
    for await (const 块 of req) {
      共 += 块.length
      if (共 > 上限) throw new Error('请求体太大')
      块们.push(块)
    }
    if (!块们.length) return {}
    const 文 = Buffer.concat(块们).toString('utf8')
    try { return JSON.parse(文) } catch (error) { throw new Error('请求体不是有效的 JSON') }
  }

  /** 只认 Bearer；用等长比较，别用 === 提前返回。 */
  function 令牌对得上(req) {
    const 头 = String(req.headers.authorization || '')
    const m = /^Bearer\s+(.+)$/i.exec(头)
    if (!m) return false
    const 给 = Buffer.from(m[1].trim())
    const 该 = Buffer.from(配置.令牌 || '')
    if (!该.length || 给.length !== 该.length) return false
    try { return timingSafeEqual(给, 该) } catch (error) { return false }
  }

  function 状态() {
    const 目标 = 目标会话()
    const 活 = Boolean(目标 && 找agent(目标))
    return {
      ok: true,
      schema: SCHEMA,
      version: 桥版本,
      epoch,
      sessionId: 目标,
      sessionAlive: 活,
      capabilities: ['chat', 'events', 'pet-state', 'life-event', 'routine-state', 'native-look', 'life-notices', 'session-diary', 'room-tools-v9'],
      latestSeq: seq,
      clients: 连接们.size,
      pet: 最近状态,
      petRevision: 状态版本,
      lastSaid: 最近说过的,
      lastSaidAt: 最近说话时,
      recentLife: 生活事件.slice(-10),
      log: 日志.slice(-20),
    }
  }

  function 路由(路径, handler) {
    return ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: 路径, handler }))
  }

  // 健康检查：房间那边连上先问这个
  路由(前缀 + '/health', async (req, res) => {
    if (!令牌对得上(req)) return 回错(res, 401, 'UNAUTHORIZED', '令牌不对')
    if (!配置.开) return 回错(res, 503, 'DISABLED', '桥接关着')
    const 目标 = 目标会话()
    回(res, 200, {
      ok: true,
      schema: SCHEMA,
      version: 桥版本,
      epoch,
      sessionId: 目标,
      sessionAlive: Boolean(目标 && 找agent(目标)),
      capabilities: ['chat', 'events', 'pet-state', 'life-event', 'routine-state', 'native-look', 'life-notices', 'session-diary', 'room-tools-v9'],
      latestSeq: seq,
    })
  })

  路由(前缀 + '/state', async (req, res) => {
    if (!令牌对得上(req)) return 回错(res, 401, 'UNAUTHORIZED', '令牌不对')
    回(res, 200, 状态())
  })

  // 事件流：SSE，房间那边一直挂着
  路由(前缀 + '/events', async (req, res) => {
    if (!令牌对得上(req)) return 回错(res, 401, 'UNAUTHORIZED', '令牌不对')
    if (!配置.开) return 回错(res, 503, 'DISABLED', '桥接关着')
    try {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write(': 鱼鱼窝已连上' + 换行 + 换行)
    } catch (error) {
      return
    }

    // 先打个招呼（不进历史，也不占 seq）
    写一帧(res, {
      schema: EVENT_SCHEMA, v: 1, id: 'evt_hello_' + randomUUID(), seq: 0, epoch,
      at: Date.now(), type: 'bridge.hello',
      data: {
        epoch,
        sessionId: 目标会话(),
        bridgeVersion: 桥版本,
        capabilities: ['chat', 'events', 'pet-state', 'life-event', 'routine-state', 'native-look', 'life-notices', 'session-diary', 'room-tools-v9'],
      },
    })

    // 断线重连：把 since 之后的补上；缺得太多就让它跳到最新
    let since = 0
    try {
      const 址 = new URL(req.url || '/', 'http://127.0.0.1')
      since = Math.max(0, Math.trunc(Number(址.searchParams.get('since')) || 0))
    } catch (error) {}
    if (since > 0) {
      const 头一条 = 历史.length ? 历史[0].seq : seq + 1
      if (since < 头一条 - 1) {
        写一帧(res, {
          schema: EVENT_SCHEMA, v: 1, id: 'evt_reset_' + randomUUID(), seq: seq, epoch,
          at: Date.now(), type: 'stream.reset', data: { latestSeq: seq },
        })
      }
      for (const 事件 of 历史) if (事件.seq > since) 写一帧(res, 事件)
    }

    连接们.add(res)
    记一笔('房间连上了（现在 ' + 连接们.size + ' 个）')
    const 收尾 = () => {
      if (!连接们.delete(res)) return
      记一笔('房间断开了（还剩 ' + 连接们.size + ' 个）')
    }
    req.on('close', 收尾)
    req.on('aborted', 收尾)
    res.on('close', 收尾)
  })

  // 历史事件（房间那边偶尔补一次）
  路由(前缀 + '/history', async (req, res) => {
    if (!令牌对得上(req)) return 回错(res, 401, 'UNAUTHORIZED', '令牌不对')
    let since = 0
    let limit = 100
    try {
      const 址 = new URL(req.url || '/', 'http://127.0.0.1')
      since = Math.max(0, Math.trunc(Number(址.searchParams.get('since')) || 0))
      limit = Math.max(1, Math.min(200, Math.trunc(Number(址.searchParams.get('limit')) || 100)))
    } catch (error) {}
    回(res, 200, { ok: true, schema: SCHEMA, events: 历史.filter((e) => e.seq > since).slice(-limit) })
  })

  // ⭐ 0.1.0：回忆簿 —— 把「鱼的记忆 / 日记 / 记忆卡」三样合起来给房间看。
  //   房间那边点「记住的事 / 日记 / 成长」就是按 kind 过滤：fact / daily / milestone。
  路由(前缀 + '/memories', async (req, res) => {
    if (!令牌对得上(req)) return 回错(res, 401, 'UNAUTHORIZED', '令牌不对')
    let q = ''
    let kind = ''
    let limit = 20
    let offset = 0
    let 会话 = ''
    try {
      const 址 = new URL(req.url || '/', 'http://127.0.0.1')
      q = String(址.searchParams.get('q') || '')
      kind = String(址.searchParams.get('kind') || '')
      limit = Math.trunc(Number(址.searchParams.get('limit')) || 20)
      offset = Math.trunc(Number(址.searchParams.get('offset')) || 0)
      会话 = String(址.searchParams.get('sessionId') || '').trim()
    } catch (error) {}
    const 目标 = 目标会话()
    if (!目标) return 回(res, 200, { ok: true, schema: SCHEMA, total: 0, items: [] })
    try {
      const 星汐 = 读星汐(家)
      const 全部 = 收回忆(家, 目标, 星汐, { 记忆路径: 配置.文本记忆路径, 日记路径: 配置.文本日记路径 })
      const 结果 = 筛回忆(全部, { q, kind, limit, offset })
      回(res, 200, { ok: true, schema: SCHEMA, sessionId: 目标, total: 结果.total, items: 结果.items })
    } catch (error) {
      回错(res, 500, 'MEMORY_FAILED', String((error && error.message) || error))
    }
  })

  // ⭐ 0.0.3：相伴第几天 —— 跟星汐联动，取她日记里最早那一篇当起点
  路由(前缀 + '/days', async (req, res) => {
    if (!令牌对得上(req)) return 回错(res, 401, 'UNAUTHORIZED', '令牌不对')
    let 会话 = ''
    try { 会话 = String(new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('sessionId') || '').trim() } catch (error) {}
    const 目标 = 目标会话()
    if (!目标) return 回(res, 200, { ok: true, schema: SCHEMA, since: '', days: 0 })
    try {
      const r = 收天数(家, 目标, 读星汐(家), { 日记路径: 配置.文本日记路径, 相伴起始日: 配置.相伴起始日 })
      回(res, 200, { ok: true, schema: SCHEMA, sessionId: 目标, since: r.since, days: r.days })
    } catch (error) {
      回错(res, 500, 'DAYS_FAILED', String((error && error.message) || error))
    }
  })

  // 房间打字 → 送进会话
  路由(前缀 + '/chat', async (req, res) => {
    if (req.method !== 'POST') return 回错(res, 405, 'METHOD', '要用 POST')
    if (!令牌对得上(req)) return 回错(res, 401, 'UNAUTHORIZED', '令牌不对')
    if (!配置.开) return 回错(res, 503, 'DISABLED', '桥接关着')

    let 体
    try { 体 = await 读体(req) } catch (error) { return 回错(res, 400, 'BAD_BODY', String((error && error.message) || error)) }
    const 文 = String((体 && 体.text) || '').trim()
    if (!文) return 回错(res, 400, 'BAD_MESSAGE', '要说的话是空的')
    if (文.length > 6000) return 回错(res, 400, 'BAD_MESSAGE', '一次最多 6000 个字')
    // 房间每次说话都会把「现在几点、什么天」一起带上
    收下环境(体 && 体.pet)

    const 目标 = 目标会话()
    if (!目标) return 回错(res, 409, 'NO_SESSION', '还没有绑定会话：在 DSH 里打开「鱼鱼窝」那个插件页选一间')
    const agent = 找agent(目标)
    if (!agent || typeof agent.followup !== 'function') {
      return 回错(res, 409, 'SESSION_SLEEPING', '那间会话现在没开着，先在 DSH 里打开它')
    }

    const requestId = String((体 && 体.requestId) || '').trim() || ('req-' + randomUUID())
    const 队 = 待回.get(目标) || new Map()
    for (const [id, x] of 队) if (Date.now() - x.at > 5 * 60000) 队.delete(id)
    if (队.size >= 3) return 回错(res, 429, 'BRIDGE_BUSY', '还有话没回完，等一下')
    const id = randomUUID()
    队.set(id, { id, requestId, at: Date.now() })
    待回.set(目标, 队)

    try {
      // ⚠ 必须 await：不接住的话，reject 会变成未处理异常，把整个宿主带走
      await agent.followup({
        id,
        role: 'user',
        content: [{ type: 'text', text: 文 }],
        source: { kind: 'fish-home' },
      })
    } catch (error) {
      队.delete(id)
      return 回错(res, 502, 'SEND_FAILED', '送不进去：' + String((error && error.message) || error))
    }
    try {
      const 会话服务 = ctx.sessions || 拿服务('sessions')
      if (会话服务 && typeof 会话服务.flush === 'function') await 会话服务.flush(agent.session)
    } catch (error) {}
    记一笔('房间说了一句，送进 ' + 短id(目标))

    return 回(res, 202, { ok: true, schema: SCHEMA, accepted: true, requestId, sessionId: 目标 })
  })

  // 房间的生活数据（饿不饿、在干嘛）
  路由(前缀 + '/pet/state', async (req, res) => {
    if (req.method !== 'POST') return 回错(res, 405, 'METHOD', '要用 POST')
    if (!令牌对得上(req)) return 回错(res, 401, 'UNAUTHORIZED', '令牌不对')
    let 体
    try { 体 = await 读体(req) } catch (error) { return 回错(res, 400, 'BAD_BODY', String((error && error.message) || error)) }
    if (!体 || 体.schema !== PET_STATE_SCHEMA) return 回错(res, 400, 'BAD_SCHEMA', '这份数据的版本不对')
    const 旧天气 = String(最近状态?.snapshot?.weather || '')
    收下环境(体.snapshot)
    if(typeof 体.room?.url==='string'){
      try{
        const 地址=new URL(体.room.url);
        // The bridge speaks to the local room only. Never use a snapshot as an external request destination.
        if(地址.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(地址.hostname)&&!地址.username&&!地址.password&&地址.pathname==='/'&&!地址.search&&!地址.hash)房间地址=地址.origin;
      }catch{}
    }
    const reportedAction = 体.snapshot?.activity?.action;
    if (typeof reportedAction==='string' && 睡眠缓存.值?.ok && 睡眠缓存.值.睡着!==(reportedAction==='sleep')) {
      睡眠缓存 = {at:0,值:null};
    }
    const 旧状态 = 最近状态
    最近状态 = {
      revision: ++状态版本,
      at: Number(体.at) || Date.now(),
      snapshot: 体.snapshot && typeof 体.snapshot === 'object' ? 体.snapshot : null,
      recent: Array.isArray(体.recent) ? 体.recent.slice(-5) : [],
      recentChat: Array.isArray(体.recentChat) ? 体.recentChat.slice(-6) : [],
    }
    推送状态变化(旧状态, 最近状态, 旧天气)
    return 回(res, 200, { ok: true, revision: 最近状态.revision })
  })

  // 房间里发生的事（刷完 B 站回来了、挪到电脑桌前）
  路由(前缀 + '/pet/life-event', async (req, res) => {
    if (req.method !== 'POST') return 回错(res, 405, 'METHOD', '要用 POST')
    if (!令牌对得上(req)) return 回错(res, 401, 'UNAUTHORIZED', '令牌不对')
    let 体
    try { 体 = await 读体(req) } catch (error) { return 回错(res, 400, 'BAD_BODY', String((error && error.message) || error)) }
    if (!体 || 体.schema !== LIFE_EVENT_SCHEMA) return 回错(res, 400, 'BAD_SCHEMA', '这份数据的版本不对')
    const targetSession = 目标会话()
    if (体.sessionId && 会话键(体.sessionId) !== targetSession) return 回(res, 202, {ok:true,delivered:false})
    const id = String(体.id || '')
    if (id && 生活事件.some((x) => x.id === id && x.sessionId === targetSession)) return 回(res, 202, { ok: true, duplicate: true, delivered: 体.kind === 'touch' })
    if (互动送达中.has(id)) return 回(res, 202, { ok: true, duplicate: true })
    const 事件 = {
      id, sessionId: targetSession, at: Number(体.at) || Date.now(), kind: String(体.kind || ''), title: String(体.title || '').slice(0, 200),
      text: String(体.text || '').slice(0, 4000), room: String(体.room || ''), action: String(体.action || ''),
    }
    if (事件.kind === 'touch') {
      if (!Object.hasOwn(CARE_TEXT, 事件.action)) return 回错(res, 400, 'BAD_ACTION', '不认识这种互动')
      if (Math.abs(Date.now() - 事件.at) >= CARE_TTL_MS) return 回(res, 202, { ok: true, expired: true })
      if (!配置.开) return 回错(res, 503, 'DISABLED', '桥接关着')
      const sid = 目标会话()
      if (!sid) return 回错(res, 409, 'NO_SESSION', '还没选会话')
      const agent = 找agent(sid)
      if (typeof agent?.followup !== 'function') return 回错(res, 409, 'SESSION_SLEEPING', '绑定的会话现在没开着')
      if (id) 互动送达中.add(id)
      try {
        await agent.followup({
          id: randomUUID(), role: 'user', source: { kind: 'fish-home-touch' },
          content: [{ type: 'text', text: `【鱼鱼窝互动】${互动者名字(体.actorName)}${CARE_TEXT[事件.action]}` }],
        })
      } catch (error) { return 回错(res, 502, 'SEND_FAILED', '互动没送进会话') }
      finally { 互动送达中.delete(id) }
    }
    const directLife = 事件.kind==='milestone' || 事件.kind==='wallet' || (事件.kind==='scene' && ['pickup','swing'].includes(体.reaction))
    const maxAge = 事件.kind==='scene' ? SCENE_TTL_MS : 10*60000
    if (directLife && 配置.主动生活通知[事件.kind] && 事件.text && Date.now()-事件.at<maxAge && 配置.开 && targetSession) {
      const agent=找agent(targetSession)
      if(typeof agent?.followup==='function'){
        if(id)互动送达中.add(id)
        try {
          await agent.followup({id:randomUUID(),role:'user',source:{kind:'fish-home-life'},
            content:[{type:'text',text:'【鱼鱼窝】'+事件.text.slice(0,300)}]})
          事件.notified = true
        } catch (error) {
          return 回错(res,502,'SEND_FAILED','生活事件没送进会话')
        } finally {互动送达中.delete(id)}
      }
    }
    if (事件.kind === 'scene' && 配置.开 && targetSession && Math.abs(Date.now() - 事件.at) < SCENE_TTL_MS) {
      // A scene already delivered as a message does not need a second copy in context or status.
      if (事件.at >= (最近场景?.at||0)) 最近场景 = 事件.notified ? null : { sid: targetSession, at: 事件.at, text: 事件.text.slice(0, 240) }
    }
    生活事件.push(事件)
    if (生活事件.length > 200) 生活事件.shift()
    return 回(res, 202, { ok: true, delivered: 事件.kind === 'touch' })
  })

  /* ───────────────────────── 设置页用的接口 ───────────────────────── */
  // 浏览器那一半（lib/client.js）调这些；不带走牌，靠「同源」拦。
  // ⚠ 令牌不给页面 —— 页面能看、能改设置，但拿不到那个能直接驱动会话的口令。

  const 管理前缀 = '/dsh-fish-home'

  function 同源(req) {
    const 源 = String(req.headers.origin || '')
    if (!源) return true                      // 同页 fetch 有时不带 Origin
    try {
      const u = new URL(源)
      return u.host === String(req.headers.host || '')
    } catch (error) { return false }
  }

  /* ── 会话清单 ──
     ⚠ 这段是**照抄「通到 QQ」里已经跑了几个月的 会话清单()**，一个字没敢自己发明：
       ① 活着的会话（sessions 服务，list() 和快照两种形状都认）
       ② 盘上的（storages/session_projcache/sessions/*.json —— 关掉的会话也在）
       ③ 最后兜一层：现在有 agent 的
     标题要拿**整个会话对象**去问 sessionTitle.get(s)，返回 { title } —— 递 id 进去永远是空的。
     归档的、子代理的都不列。 */
  /** 盘上真有日志的会话（照星汐那套：`sessions/<工作区>/<会话>/session.v4.jsonl.zstd` 才算数）。 */
  const 有日志的会话 = () => {
    const 出 = new Set()
    const 会话根 = path.join(家, 'sessions')
    let 顶们 = []
    try { 顶们 = fs.readdirSync(会话根, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch (error) { return 出 }
    for (const d of 顶们) {
      const 名 = String(d.name || '')
      if (!名) continue
      if (!名.startsWith('--')) {
        if (fs.existsSync(path.join(会话根, 名, 'session.v4.jsonl.zstd'))) 出.add(名)
        continue
      }
      let 子们 = []
      try { 子们 = fs.readdirSync(path.join(会话根, 名), { withFileTypes: true }).filter((x) => x.isDirectory()) } catch (error) { continue }
      for (const s of 子们) {
        const 子名 = String(s.name || '')
        if (fs.existsSync(path.join(会话根, 名, 子名, 'session.v4.jsonl.zstd'))) 出.add(子名)
      }
    }
    return 出
  }

  const 扫盘会话 = () => {
    const 出 = []
    const 有日志 = 有日志的会话()
    try {
      const 会话目录 = path.join(家, 'storages', 'session_projcache', 'sessions')
      for (const 名 of fs.readdirSync(会话目录)) {
        if (!名.endsWith('.json')) continue
        const id = 名.slice(0, -5)
        let 记 = null
        try { 记 = JSON.parse(fs.readFileSync(path.join(会话目录, 名), 'utf8')) } catch (error) { continue }
        const rows = (记 && 记.record && 记.record.rows) || {}
        // 子代理的不列（不然设置页会被几十个 subagent 淹掉）
        const 子 = rows.subagent && rows.subagent.val && rows.subagent.val.identity
        if (子) continue
        // 空会话不列（星汐那套：sessionListMetadata.blank）
        const 元 = rows.sessionListMetadata && rows.sessionListMetadata.val
        if (元 && 元.blank) continue
        // 盘上没有真日志的不列（跟侧栏对齐）
        if (!有日志.has(id)) continue
        let 标题 = ''
        if (rows.title && typeof rows.title.val === 'string') 标题 = rows.title.val
        出.push({ id, 标题 })
      }
    } catch (error) {}
    return 出
  }

  function 会话清单() {
    const 出 = []
    const 已有 = new Set()
    // 会话 id 有两种写法（`session-x` / 裸 `x`），比较前统一去掉前缀
    const 裸id = (x) => String(x || '').replace(/^session-/, '')
    // ⭐ 只列「DSH 侧栏上真的在」的会话。
    //   以前把盘上 projcache 里的全列出来 —— 那是 197 个，里面一大半是早就归档 / 不在侧栏的旧会话，
    //   下拉框一拉一大串，跟她看到的侧栏完全对不上。
    //   侧栏 = 属于某个工作区的会话（workspace.json 里 tables.workspaces[].sessionIds）。
    const 在册 = new Set()
    let 文件 = null
    try {
      文件 = JSON.parse(fs.readFileSync(path.join(家, 'storages', 'workspace.json'), 'utf8'))
    } catch (error) {}
    try {
      const 表 = (文件 && 文件.tables && 文件.tables.workspaces) || {}
      for (const k of Object.keys(表)) {
        for (const sid of (表[k] && 表[k].sessionIds) || []) {
          在册.add(String(sid)); 在册.add(裸id(sid))
        }
      }
    } catch (error) {}
    const 在册的 = (id) => 在册.size === 0 || 在册.has(String(id)) || 在册.has(裸id(id))
    // 归档名单：服务优先（实时、准），读不到再翻存储文件
    const 归档 = new Set()
    try {
      const 登记 = ctx.workspaceRegistry || 拿服务('workspaceRegistry')
      const ids = 登记 && 登记.archivedSessionIds
      if (Array.isArray(ids)) {
        for (const x of ids) { 归档.add(String(x)); 归档.add(裸id(x)) }
      }
    } catch (error) {}
    if (!归档.size) {
      for (const x of ((文件 && 文件.global && 文件.global.archivedSessionIds) || [])) {
        归档.add(String(x)); 归档.add(裸id(x))
      }
    }
    const 是归档的 = (id) => 归档.has(String(id)) || 归档.has(裸id(id))
    const 加 = (id, 标题, 强制 = false) => {
      const 净 = String(id || '')
      if (!净 || 已有.has(净) || 是归档的(净)) return
      // 盘上扫出来的，必须是「侧栏里在的」才列；内存里活着的那个直接算（它一定在侧栏）
      if (!强制 && !在册的(净)) return
      已有.add(净)
      出.push({ id: 净, 标题: 标题 ? String(标题) : '' })
    }

    const 标题服务 = 拿服务('sessionTitle')

    let 活们 = []
    try {
      const 会话服务 = ctx.sessions || 拿服务('sessions')
      if (会话服务) {
        if (typeof 会话服务.list === 'function') {
          活们 = 会话服务.list() || []
        } else if (会话服务.list && typeof 会话服务.list.getSnapshot === 'function') {
          const 快 = 会话服务.list.getSnapshot() || {}
          活们 = Array.isArray(快.items) ? 快.items : (快.byId ? Object.values(快.byId) : [])
        }
        if (!活们.length && typeof 会话服务.getSnapshot === 'function') {
          const 快 = 会话服务.getSnapshot() || {}
          活们 = Array.isArray(快.items) ? 快.items : (快.byId ? Object.values(快.byId) : [])
        }
      }
    } catch (error) {}
    for (const s of 活们) {
      if (!s) continue
      const id = s.id || s.sessionId
      if (!id) continue
      try { if (s.header && s.header.origin === 'subagent') continue } catch (error) {}
      let 标题 = ''
      try {
        const 快照 = 标题服务 && typeof 标题服务.get === 'function' ? 标题服务.get(s) : undefined
        标题 = 快照 && 快照.title ? String(快照.title) : ''
      } catch (error) {}
      加(id, 标题, true)
    }

    for (const x of 扫盘会话()) 加(x.id, x.标题)

    try {
      const 有代理 = 代理服务 && typeof 代理服务.list === 'function' ? 代理服务.list() : []
      for (const a of 有代理 || []) 加((a && a.session && a.session.id) || (a && a.sessionId), '', true)
    } catch (error) {}

    return 出
  }

  function 管理状态(现场) {
    const 目标 = 目标会话()
    return {
      ok: true,
      version: 桥版本,
      开: 配置.开,
      开机自启: 配置.开机自启,
      睡着不理: 配置.睡着不理,
      每轮注入现场: 配置.每轮注入现场,
      状态变化通知: 配置.状态变化通知,
      主动生活通知: 配置.主动生活通知,
      文本记忆路径: 配置.文本记忆路径,
      文本日记路径: 配置.文本日记路径,
      相伴起始日: 配置.相伴起始日,
      会话: 目标,
      会话活着: Boolean(目标 && 找agent(目标)),
      转发主动开口: 配置.转发主动开口,
      心跳秒: 配置.心跳秒,
      画图地址: 配置.画图地址,
      画图密钥: 配置.画图密钥,
      画图模型: 配置.画图模型,
      画图尺寸: 配置.画图尺寸,
      地址: (() => { try { return 'http://127.0.0.1:' + Number(ctx.webServer.port) + 前缀 } catch (error) { return '' } })(),
      已连: 连接们.size,
      房间环境,
      会话工具: [...(上下文挂着.get(目标会话())?.off们.keys()||[])].filter(name=>name.startsWith('fish_home')||name==='paint'),
      房间那句: 房间那句(现场),
      最近说过: 最近说过的,
      最近说话时: 最近说话时,
      生活事件: 生活事件.slice(-8),
      日志: 日志.slice(-15),
      名单: 会话清单(),
    }
  }

  路由(管理前缀 + '/state', async (req, res) => {
    if (!同源(req)) return 回错(res, 403, 'CROSS_ORIGIN', '只给本页用')
    return 回(res, 200, 管理状态(await 读现场状态()))
  })

  /* ── 检查更新：跟其它几个插件同一份实现（lib/selfupdate.mjs）──
   * 仓库地址从 package.json 的 repository 读，多源取最大版本，结果缓存 6 小时，
   * 查不到如实说「查不到」，不糊成「已是最新」。
   */
  const 自查更新 = createSelfUpdate({ packageRoot: fileURLToPath(new URL('..', import.meta.url)), diag: 记一笔 })
  // 「查更新」和「一键更新」这两个路由由 selfupdate 自己注册 —— 跟其它五个插件是同一份实现。
  // 准入用同源检查：本机别的网页不该能触发安装。
  自查更新.register(ctx, 管理前缀, (req) => (同源(req) ? null : { 码: 403, 说: '只给本页用' }))

  // 房间本体：插件不带它（三百多兆），所以设置页得告诉人「装没装、去哪下」。
  // 找的路径顺序跟启动时完全一致，不然会出现「界面说装了、启动却说找不到」。
  function 仓库发布页() {
    try {
      const 包 = JSON.parse(fs.readFileSync(path.join(fileURLToPath(new URL('..', import.meta.url)), 'package.json'), 'utf8'))
      const 址 = String((包 && 包.repository && 包.repository.url) || '').replace(/^git\+/, '').replace(/\.git$/, '')
      return 址 ? 址 + '/releases/latest' : ''
    } catch (e) { return '' }
  }
  路由(管理前缀 + '/room-body', async (req, res) => {
    if (!同源(req)) return 回错(res, 403, 'CROSS_ORIGIN', '只给本页用')
    // 版本号从房间自己的 package.json 读 —— 它是另一份程序，版本跟插件不必一致
    let 版本 = ''
    try {
      const 包 = JSON.parse(fs.readFileSync(path.join(房间目录, 'package.json'), 'utf8'))
      版本 = String((包 && 包.version) || '')
    } catch (e) {}
    return 回(res, 200, {
      ok: true,
      已装: fs.existsSync(path.join(房间目录, 'app-server.js')),
      目录: 房间目录,
      版本,
      下载页: 仓库发布页(),
    })
  })
  路由(管理前缀 + '/icon', async (req, res) => {
    if (!同源(req)) return 回错(res, 403, 'CROSS_ORIGIN', '只给本页用')
    const 图 = typeof 鱼鱼窝图标 === 'string' ? 鱼鱼窝图标 : ''
    return 回(res, 200, { ok: 图 !== '', 图标: 图 })
  })

  // 设置区那两个开关：读房间 /api/state，写房间 /api/settings。
  // 写不进去（房间没开）就只记本地，等房间起来由 /room/status 或启动流程补推。
  路由(管理前缀 + '/room-settings', async (req, res) => {
    if (!同源(req)) return 回错(res, 403, 'CROSS_ORIGIN', '只给本页用')

    if (req.method === 'GET') {
      const 房 = await 读房间设置()
      const 有房 = typeof 房.学菜 === 'boolean' || typeof 房.画图 === 'boolean'
      if (有房) {
        const 配置 = 读配置()
        const 待 = new Set(配置.待推设置)
        // 待推的键以本地那份为准：它才是她刚点的值，房间那边还是旧的
        const 取 = (键) => (待.has(键)
          ? 配置[键] !== false
          : (typeof 房[键] === 'boolean' ? 房[键] : 配置[键] !== false))
        对齐本地设置(房)
        补推房间设置(记一笔, true).catch(() => {})
        return 回(res, 200, {
          ok: true,
          来源: '房间',
          学菜: 取('学菜'),
          画图: 取('画图'),
        })
      }
      const 配置 = 读配置()
      return 回(res, 200, { ok: true, 来源: '本地', 学菜: 配置.学菜 !== false, 画图: 配置.画图 !== false })
    }

    if (req.method !== 'POST') return 回错(res, 405, 'METHOD', '要用 GET 或 POST')
    let 体
    try { 体 = await 读体(req) } catch (error) { return 回错(res, 400, 'BAD_BODY', String((error && error.message) || error)) }
    const 补丁 = {}
    for (const 键 of ['学菜', '画图']) {
      if (体 && typeof 体[键] === 'boolean') 补丁[键] = 体[键]
    }
    if (!Object.keys(补丁).length) return 回错(res, 400, 'BAD_BODY', '没有要改的开关')

    const 送达 = await 写房间设置(补丁)
    const 待 = new Set(读配置().待推设置)
    for (const 键 of Object.keys(补丁)) {
      if (送达) 待.delete(键)
      else 待.add(键)
    }
    写配置({ ...补丁, 待推设置: [...待] })
    const 新 = 读配置()
    记一笔('房间开关改了：' + Object.keys(补丁).map((键) => 键 + '=' + String(补丁[键])).join('、') + (送达 ? '' : '（房间没开，先记着）'))
    return 回(res, 200, {
      ok: true, 已送达: 送达, 来源: 送达 ? '房间' : '本地',
      学菜: 新.学菜 !== false, 画图: 新.画图 !== false,
    })
  })

  // 设置区「睡觉」卡：看状态 + 手动叫醒。
  // 这道门是给以后出 BUG 时留的 —— 人被锁在「叫不醒」里的时候，至少这里能拉一把。
  路由(管理前缀 + '/sleep', async (req, res) => {
    if (!同源(req)) return 回错(res, 403, 'CROSS_ORIGIN', '只给本页用')
    if (req.method !== 'GET') return 回错(res, 405, 'METHOD', '要用 GET')
    const 睡 = await 读房间睡眠()
    const 配置 = 读配置()
    return 回(res, 200, {
      ok: true,
      来源: 睡.ok ? '房间' : '本地',
      房间在: 睡.ok,
      睡着: 睡.ok ? 睡.睡着 : null,
      活动: 睡.ok ? 睡.活动 : '',
      睡着不理: 配置.睡着不理 !== false,
    })
  })

  路由(管理前缀 + '/sleep/wake', async (req, res) => {
    if (req.method !== 'POST') return 回错(res, 405, 'METHOD', '要用 POST')
    if (!同源(req)) return 回错(res, 403, 'CROSS_ORIGIN', '只给本页用')
    // 叫醒本身绝不能成为新的卡死点：1.5 秒超时，失败也把话好好说回去
    const 果 = await 设置睡眠(false, 1500)
    if (!果.ok) return 回(res, 200, { ok: false, 送达: false, 说: '房间没开或没答话，没叫起来' })
    return 回(res, 200, { ok: true, 送达: true, 睡着: 果.睡着, 说: '叫起来了' })
  })

  路由(管理前缀 + '/save', async (req, res) => {
    if (req.method !== 'POST') return 回错(res, 405, 'METHOD', '要用 POST')
    if (!同源(req)) return 回错(res, 403, 'CROSS_ORIGIN', '只给本页用')
    let 体
    try { 体 = await 读体(req) } catch (error) { return 回错(res, 400, 'BAD_BODY', String((error && error.message) || error)) }
    const 补丁 = {}
    if (体.开 !== undefined) 补丁.开 = Boolean(体.开)
    if (体.开机自启 !== undefined) 补丁.开机自启 = Boolean(体.开机自启)
    if (体.睡着不理 !== undefined) 补丁.睡着不理 = Boolean(体.睡着不理)
    if (体.每轮注入现场 !== undefined) 补丁.每轮注入现场 = Boolean(体.每轮注入现场)
    if (体.状态变化通知 !== undefined) 补丁.状态变化通知 = Boolean(体.状态变化通知)
    if (体.主动生活通知 && typeof 体.主动生活通知==='object') 补丁.主动生活通知=Object.fromEntries(
      ['milestone','wallet','scene'].map(key=>[key,typeof 体.主动生活通知[key]==='boolean'?体.主动生活通知[key]:配置.主动生活通知[key]]))
    for (const 键 of ['文本记忆路径', '文本日记路径', '相伴起始日']) {
      if (体[键] !== undefined)补丁[键] = String(体[键] || '').trim()
    }
    if (体.会话 !== undefined) 补丁.会话 = String(体.会话 || '').trim()
    if (体.转发主动开口 !== undefined) 补丁.转发主动开口 = Boolean(体.转发主动开口)
    if (体.心跳秒 !== undefined) {
      const 秒 = Number(体.心跳秒)
      补丁.心跳秒 = Number.isFinite(秒) ? Math.max(5, Math.min(120, Math.trunc(秒))) : 20
    }
    for (const 键 of ['画图地址', '画图密钥', '画图模型', '画图尺寸']) {
      if (体[键] !== undefined) 补丁[键] = String(体[键] || '').trim()
    }
    const 新 = 写配置(补丁)
    if (!新) return 回错(res, 500, 'WRITE_FAILED', '配置写不进去：' + 配置路)
    配置 = 新
    挂agent工具();
    写发现文件()
    if (体.会话 !== undefined) {
      最近场景 = null
      发事件('bridge.notice', { code: 'BINDING_CHANGED', sessionId: 目标会话() })
    }
    记一笔('设置改了：' + Object.keys(补丁).join('、'))
    return 回(res, 200, 管理状态())
  })

  // 试一句：跟房间打字走同一条路（真的送进会话，回话会从事件流回来）
  路由(管理前缀 + '/try', async (req, res) => {
    if (req.method !== 'POST') return 回错(res, 405, 'METHOD', '要用 POST')
    if (!同源(req)) return 回错(res, 403, 'CROSS_ORIGIN', '只给本页用')
    let 体
    try { 体 = await 读体(req) } catch (error) { return 回错(res, 400, 'BAD_BODY', String((error && error.message) || error)) }
    const 目标 = 目标会话()
    const agent = 目标 ? 找agent(目标) : undefined
    if (!目标) return 回错(res, 409, 'NO_SESSION', '还没选会话')
    if (!agent || typeof agent.followup !== 'function') return 回错(res, 409, 'SESSION_SLEEPING', '那间会话现在没开着')
    const 文 = typeof 体?.话 === 'string' ? 体.话.trim().slice(0, 500) : ''
    if (!文) return 回错(res, 400, 'EMPTY_TEXT', '请先填写试发消息')
    try {
      await agent.followup({
        id: randomUUID(), role: 'user', content: [{ type: 'text', text: 文 }], source: { kind: 'fish-home' },
      })
    } catch (error) {
      return 回错(res, 502, 'SEND_FAILED', '送不进去：' + String((error && error.message) || error))
    }
    记一笔('设置页试了一句：' + 文.slice(0, 20))
    return 回(res, 200, { ok: true, 说: '送进去了，回话会从事件流回到房间。' })
  })

  /* ───────────────────────── 内存看门狗 ───────────────────────── */
  // ⚠ 2026-11-12：宿主有一次起来 40 秒后堆爆到 4GB。查不到是谁，
  //   那就留一份证据：每 2 秒把堆占用和几个计数写进 ~/.dsh/fish-room-mem.log。
  //   正常时它一动不动；真出事的时候，最后几行能看出是「事件太多」还是「请求太多」。
  let 看门狗 = null
  try {
    const 记忆日志 = path.join(家, 'fish-room-mem.log')
    // ⚠ 这日志每 2 秒追加一行、没有闸门，开一天能长到二三十兆。
    //   超过 5MB 就砍掉前面一半只留最近的 —— 真出事时，有用的永远是最后几行。
    const 日志上限 = 5 * 1024 * 1024
    const 砍一刀 = () => {
      try {
        if (fs.statSync(记忆日志).size <= 日志上限) return
        const 老 = fs.readFileSync(记忆日志, 'utf8')
        fs.writeFileSync(记忆日志, 老.slice(Math.floor(老.length / 2)), 'utf8')
      } catch (error) {}
    }
    看门狗 = setInterval(() => {
      try {
        const m = process.memoryUsage()
        const 行 = new Date().toISOString() + '  heap ' + Math.round(m.heapUsed / 1048576) + 'MB  rss '
          + Math.round(m.rss / 1048576) + 'MB  事件 ' + 事件计数 + '  连接 ' + 连接们.size + '  历史 ' + 历史.length + '\n'
        fs.appendFileSync(记忆日志, 行, 'utf8')
        砍一刀()
      } catch (error) {}
    }, 2000)
    看门狗.unref?.()
  } catch (error) {}

  // 房间里的画架：通知绑定会话玩家点击了哪个互动。
  路由(前缀 + '/paint', async (req, res) => {
    if (req.method !== 'POST') return 回错(res, 405, 'METHOD', '要用 POST')
    if (!令牌对得上(req)) return 回错(res, 401, 'UNAUTHORIZED', '令牌不对')
    if (!配置.开) return 回错(res, 503, 'DISABLED', '桥接关着')
    const 目标 = 目标会话()
    if (!目标) return 回错(res, 409, 'NO_SESSION', '还没选会话')
    const agent = 找agent(目标)
    if (!agent || typeof agent.followup !== 'function') return 回错(res, 409, 'SESSION_SLEEPING', '那间会话现在没开着')
    let 体
    try { 体 = await 读体(req) } catch (error) { return 回错(res, 400, 'BAD_BODY', '看不懂这次画画请求') }
    const id = String(体?.requestId || '').slice(0, 100)
    if (id && 已请求画画.has(id)) return 回(res, 202, { ok: true, duplicate: true })
    if (id) {
      已请求画画.set(id, true)
      if (已请求画画.size > 200) 已请求画画.delete(已请求画画.keys().next().value)
    }
    try {
      await agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: `【鱼鱼窝互动】${互动者名字(体?.actorName)}刚在画架上点了「画画」。` }],
        source: { kind: 'fish-home-paint' },
      })
    } catch (error) {
      已请求画画.delete(id)
      return 回错(res, 502, 'SEND_FAILED', '送不进去：' + String((error && error.message) || error))
    }
    记一笔('有人去画架前了，跟它说了')
    return 回(res, 200, { ok: true, 说: '跟她说了' })
  })

  async function 处理生图(req, res) {
    if (req.method !== 'POST') return 回错(res, 405, 'METHOD', '要用 POST')
    let 体
    try { 体 = await 读体(req) } catch (error) { return 回错(res, 400, 'BAD_BODY', String((error && error.message) || error)) }
    const 结果 = await 画一张(体 && 体.prompt, 体 && 体.reference)
    if (!结果.ok) return 回错(res, 结果.码 || 502, 结果.代号 || 'PAINT_FAILED', 结果.说)
    return 回(res, 200, { ok: true, mime: 结果.mime, b64: 结果.b64, 模型: 配置.画图模型 })
  }

  路由(前缀 + '/paint/draw', async (req, res) => {
    if (!令牌对得上(req)) return 回错(res, 401, 'UNAUTHORIZED', '令牌不对')
    const 设置 = await 读房间设置(5000, 房间地址 || 默认房间地址)
    if ((设置.画图 ?? 配置.画图) === false) return 回错(res, 409, 'PAINT_DISABLED', '鱼鱼窝的画图开关关着。')
    return 处理生图(req, res)
  })
  路由(管理前缀 + '/paint', async (req, res) => {
    if (req.method !== 'POST') return 回错(res, 405, 'METHOD', '要用 POST')
    if (!同源(req)) return 回错(res, 403, 'CROSS_ORIGIN', '只给本页用')
    return 处理生图(req, res)
  })

  /** 调一次生图接口，拿回 base64。地址 / 密钥 / 模型都从设置里来。 */
  async function 画一张(prompt, reference = '') {
    const 地址 = String(配置.画图地址 || '').trim().replace(/\/+$/, '')
    const 密钥 = String(配置.画图密钥 || '').trim()
    const 模型 = String(配置.画图模型 || '').trim()
    if (!地址 || !密钥 || !模型) {
      return { ok: false, 码: 400, 代号: 'PAINT_NOT_CONFIGURED', 说: '画图还没配：地址、密钥、模型三样都要填' }
    }
    const 话 = typeof prompt === 'string' ? prompt.trim().slice(0, 1000) : ''
    if (!话) return { ok: false, 码: 400, 代号: 'EMPTY_PROMPT', 说: '缺少图像内容' }
    // 地址只写到域名（https://api.xxx）的时候，补一个 /v1 —— 不然会打到 /images/generations 上
    let 基 = 地址
    try {
      const u = new URL(基)
      if (!u.pathname || u.pathname === '/') 基 = 基 + '/v1'
    } catch (error) {}
    const 要的 = {
      model: 模型,
      prompt: 话,
      n: 1,
      size: String(配置.画图尺寸 || '1024x1024'),
      response_format: 'b64_json',
    }
    const 控 = new AbortController()
    const 定 = setTimeout(() => 控.abort(), 120000)
    try {
      const 参考 = typeof reference === 'string' ? reference.trim().slice(0, 4000) : ''
      let r
      if (参考) {
        let imageData, imageType = 'image/png'
        if (/^data:image\//i.test(参考)) {
          const m = /^data:(image\/[^;]+);base64,(.+)$/i.exec(参考)
          if (!m) return { ok: false, 码: 400, 代号: 'BAD_REFERENCE', 说: '参考图 data URL 格式不对。' }
          imageType = m[1]; imageData = Buffer.from(m[2], 'base64')
        } else if (/^https?:\/\//i.test(参考)) {
          const image = await fetch(参考, { redirect: 'error', signal: 控.signal })
          if (!image.ok) return { ok: false, 码: 400, 代号: 'BAD_REFERENCE', 说: '参考图地址读不到。' }
          imageType = image.headers.get('content-type')?.split(';')[0] || imageType
          imageData = Buffer.from(await image.arrayBuffer())
        } else {
          imageData = await fs.promises.readFile(path.resolve(参考))
        }
        const form = new FormData()
        form.append('model', 模型); form.append('prompt', 话); form.append('n', '1'); form.append('size', String(配置.画图尺寸 || '1024x1024')); form.append('response_format', 'b64_json')
        form.append('image', new Blob([imageData], { type: imageType }), 'reference.png')
        r = await fetch(基 + '/images/edits', { method: 'POST', headers: { authorization: 'Bearer ' + 密钥 }, body: form, signal: 控.signal })
      } else {
        r = await fetch(基 + '/images/generations', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + 密钥 },
          body: JSON.stringify(要的),
          signal: 控.signal,
        })
      }
      const 文 = await r.text()
      if (!r.ok) {
        记一笔('生图失败 HTTP ' + r.status)
        return { ok: false, 码: 502, 代号: 'PAINT_HTTP_' + r.status, 说: ('接口回了 ' + r.status + '：' + 文).slice(0, 300) }
      }
      let j = null
      try { j = JSON.parse(文) } catch (error) {}
      const 条 = j && Array.isArray(j.data) ? j.data[0] : null
      let b64 = 条 && typeof 条.b64_json === 'string' ? 条.b64_json : ''
      const 链 = 条 && typeof 条.url === 'string' ? 条.url : ''
      if (!b64 && 链) {
        // 有的接口只给链接，那就自己去取回来
        const 图 = await fetch(链, { signal: 控.signal })
        if (!图.ok) return { ok: false, 码: 502, 代号: 'PAINT_FETCH', 说: '画好了但取不回来：' + 图.status }
        b64 = Buffer.from(await 图.arrayBuffer()).toString('base64')
      }
      if (!b64) {
        记一笔('生图回了空内容：' + 文.slice(0, 160))
        return { ok: false, 码: 502, 代号: 'PAINT_EMPTY', 说: '接口没给出图：' + 文.slice(0, 200) }
      }
      记一笔('画好了（' + 模型 + '，' + Math.round(b64.length / 1024) + 'KB base64）')
      return { ok: true, b64, mime: 'image/png' }
    } catch (error) {
      const 说 = String((error && error.message) || error)
      记一笔('生图出错：' + 说)
      return { ok: false, 码: 502, 代号: 'PAINT_ERROR', 说 }
    } finally {
      clearTimeout(定)
    }
  }

  路由(管理前缀 + '/models', async (req, res) => {
    if (!同源(req)) return 回错(res, 403, 'CROSS_ORIGIN', '只给本页用')
    // ⚠ 读的是**设置里填的那个接口**的模型，不是 DSH 的。
    //   地址和密钥填的是谁，就得问谁 —— 拿 DSH 的模型列表去配别人的接口，等于瞎猜。
    const 地址 = String(配置.画图地址 || '').trim().replace(/\/+$/, '')
    const 密钥 = String(配置.画图密钥 || '').trim()
    if (!地址 || !密钥) {
      return 回(res, 200, { ok: true, providers: [], 说: '先填接口地址和密钥' })
    }
    let 基 = 地址
    try {
      const u = new URL(基)
      if (!u.pathname || u.pathname === '/') 基 = 基 + '/v1'
    } catch (error) {
      return 回错(res, 400, 'BAD_URL', '接口地址不对')
    }
    const 控 = new AbortController()
    const 定 = setTimeout(() => 控.abort(), 20000)
    try {
      const r = await fetch(基 + '/models', {
        headers: { authorization: 'Bearer ' + 密钥, accept: 'application/json' },
        signal: 控.signal,
      })
      const 文 = await r.text()
      if (!r.ok) {
        记一笔('读模型列表失败 HTTP ' + r.status)
        return 回(res, 200, { ok: true, providers: [], 说: '接口回了 ' + r.status + '：' + 文.slice(0, 160) })
      }
      let j = null
      try { j = JSON.parse(文) } catch (error) {}
      const 原始 = (j && (j.data || j.models)) || []
      const 模型们 = []
      for (const m of 原始) {
        const id = String((m && (m.id || m.name)) || '').trim()
        if (id) 模型们.push({ id, name: id })
      }
      记一笔('这个接口上有 ' + 模型们.length + ' 个模型')
      return 回(res, 200, { ok: true, providers: [{ id: 'api', name: 基, models: 模型们 }], 说: 模型们.length ? '' : '这个接口没列出模型' })
    } catch (error) {
      const 说 = String((error && error.message) || error)
      记一笔('读模型列表出错：' + 说)
      return 回(res, 200, { ok: true, providers: [], 说: '连不上：' + 说.slice(0, 120) })
    } finally {
      clearTimeout(定)
    }
  })

  /* ───────────────────────── 房间后台接口 ───────────────────────── */
  // 前缀跟桥接共用 /fish-room/v1（那个前缀是房间那边写死的），这里只加 /room/*。
  // 浏览器那一半不叼令牌，靠「同源」拦；房间自己带着令牌来也认。
  // 这个口子能起进程、能停进程，不能白给。

  function 放行(req) {
    return 同源(req) || 令牌对得上(req)
  }

  路由(前缀 + '/room/status', async (req, res) => {
    if (!放行(req)) return 回错(res, 403, 'CROSS_ORIGIN', '只给本页或房间用')
    const 状态 = await 房间状态()
    // 房间这次是被别人开的（不是插件拉起来的）也没关系：看到它活着就顺手补推
    if (状态.运行中) await 补推房间设置(记一笔, true)
    return 回(res, 200, 状态)
  })

  路由(前缀 + '/room/start', async (req, res) => {
    if (req.method !== 'POST') return 回错(res, 405, 'METHOD', '要用 POST')
    if (!放行(req)) return 回错(res, 403, 'CROSS_ORIGIN', '只给本页或房间用')
    const 果 = await 启动房间(记一笔)
    return 回(res, 果.ok ? 200 : 500, { ok: 果.ok, 已启动: 果.已启动, pid: 果.pid || 0, 说: 果.说, 状态: 果.状态 })
  })

  路由(前缀 + '/room/stop', async (req, res) => {
    if (req.method !== 'POST') return 回错(res, 405, 'METHOD', '要用 POST')
    if (!放行(req)) return 回错(res, 403, 'CROSS_ORIGIN', '只给本页或房间用')
    const 果 = await 停止房间(记一笔)
    return 回(res, 果.ok ? 200 : 500, { ok: 果.ok, 停止: 果.停止, 说: 果.说, 状态: 果.状态 })
  })

  路由(前缀 + '/room/open', async (req, res) => {
    if (req.method !== 'POST') return 回错(res, 405, 'METHOD', '要用 POST')
    if (!放行(req)) return 回错(res, 403, 'CROSS_ORIGIN', '只给本页或房间用')
    const 果 = await 打开房间窗口(记一笔)
    return 回(res, 果.ok ? 200 : 500, { ok: 果.ok, 窗口: 果.窗口, 去重: 果.去重 === true, 说: 果.说, 状态: 果.状态 })
  })

  // 开机自启：DSH 起来就把房间带起来，放在 effect 里是规矩。
  // ⚠ 卸载时**不停**它 —— 那可能是她自己开着的房间，不是插件生的。
  if (配置.开机自启) {
    ctx.effect(() => {
      启动房间(记一笔).catch((error) => 记一笔('开机自启出错：' + String((error && error.message) || error)))
      return () => {}
    })
  }

  /* ───────────────────────── 发现文件 ───────────────────────── */

  let 发现定时 = null
  let 发现签名 = ''

  function 写发现文件() {
    let 口 = 0
    try { 口 = Number(ctx.webServer && ctx.webServer.port) || 0 } catch (error) {}
    if (!口) return false
    const url = 'http://127.0.0.1:' + 口 + 前缀
    const 会话 = 目标会话()
    // ⚠ 比的是「内容变没变」，不是「文件写出来一不一样」——
    //   以前把时间戳一起比，于是每一跳都算「变了」，5 秒写一次、还刷一行日志。
    const 签名 = url + '|' + 配置.令牌 + '|' + 会话
    if (签名 === 发现签名) return true
    const 内容 = {
      schema: DISCOVERY_SCHEMA,
      url,
      token: 配置.令牌,
      sessionId: 会话,
      bridgeVersion: 桥版本,
      at: Date.now(),
    }
    try {
      fs.mkdirSync(家, { recursive: true })
      fs.writeFileSync(发现路, JSON.stringify(内容, null, 2), 'utf8')
      发现签名 = 签名
      记一笔('发现文件写好了：' + url + (会话 ? '（会话 ' + 短id(会话) + '）' : '（还没绑会话）'))
      return true
    } catch (error) {
      记一笔('发现文件写不进去：' + String((error && error.message) || error))
      return false
    }
  }

  // webServer 可能还没 listen 完，port 还是 0 —— 那就每秒再看一眼
  if (!写发现文件()) {
    let 试 = 0
    发现定时 = setInterval(() => {
      试 += 1
      if (写发现文件() || 试 > 60) {
        clearInterval(发现定时)
        发现定时 = null
      }
    }, 1000)
    发现定时.unref?.()
  }

  // 绑定变了、会话换了，发现文件跟着改
  ctx.effect(() => {
    const 看 = setInterval(() => { if (!发现定时) 写发现文件() }, 5000)
    看.unref?.()
    return () => clearInterval(看)
  })

  /* ───────────────────────── 心跳 & 收尾 ───────────────────────── */

  ctx.effect(() => {
    const 心跳 = setInterval(() => {
      for (const res of 连接们) {
        try { res.write(': ping' + 换行 + 换行) } catch (error) {}
      }
    }, Math.max(5, 配置.心跳秒) * 1000)
    心跳.unref?.()
    return () => clearInterval(心跳)
  })

  ctx.effect(() => () => {
    最近场景 = null
    for (const sid of 上下文挂着.keys()) 卸agent工具(sid);
    for (const res of 连接们) { try { res.end() } catch (error) {} }
    连接们.clear()
    if (发现定时) { clearInterval(发现定时); 发现定时 = null }
    try { fs.rmSync(发现路, { force: true }) } catch (error) {}
    记一笔('鱼鱼窝关掉了')
  })

  挂agent工具();
  记一笔('鱼鱼窝起来了（' + 前缀 + '）' + (目标会话() ? '，绑着 ' + 短id(目标会话()) : '，还没绑会话'))

  return {
    状态,
    发事件,
    读配置: () => 配置,
    设会话: (id) => {
      配置 = 写配置({ 会话: String(id || '') }) || 配置
      挂agent工具();
      写发现文件()
      return 配置.会话
    },
  }
}
