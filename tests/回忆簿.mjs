// 回忆簿：三个来源怎么合、怎么筛（0.1.0）
//
// 记住的事 ← 鱼的记忆；日记 ← 星汐绑的文件夹；成长 ← 记忆卡
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { 读星汐, 读鱼的记忆, 收日记, 收记忆卡, 收回忆, 筛回忆 } from '../lib/memory.mjs'

let 挂 = 0
const 报 = (标, 过, 细) => {
  if (!过) 挂++
  console.log((过 ? 'PASS  ' : 'FAIL  ') + 标 + (细 ? '  :: ' + 细 : ''))
}

const 家 = fs.mkdtempSync(path.join(os.tmpdir(), 'fishroom-回忆-'))
const 档案 = path.join(家, '档案')
const 会话 = 'session-test-1'

// 鱼的记忆
fs.mkdirSync(path.join(家, 'fish-memory'), { recursive: true })
fs.writeFileSync(path.join(家, 'fish-memory', 会话 + '.json'), JSON.stringify({
  version: 4,
  memories: [
    { id: 'a1', text: '她说想去看海', at: '2026-11-01T10:00:00.000Z', tags: ['海', '约好'] },
    { id: 'a2', text: '她讨厌被叫小朋友', at: '2026-11-05T10:00:00.000Z', tags: ['称呼'] },
    { id: 'a3', text: '   ', at: '2026-11-06T10:00:00.000Z' },
  ],
}), 'utf8')

// 星汐配置 + 日记 + 记忆卡
fs.mkdirSync(path.join(家, 'xingxi'), { recursive: true })
fs.mkdirSync(path.join(档案, '日记'), { recursive: true })
fs.writeFileSync(path.join(档案, '日记', '2026-11-03.md'), '# 2026-11-03\n\n今天她笑了很久。', 'utf8')
fs.writeFileSync(path.join(档案, '日记', '2026-11-07.md'), '# 2026-11-07\n\n下雨，她没出门。', 'utf8')
fs.writeFileSync(path.join(档案, '记忆卡.md'), '## 一、她\n\n- 她叫小鱿鱼\n- 她怕黑\n\n## 二、我们\n\n- 第一次见面是秋天\n', 'utf8')
fs.writeFileSync(path.join(家, 'xingxi', 'config.json'), JSON.stringify({
  绑定: { [会话]: 档案 },
  记忆卡: path.join(家, '不该用的记忆卡.md'),
  日记: path.join(家, '不该用的日记'),
}), 'utf8')

const 星汐 = 读星汐(家)
报('读星汐：绑定拿到了', 星汐.绑定[会话] === 档案, 星汐.绑定[会话])

const 记 = 读鱼的记忆(家, 会话)
报('鱼的记忆：空白的丢掉', 记.length === 2, String(记.length))
报('鱼的记忆：kind = fact', 记.every((x) => x.kind === 'fact'), '')
报('鱼的记忆：带 tags', (记[1].tags || []).includes('称呼'), JSON.stringify(记[1].tags))

const 日 = 收日记(档案)
报('日记：一天一条', 日.length === 2, String(日.length))
报('日记：新的排前面', 日[0].title === '2026-11-07', 日[0].title)
报('日记：kind = daily', 日.every((x) => x.kind === 'daily'), '')

const 卡 = 收记忆卡(path.join(档案, '记忆卡.md'))
报('记忆卡：按行拆成条目', 卡.length === 3, String(卡.length))
报('记忆卡：章名带在 title 上', 卡[0].title === '她', 卡[0].title)
报('记忆卡：kind = milestone', 卡.every((x) => x.kind === 'milestone'), '')

const 全部 = 收回忆(家, 会话, 星汐)
报('合起来：只有记住的事 + 日记（成长已经不要了）', 全部.length === 4, String(全部.length))
报('不再有 milestone（记忆卡那一路已经摘掉）', 全部.every((x) => x.kind !== 'milestone'), JSON.stringify([...new Set(全部.map((x) => x.kind))]))
报('会话绑了文件夹时，不用全局那两份（全局路径是假的，读了就会报错）',
  全部.filter((x) => x.kind === 'daily').length === 2, '')

const 搜海 = 筛回忆(全部, { q: '海' })
报('搜「海」：命中记住的事', 搜海.total >= 1 && 搜海.items.some((x) => x.text.includes('海')), String(搜海.total))

const 只日记 = 筛回忆(全部, { kind: 'daily' })
报('只看日记：两条', 只日记.total === 2, String(只日记.total))

const 分页 = 筛回忆(全部, { limit: 2, offset: 2 })
报('分页：total 还是全部，items 只有 2', 分页.total === 4 && 分页.items.length === 2, JSON.stringify({ t: 分页.total, n: 分页.items.length }))

报('空会话：什么都不返回，也不炸', 收回忆(家, '', 星汐).length === 0, '')
报('没绑定过的会话：日记和记忆卡退回全局那份（这里是空路径 → 空数组）',
  收回忆(家, 'session-没绑过', 星汐).every((x) => x.kind === 'fact'), '')

fs.rmSync(家, { recursive: true, force: true })
console.log('')
console.log(挂 === 0 ? '全过' : ('挂了 ' + 挂 + ' 条'))
process.exit(挂 === 0 ? 0 : 1)
