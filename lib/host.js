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
import { spawn, execFileSync } from 'node:child_process'
import { setTimeout as 睡 } from 'node:timers/promises'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { 读星汐, 收回忆, 筛回忆, 收天数 } from './回忆.mjs'
import { 鱼鱼窝图标 } from './icon.mjs'

export const name = 'fish-home'
// 这几个都是宿主必备的服务；写进 inject 才能直接 ctx.agents 这么用
// （没声明的服务连 ctx.get('x') 都会抛 —— 归档名单就是栽在这上面：
//   workspaceRegistry 没声明 → 拿到 undefined → 归档过滤整个失效 → 列表里全是归档会话）
export const inject = ['webServer', 'agents', 'sessions', 'sessionTitle', 'workspaceRegistry']

const 桥版本 = '0.0.1'
const 前缀 = '/fish-room/v1'

const SCHEMA = 'dsh.fish-room/1'
const EVENT_SCHEMA = 'dsh.fish-room.event/1'
const CHAT_SCHEMA = 'dsh.fish-room.chat/1'
const PET_STATE_SCHEMA = 'dsh.fish-room.pet-state/1'
const LIFE_EVENT_SCHEMA = 'dsh.fish-room.life-event/1'
const DISCOVERY_SCHEMA = 'dsh.fish-room.discovery/1'

const 事件白名单 = new Set([
  'bridge.hello', 'stream.reset', 'chat.user', 'chat.reply', 'chat.thinking', 'chat.error',
  'proactive.speak', 'activity.bili', 'activity.desk', 'paint.image', 'pet.state.ack', 'bridge.notice',
])

const 家 = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const 配置路 = path.join(家, 'fish-room.json')
const 发现路 = path.join(家, 'fish-room.discovery.json')
const 房间记录路 = path.join(家, 'fish-room.room.json')

// 房间本体不在插件里 —— 它是「大肥鱼的小日子」那边的一个独立程序。
// 三个环境变量是给自测留的口子：验 start / stop 的时候，不能去碰她正在用的那个房间。
const 房间目录 = process.env.FISH_ROOM_DIR || 'D:\\1\\大肥鱼的小日子'
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
  // 她醒来时主动招呼的那句，一天只来一次；记的是本地日期 yyyy-mm-dd
  上次醒来招呼: '',
  // 睡着就不理人：关掉 = pre-step 完全放行（最后一道逃生门）
  睡着不理: true,
}

