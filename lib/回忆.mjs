// 鱼鱼窝 · 回忆簿的三个来源
//
//   · 记住的事（fact）     ← 鱼的记忆（~/.dsh/fish-memory/session-<id>.json 里的 memories）
//   · 日记（daily）        ← 星汐绑的那个文件夹下的 日记/YYYY-MM-DD.md
//   · 成长（milestone）    ← 记忆卡.md 里的章和条目
//
// 只读，不改任何人的档案。找不到就返回空数组 —— 回忆簿空着比报错好。

import fs from 'node:fs'
import path from 'node:path'

const 换行 = String.fromCharCode(10)

function 读JSON(路) {
  try { return JSON.parse(fs.readFileSync(路, 'utf8')) } catch (error) { return null }
}

/** 星汐的配置：绑定（会话 → 文件夹）、记忆卡、日记 */
export function 读星汐(家目录) {
  const c = 读JSON(path.join(家目录, 'xingxi', 'config.json')) || {}
  const 绑定 = (c && typeof c.绑定 === 'object' && c.绑定) || {}
  return {
    绑定,
    记忆卡: typeof c.记忆卡 === 'string' ? c.记忆卡 : '',
    日记: typeof c.日记 === 'string' ? c.日记 : '',
  }
}

/** 鱼的记忆：一个会话一条 json，里面是 memories[] */
export function 读鱼的记忆(家目录, 会话) {
  const sid = String(会话 || '').trim()
  if (!sid) return []
  const 存 = 读JSON(path.join(家目录, 'fish-memory', sid + '.json'))
  const 列 = (存 && Array.isArray(存.memories)) ? 存.memories : []
  return 列
    .filter((m) => m && typeof m.text === 'string' && m.text.trim())
    .map((m) => ({
      id: 'fm:' + String(m.id || ''),
      at: String(m.at || m.createdAt || ''),
      kind: 'fact',
      title: '记住的事',
      text: String(m.text).trim(),
      source: '鱼的记忆',
      importance: Number(m.importance) || 0,
      tags: Array.isArray(m.tags) ? m.tags.slice(0, 12) : [],
    }))
}

/** 日记：一天一份 markdown */
export function 收日记(夹) {
  const 目录 = String(夹 || '').trim()
  if (!目录) return []
  let 名们 = []
  try {
    名们 = fs.readdirSync(path.join(目录, '日记')).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
  } catch (error) { return [] }
  名们.sort().reverse()
  const 出 = []
  for (const 名 of 名们) {
    let 文 = ''
    try { 文 = fs.readFileSync(path.join(目录, '日记', 名), 'utf8') } catch (error) { continue }
    const 日 = 名.replace(/\.md$/, '')
    const 净 = 文.trim()
    if (!净) continue
    出.push({
      id: 'diary:' + 日,
      at: 日 + 'T23:59:59',
      kind: 'daily',
      title: 日,
      text: 净,
      source: '日记',
      tags: [],
    })
  }
  return 出
}

/** 记忆卡：## 章名 下面是条目，一行一条 */
export function 收记忆卡(路) {
  const p = String(路 || '').trim()
  if (!p) return []
  let 文 = ''
  try { 文 = fs.readFileSync(p, 'utf8') } catch (error) { return [] }
  const 出 = []
  let 章 = ''
  let 序 = 0
  for (const 行 of 文.split(/\r?\n/)) {
    const 章头 = /^##\s*(.+?)\s*$/.exec(行)
    if (章头) { 章 = 章头[1].replace(/^[一二三四五六七八九十百]+[、.\s]*/, '').trim(); continue }
    const 条 = /^\s*[-*·]\s+(.+?)\s*$/.exec(行)
    if (!条) continue
    const 正文 = 条[1].trim()
    // ⚠ 别按长度筛：「她怕黑」这种只有三个字，也是正经一条
    if (!正文 || 正文.length < 2) continue
    序 += 1
    出.push({
      id: 'card:' + 序,
      at: '',
      kind: 'milestone',
      title: 章 || '记忆卡',
      text: 正文,
      source: '记忆卡',
      tags: [],
    })
  }
  return 出
}

/**
 * 相伴第几天 —— 跟星汐联动：取她日记里**最早那一篇**的日期当起点。
 * 先看会话绑的那个文件夹，没有再看全局那份。
 */
export function 收天数(家目录, 会话, 星汐) {
  const 配置 = 星汐 || 读星汐(家目录)
  const 夹 = String((配置.绑定 && 配置.绑定[会话]) || '').trim()
  const 候选 = [夹 ? path.join(夹, '日记') : '', 配置.日记].filter(Boolean)
  let 最早 = ''
  for (const 目 of 候选) {
    let 名们 = []
    try { 名们 = fs.readdirSync(目).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)) } catch (error) { continue }
    名们.sort()
    if (名们.length && (!最早 || 名们[0] < 最早)) 最早 = 名们[0]
  }
  if (!最早) return { since: '', days: 0 }
  const 起 = 最早.replace(/\.md$/, '')
  const 天 = Math.floor((Date.parse(今天() + 'T00:00:00Z') - Date.parse(起 + 'T00:00:00Z')) / 86400000) + 1
  return { since: 起, days: Math.max(1, 天) }
}

function 今天() {
  const d = new Date()
  const 补 = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + 补(d.getMonth() + 1) + '-' + 补(d.getDate())
}

/**
 * 把三个来源合起来。
 * @param {string} 家目录 ~/.dsh
 * @param {string} 会话   绑定的会话 id（session-…）
 * @param {object} 星汐   读星汐() 的结果
 */
export function 收回忆(家目录, 会话, 星汐) {
  const 配置 = 星汐 || 读星汐(家目录)
  const 夹 = String((配置.绑定 && 配置.绑定[会话]) || '').trim()
  const 日记夹 = 夹 || 配置.日记
  // ⚠ 记忆卡（成长）已经不要了 —— 一行一句像流水账，面板上那个按钮也删了。
  return [
    ...读鱼的记忆(家目录, 会话),
    ...收日记(日记夹),
  ]
}

/** 搜 + 分页。q 为空就是全部；kind 为空就是所有类型。 */
export function 筛回忆(全部, { q = '', kind = '', limit = 20, offset = 0 } = {}) {
  const 词 = String(q || '').trim().toLowerCase()
  const 类 = String(kind || '').trim()
  let 列 = 全部.filter((x) => x && (!类 || x.kind === 类))
  if (词) {
    列 = 列.filter((x) => (String(x.text || '') + ' ' + String(x.title || '') + ' ' + (x.tags || []).join(' '))
      .toLowerCase().includes(词))
  }
  // 有时间按时间倒序，没时间的（记忆卡条目）排在后面
  列 = 列.slice().sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
  const 总 = 列.length
  const 起 = Math.max(0, Math.trunc(Number(offset) || 0))
  const 数 = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 20)))
  return { total: 总, items: 列.slice(起, 起 + 数) }
}