function 读配置() {
  let 存 = {}
  try { 存 = JSON.parse(fs.readFileSync(配置路, 'utf8')) } catch (e) { 存 = {} }
  const 合 = { ...默认配置, ...(存 && typeof 存 === 'object' ? 存 : {}) }
  合.开 = 合.开 !== false
  合.开机自启 = 合.开机自启 === true
  合.转发主动开口 = 合.转发主动开口 !== false
  合.学菜 = 合.学菜 !== false
  合.画图 = 合.画图 !== false
  合.待推设置 = Array.isArray(合.待推设置)
    ? 合.待推设置.filter((键) => 键 === '学菜' || 键 === '画图')
    : []
  合.上次醒来招呼 = String(合.上次醒来招呼 || '').trim()
  合.睡着不理 = 合.睡着不理 !== false
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

/** 本地日期（她那边用的是 Asia/Shanghai，这台机器也是）。 */
function 今天日期() {
  const d = new Date()
  const 补 = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + 补(d.getMonth() + 1) + '-' + 补(d.getDate())
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

/** 请求一次 /api/health；2 秒内答 ok:true 才算在跑。 */
export async function 探健康(超时毫秒 = 健康超时) {
  const 控 = new AbortController()
  const 定 = setTimeout(() => 控.abort(), 超时毫秒)
  try {
    const r = await fetch(房间地址 + '/api/health', { signal: 控.signal, cache: 'no-store' })
    if (!r.ok) return false
    const j = await r.json()
    return Boolean(j && j.ok === true)
  } catch (error) {
    return false
  } finally {
    clearTimeout(定)
  }
}

/** 房间 /api/state 里的两个开关。字段缺了就 null，由调用方回落到本地配置。 */
// 读 state 比健康检查慢：房间可能会顺便去问 DSH 桥，5 秒够它把话说完
export async function 读房间设置(超时毫秒 = 5000) {
  const 控 = new AbortController()
  const 定 = setTimeout(() => 控.abort(), 超时毫秒)
  try {
    const r = await fetch(房间地址 + '/api/state', { signal: 控.signal, cache: 'no-store' })
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
  if (睡眠缓存.值 && Date.now() - 睡眠缓存.at < 缓存毫秒) return 睡眠缓存.值
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
export async function 设置睡眠(睡, 超时毫秒 = 3000) {
  const 控 = new AbortController()
  const 定 = setTimeout(() => 控.abort(), 超时毫秒)
  try {
    const r = await fetch(房间地址 + '/api/sleep', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 睡: Boolean(睡) }),
      signal: 控.signal,
    })
    if (!r.ok) return { ok: false, 说: '房间回了 ' + r.status }
    const j = await r.json().catch(() => null)
    const 睡着 = j && typeof j.睡着 === 'boolean' ? j.睡着 : Boolean(睡)
    // 刚改过就刷新缓存，免得下一步还拿旧状态去判断
    const 可叫醒 = 睡眠缓存.值 && 睡眠缓存.值.ok ? 睡眠缓存.值.可叫醒 : true
    睡眠缓存 = { at: Date.now(), 值: { ok: true, 睡着, 可叫醒 } }
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
  return { 运行中: await 探健康(), 地址: 房间地址, 练习: 编译版本号() }
}

/** 房间要一个真的 node；DSH 自己跑在 Electron 里，process.execPath 不是它。 */
function 找node() {
  const 候选 = [
    path.join(房间目录, 'runtime', 'node.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
  ]
  for (const 一个 of 候选) {
    try { if (一个 && fs.existsSync(一个)) return 一个 } catch (error) {}
  }
  return 'node'   // 最后交给 PATH；起不来会由 spawn 的错误兜住
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
  if (await 探健康()) {
    return { ok: true, 已启动: false, 说: '已经在跑', 状态: { 运行中: true, 地址: 房间地址, 练习: 版本 } }
  }

  const 入口 = path.join(房间目录, 'app-server.js')
  if (!fs.existsSync(入口)) {
    return { ok: false, 已启动: false, 说: '找不到房间：' + 入口, 状态: { 运行中: false, 地址: 房间地址, 练习: 版本 } }
  }

  let 子
  try {
    子 = spawn(找node(), ['app-server.js', '--production', '--port', String(房间端口)], {
      cwd: 房间目录,
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
  if (!(await 探健康())) {
    删房间记录()
    return { ok: true, 停止: false, 说: '本来就没在跑', 状态: await 房间状态() }
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
  上次开窗 = 现在

  // 自测用：不真弹一个窗口出来（验的是「起没起来 / 去重没有」，不是窗口长什么样）
  if (process.env.FISH_ROOM_NO_WINDOW === '1') {
    return { ok: true, 窗口: false, 去重: false, 说: '自测模式：没开窗口', 状态: 起.状态 }
  }

  const 档案 = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'DayuLittleRoom', 'browser-profile')
  const 浏览器 = 找浏览器()
  try {
    if (浏览器) {
      // 跟 打开大肥鱼.cmd 用同一个 profile：窗口位置、设置、缓存都还在那儿
      spawn(浏览器, [
        '--app=' + 房间地址,
        '--user-data-dir=' + 档案,
        '--no-first-run',
        '--no-default-browser-check',
        '--start-maximized',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
      ], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    } else {
      // 没装 Chrome / Edge 就交给系统默认浏览器
      spawn('cmd.exe', ['/c', 'start', '', 房间地址], { windowsHide: true, detached: true, stdio: 'ignore' }).unref()
    }
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
  let 状态版本 = 0
  const 生活事件 = []
  let 最近说过的 = ''
  let 最近说话时 = 0
  // 房间里的钟：几点、白天夜里、天气（房间那边每隔几秒报一次）
  let 房间环境 = null
  let 事件计数 = 0

  function 收下环境(来源) {
    if (!来源 || typeof 来源 !== 'object') return
    const 时 = Number(来源.hour)
    if (!Number.isFinite(时)) return
    房间环境 = {
      hour: Math.max(0, Math.min(24, 时)),
      period: String(来源.period || ''),
      weather: String(来源.weather || ''),
      realtime: 来源.realtime !== false,
      at: Date.now(),
    }
  }

  /** 递给 DSH 的那一句：房间里现在几点、外面什么天、她在干嘛。 */
  function 房间那句() {
    const 房 = 房间环境
    if (!房 || !Number.isFinite(房.hour)) return ''
    // 取整到 10 分钟：免得每一轮都变、白白把上下文搅动一遍
    const 总分 = Math.floor(房.hour * 60 / 10) * 10
    const hh = String(Math.floor(总分 / 60) % 24).padStart(2, '0')
    const mm = String(总分 % 60).padStart(2, '0')
    const 段 = 房.period ? '，' + 房.period : ''
    const 天 = { rain: '外面在下雨', snow: '外面在下雪', cloudy: '天有点阴', storm: '外面在打雷' }[房.weather] || ''
    const 她 = 最近状态 && 最近状态.snapshot && 最近状态.snapshot.activity
    const 在 = 她 && 她.label ? '她这会儿在' + String(她.label).slice(0, 20) + '。' : ''
    const 心情 = 最近状态 && 最近状态.snapshot && Number.isFinite(Number(最近状态.snapshot.mood))
      ? '心情 ' + Math.round(Number(最近状态.snapshot.mood)) + '/100。'
      : ''
    return '【鱼鱼窝】房间里现在是 ' + hh + ':' + mm + 段 + '。' + (天 ? 天 + '。' : '') + 在 + 心情
  }

  // 房间时间 + 画架工具，都挂在绑定的那间会话上（跟心情插件一样按 agent 实例记）
  const 上下文挂着 = new Map() // sid -> { agent, off们: [] }
  function 画工具() {
    return {
      name: 'paint',
      description: '在房间的画架上画一张画。prompt 写你想画什么。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '画什么' },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, 说: { type: 'string' } },
          required: ['ok'],
        },
        render: (结果) => [{ type: 'text', text: String((结果 && 结果.说) || '') }],
      },
      async execute(args = {}) {
        const 话 = String((args && args.prompt) || '').trim()
        if (!话) return { ok: false, 说: '要画什么？' }
        const 结果 = await 画一张(话)
        if (!结果.ok) return { ok: false, 说: 结果.说 }
        // 图太大，不进历史缓冲，只发给现在连着的
        发事件('paint.image', { b64: 结果.b64, mime: 结果.mime, prompt: 话.slice(0, 200) }, true)
        return { ok: true, 说: '画好了，画架上已经换上这张。' }
      },
    }
  }

  // 「说完晚安之后自己躺下」——不是看到「晚安」两个字就自动睡，那样连那句晚安都回不出去。
  function 睡眠工具() {
    return {
      name: 'sleep',
      description: '躺下睡觉（睡=true）或者起来（睡=false）。说完晚安之后用这个躺下。',
      parameters: {
        type: 'object',
        properties: {
          睡: { type: 'boolean', description: 'true = 躺下睡觉，false = 起来' },
        },
        required: ['睡'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, 说: { type: 'string' } },
          required: ['ok'],
        },
        render: (结果) => [{ type: 'text', text: String((结果 && 结果.说) || '') }],
      },
      async execute(args = {}) {
        const 睡 = args && args.睡
        if (typeof 睡 !== 'boolean') return { ok: false, 说: '要说清楚是睡（true）还是起（false）。' }
        const 结果 = await 设置睡眠(睡)
        if (!结果.ok) return { ok: false, 说: '房间那边没答话：' + (结果.说 || '没成。') }
        return { ok: true, 说: 睡 ? '躺下了' : '起来了' }
      },
    }
  }

  function 挂agent工具(agent) {
    if (!agent || !agent.ctx || !agent.session) return
    const sid = 会话键(agent.session.id)
    const 已 = 上下文挂着.get(sid)
    if (已 && 已.agent === agent) return
    if (已) {
      for (const off of 已.off们) { try { if (typeof off === 'function') off() } catch (error) {} }
      上下文挂着.delete(sid)
    }
    const off们 = []
    try {
      off们.push(agent.ctx.systemPrompt.context({
        name: 'fish-home',
        order: 950,
        text: () => 房间那句(),
      }))
    } catch (error) {
      记一笔('房间时间挂不上（不影响聊天）：' + String((error && error.message) || error))
    }
    try {
      if (agent.ctx.tools && typeof agent.ctx.tools.register === 'function') {
        off们.push(agent.ctx.tools.register(画工具()))
      }
    } catch (error) {
      if (!/already registered/i.test(String((error && error.message) || error))) {
        记一笔('画架工具挂不上：' + String((error && error.message) || error))
      }
    }
    try {
      if (agent.ctx.tools && typeof agent.ctx.tools.register === 'function') {
        off们.push(agent.ctx.tools.register(睡眠工具()))
      }
    } catch (error) {
      if (!/already registered/i.test(String((error && error.message) || error))) {
        记一笔('睡觉工具挂不上：' + String((error && error.message) || error))
      }
    }
    if (off们.length) {
      上下文挂着.set(sid, { agent, off们 })
      记一笔('房间时间 / 画架 / 睡觉工具挂到 ' + 短id(sid) + ' 上了')
    }
  }

  /* ── 聊天：房间 → DSH ── */
  const 待回 = new Map()    // sid -> [{ requestId, at }]
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
      挂agent工具(找agent(sid))
      // 「她开始想了」——房间那边收到就冒个气泡，别让人干等
      发事件('chat.thinking', { at: Date.now() })
      return
    }

    if (event.type === 'user/message') {
      const d = event.data || {}
      const 源 = d.source || (d.message && d.message.source) || null
      const 类 = String((源 && 源.kind) || '')
      if (类 === 'fish-home') return                      // 房间自己说的话，不再回声
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
      const d = event.data || {}
      const 完成 = !!(d.reason && d.reason.kind === 'completed')
      const 上 = 上一轮.get(sid)
      上一轮.delete(sid)
      if (!完成 || !上 || 上.turn !== d.turn) return
      const 文 = String(上.text || '').trim()
      if (!文) return
      const 队 = 待回.get(sid) || []
      const 一单 = 队.shift()
      if (一单) {
        待回.set(sid, 队)
        发事件('chat.reply', { requestId: 一单.requestId, text: 文, messageId: 上.messageId || '', turn: d.turn })
        最近说过的 = 文
        最近说话时 = Date.now()
        return
      }
      if (配置.转发主动开口) {
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
  async function 睡着该不该拦(payload) {
    // 最后一道逃生门：关掉就整个旁路，连状态都不读
    if (配置.睡着不理 === false) return { 拦: false }
    const 目标 = 目标会话()
    const 这间 = 会话键(payload && payload.agent && payload.agent.session && payload.agent.session.id)
    if (!目标 || 这间 !== 目标) return { 拦: false }
    const 睡 = await 读房间睡眠()
    if (!睡.ok) return { 拦: false }
    // 同一次读数也拿去判断「刚醒」：睡着 → 醒的跳变要主动递一句话
    await 记录睡眠观察(睡)
    if (!睡.睡着) return { 拦: false }

    // 保险丝：屋里该醒没醒（起床点已经过去 60 秒）—— 房间 tick 停了 / 数据坏了 / 我们改错了。
    // 优先于「不可叫醒」和「有没有新消息」：放行这一步，并顺手把她叫醒。
    if (Number.isFinite(睡.until) && Date.now() - 睡.until > 60000) {
      const 过了 = Math.round((Date.now() - 睡.until) / 1000)
      记一笔('屋里该醒没醒（起床点已过 ' + 过了 + ' 秒），自己放行并叫醒')
      // 叫醒本身也绝不能卡住这一步：1.5 秒超时，失败照样放行
      const 醒 = await 设置睡眠(false, 1500)
      if (醒.ok) 上次睡着 = false
      else 记一笔('保险丝想叫醒她但房间没答话（照常放行）：' + String(醒.说 || ''))
      return { 拦: false }
    }

    const 有新消息 = Array.isArray(payload.messages) && payload.messages.length > 0
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
    const 醒 = await 设置睡眠(false, 1500)
    if (!醒.ok) 记一笔('想叫醒她但房间没答话（这一步照常放行）：' + String(醒.说 || ''))
    else {
      // 这一下是我们按她的消息叫起来的，不用再补一句「她刚醒」
      上次睡着 = false
      记一笔('她睡着但可叫醒，叫起来了，这一步放行')
    }
    return { 拦: false }
  }

  try {
    ctx.effect(() => {
      const 摘 = ctx.on('agent/pre-step', async (payload, next) => {
        let 判 = { 拦: false }
        try { 判 = await 睡着该不该拦(payload) } catch (error) {
          记一笔('睡着拦截出错（放行）：' + String((error && error.message) || error))
        }
        return 判.拦 ? { kind: 'reject' } : next()
      })
      return () => { try { if (typeof 摘 === 'function') 摘() } catch (error) {} }
    })
  } catch (error) {
    记一笔('挂不上 agent/pre-step（睡着拦截不生效）：' + String((error && error.message) || error))
  }

  /* ── 她醒了，主动来说一句 ── */
  // 她自然醒来时 DSH 这边没有任何事件，只能靠「上一次看到睡着、这次看到醒了」判断。
  // 递话用 followup（DSH 里唯一能叫醒一轮的通道），source 标成 fish-room-wake ——
  // 网页端会把它归到「非人触发的某一轮」，不是她打的那条消息。
  let 上次睡着 = null

  async function 招呼醒来() {
    const 今天 = 今天日期()
    if (读配置().上次醒来招呼 === 今天) return false
    const 目标 = 目标会话()
    if (!目标) return false
    const agent = 找agent(目标)
    if (!agent || typeof agent.followup !== 'function') {
      记一笔('她醒了，但绑定的会话没开着，醒来招呼没递')
      return false
    }
    const 文 = '她醒了，这会儿在卧室，问你是不是也醒了。'
    try {
      await agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: 文 }],
        source: { kind: 'fish-room-wake' },
      })
    } catch (error) {
      记一笔('醒来招呼没递进去：' + String((error && error.message) || error))
      return false
    }
    try {
      const 会话服务 = ctx.sessions || 拿服务('sessions')
      if (会话服务 && typeof 会话服务.flush === 'function') await 会话服务.flush(agent.session)
    } catch (error) {}
    写配置({ 上次醒来招呼: 今天 })
    记一笔('她醒了，给 ' + 短id(目标) + ' 递了句醒来招呼')
    return true
  }

  async function 记录睡眠观察(睡) {
    if (!睡 || !睡.ok) return false
    const 前 = 上次睡着
    上次睡着 = 睡.睡着
    if (前 !== true || 睡.睡着 !== false) return false
    return await 招呼醒来()
  }

  async function 看醒来() {
    if (!目标会话()) return false
    const 睡 = await 读房间睡眠()
    return await 记录睡眠观察(睡)
  }

  // 10 秒看一眼：她自己在房间里醒来时，没有任何事件会通知到这里。
  // 读的是同一个 4 秒缓存，跟 pre-step 共享。
  ctx.effect(() => {
    const 间隔 = Math.max(1000, Math.trunc(Number(process.env.FISH_ROOM_WAKE_TICK_MS) || 10000))
    const 看 = setInterval(() => { 看醒来().catch(() => {}) }, 间隔)
    看.unref?.()
    return () => clearInterval(看)
  })

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
      capabilities: ['chat', 'events', 'pet-state', 'life-event'],
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
      capabilities: ['chat', 'events', 'pet-state', 'life-event'],
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
        capabilities: ['chat', 'events', 'pet-state', 'life-event'],
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
    const 目标 = 会话 || 目标会话()
    if (!目标) return 回(res, 200, { ok: true, schema: SCHEMA, total: 0, items: [] })
    try {
      const 星汐 = 读星汐(家)
      const 全部 = 收回忆(家, 目标, 星汐)
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
    const 目标 = 会话 || 目标会话()
    if (!目标) return 回(res, 200, { ok: true, schema: SCHEMA, since: '', days: 0 })
    try {
      const r = 收天数(家, 目标, 读星汐(家))
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
    const 队 = 待回.get(目标) || []
    if (队.length >= 3) return 回错(res, 429, 'BRIDGE_BUSY', '还有话没回完，等一下')

    try {
      // ⚠ 必须 await：不接住的话，reject 会变成未处理异常，把整个宿主带走
      await agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: 文 }],
        source: { kind: 'fish-home' },
      })
    } catch (error) {
      return 回错(res, 502, 'SEND_FAILED', '送不进去：' + String((error && error.message) || error))
    }

    队.push({ requestId, at: Date.now() })
    待回.set(目标, 队)
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
    收下环境(体.snapshot)
    最近状态 = {
      revision: ++状态版本,
      at: Number(体.at) || Date.now(),
      snapshot: 体.snapshot && typeof 体.snapshot === 'object' ? 体.snapshot : null,
      recent: Array.isArray(体.recent) ? 体.recent.slice(-5) : [],
      recentChat: Array.isArray(体.recentChat) ? 体.recentChat.slice(-6) : [],
    }
    return 回(res, 200, { ok: true, revision: 最近状态.revision })
  })

  // 房间里发生的事（刷完 B 站回来了、挪到电脑桌前）
  路由(前缀 + '/pet/life-event', async (req, res) => {
    if (req.method !== 'POST') return 回错(res, 405, 'METHOD', '要用 POST')
    if (!令牌对得上(req)) return 回错(res, 401, 'UNAUTHORIZED', '令牌不对')
    let 体
    try { 体 = await 读体(req) } catch (error) { return 回错(res, 400, 'BAD_BODY', String((error && error.message) || error)) }
    if (!体 || 体.schema !== LIFE_EVENT_SCHEMA) return 回错(res, 400, 'BAD_SCHEMA', '这份数据的版本不对')
    const id = String(体.id || '')
    if (id && 生活事件.some((x) => x.id === id)) return 回(res, 202, { ok: true, duplicate: true })
    生活事件.push({
      id, at: Number(体.at) || Date.now(), kind: String(体.kind || ''), title: String(体.title || '').slice(0, 200),
      text: String(体.text || '').slice(0, 4000), room: String(体.room || ''), action: String(体.action || ''),
    })
    if (生活事件.length > 200) 生活事件.shift()
    return 回(res, 202, { ok: true })
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

  function 管理状态() {
    const 目标 = 目标会话()
    return {
      ok: true,
      version: 桥版本,
      开: 配置.开,
      开机自启: 配置.开机自启,
      睡着不理: 配置.睡着不理,
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
      房间那句: 房间那句(),
      最近说过: 最近说过的,
      最近说话时: 最近说话时,
      生活事件: 生活事件.slice(-8),
      日志: 日志.slice(-15),
      名单: 会话清单(),
    }
  }

  路由(管理前缀 + '/state', async (req, res) => {
    if (!同源(req)) return 回错(res, 403, 'CROSS_ORIGIN', '只给本页用')
    return 回(res, 200, 管理状态())
  })

  // 侧栏按钮的图标只在 lib/icon.mjs 存一份。网页那一半是**单文件 bundle**，
  // 浏览器里 import 不了同级模块（模块图只认平台表），所以由宿主把图递过去。
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
    写发现文件()
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
    const 文 = String(体.话 || '在吗？我在房间里叫你呢。').trim().slice(0, 500)
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
    看门狗 = setInterval(() => {
      try {
        const m = process.memoryUsage()
        const 行 = new Date().toISOString() + '  heap ' + Math.round(m.heapUsed / 1048576) + 'MB  rss '
          + Math.round(m.rss / 1048576) + 'MB  事件 ' + 事件计数 + '  连接 ' + 连接们.size + '  历史 ' + 历史.length + '\n'
        fs.appendFileSync(记忆日志, 行, 'utf8')
      } catch (error) {}
    }, 2000)
    看门狗.unref?.()
  } catch (error) {}

  // 房间里的画架：房间只报一句「到画架前了」，画什么由它自己定。
  // ⚠ 这句话是**递给模型**的，所以要用第二人称。以前写的是「她走到画架前」——
  //   模型读到的是「有个人（她）在画架前」，不是自己要去画，画不出来也对。
  路由(前缀 + '/paint', async (req, res) => {
    if (req.method !== 'POST') return 回错(res, 405, 'METHOD', '要用 POST')
    if (!令牌对得上(req)) return 回错(res, 401, 'UNAUTHORIZED', '令牌不对')
    if (!配置.开) return 回错(res, 503, 'DISABLED', '桥接关着')
    const 目标 = 目标会话()
    if (!目标) return 回错(res, 409, 'NO_SESSION', '还没选会话')
    const agent = 找agent(目标)
    if (!agent || typeof agent.followup !== 'function') return 回错(res, 409, 'SESSION_SLEEPING', '那间会话现在没开着')
    try {
      await agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: '你走到画架前站了一会儿。想画什么，就画吧。' }],
        source: { kind: 'fish-home' },
      })
    } catch (error) {
      return 回错(res, 502, 'SEND_FAILED', '送不进去：' + String((error && error.message) || error))
    }
    记一笔('有人去画架前了，跟它说了')
    return 回(res, 200, { ok: true, 说: '跟她说了' })
  })

  // 真画：设置页「画一张」和工具都用这条
  路由(前缀 + '/paint/draw', async (req, res) => {
    if (req.method !== 'POST') return 回错(res, 405, 'METHOD', '要用 POST')
    if (!令牌对得上(req)) return 回错(res, 401, 'UNAUTHORIZED', '令牌不对')
    let 体
    try { 体 = await 读体(req) } catch (error) { return 回错(res, 400, 'BAD_BODY', String((error && error.message) || error)) }
    const 结果 = await 画一张(体 && 体.prompt)
    if (!结果.ok) return 回错(res, 结果.码 || 502, 结果.代号 || 'PAINT_FAILED', 结果.说)
    return 回(res, 200, { ok: true, mime: 结果.mime, b64: 结果.b64, 模型: 配置.画图模型 })
  })

  /** 调一次生图接口，拿回 base64。地址 / 密钥 / 模型都从设置里来。 */
  async function 画一张(prompt) {
    const 地址 = String(配置.画图地址 || '').trim().replace(/\/+$/, '')
    const 密钥 = String(配置.画图密钥 || '').trim()
    const 模型 = String(配置.画图模型 || '').trim()
    if (!地址 || !密钥 || !模型) {
      return { ok: false, 码: 400, 代号: 'PAINT_NOT_CONFIGURED', 说: '画图还没配：地址、密钥、模型三样都要填' }
    }
    const 话 = String(prompt || '').trim().slice(0, 1000) || '一幅安静的风景画'
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
      const r = await fetch(基 + '/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + 密钥 },
        body: JSON.stringify(要的),
        signal: 控.signal,
      })
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
    for (const res of 连接们) { try { res.end() } catch (error) {} }
    连接们.clear()
    if (发现定时) { clearInterval(发现定时); 发现定时 = null }
    try { fs.rmSync(发现路, { force: true }) } catch (error) {}
    记一笔('鱼鱼窝关掉了')
  })

  记一笔('鱼鱼窝起来了（' + 前缀 + '）' + (目标会话() ? '，绑着 ' + 短id(目标会话()) : '，还没绑会话'))

  return {
    状态,
    发事件,
    看醒来,
    读配置: () => 配置,
    设会话: (id) => {
      配置 = 写配置({ 会话: String(id || '') }) || 配置
      写发现文件()
      return 配置.会话
    },
  }
}
