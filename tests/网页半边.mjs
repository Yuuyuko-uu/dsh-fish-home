// 网页那一半的自测：假 React + 假 window，把它真跑一遍，只求「不炸」。
//
// 为什么要有这一份：2026-11-12 有一次 `const 拉模型` 写在「用它的那个 useEffect」后面，
// 一渲染就 TDZ 抛错 → DSH 设置里整块「鱼鱼窝」直接消失。
// 语法检查查不出这种错，只有真跑一遍才看得见。
//
// 跑法： node tests/网页半边.mjs

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const 这里 = dirname(fileURLToPath(import.meta.url))
let 挂 = 0
const 报 = (标, 过, 细) => {
  if (!过) 挂++
  console.log((过 ? 'PASS  ' : 'FAIL  ') + 标 + (细 ? '  :: ' + 细 : ''))
}

let 工厂 = null
const 假window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => { 工厂 = { id, factory } },
  },
}

// 极简 React：只够这个组件用
const 状态槽 = []
let 槽位 = 0
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => {
    const i = 槽位++
    if (!(i in 状态槽)) 状态槽[i] = typeof init === 'function' ? init() : init
    return [状态槽[i], (v) => { 状态槽[i] = typeof v === 'function' ? v(状态槽[i]) : v }]
  },
  useEffect: () => { 槽位++ },
  useRef: (init) => {
    const i = 槽位++
    if (!(i in 状态槽)) 状态槽[i] = { current: init }
    return 状态槽[i]
  },
  useCallback: (fn) => { 槽位++; return fn },
}

const 源码 = fs.readFileSync(join(这里, '..', 'lib', 'client.js'), 'utf8')
const 运行 = new Function('window', 'fetch', 源码)
运行(假window, async () => ({ ok: false, json: async () => ({}) }))

报('模块能加载', Boolean(工厂), 工厂 && 工厂.id)
报('自注册 id 等于包名', Boolean(工厂) && 工厂.id === 'dsh-fish-home', String(工厂 && 工厂.id))

let 组件们 = new Map()
const 注册的槽 = []
const 导出 = 工厂.factory((名) => {
  if (名 === 'react') return React
  throw new Error('不认识的依赖：' + 名)
})
导出.apply({
  get: (名) => (名 === 'slots'
    ? {
      inject: (槽, fn) => { fn() },
      register: (元, 本体) => { 注册的槽.push(元.name); 组件们.set(元.name, 本体); return () => {} },
    }
    : undefined),
})
报('挂在设置页的那个槽上', 注册的槽.includes('settings.section'), 注册的槽.join('、'))
报('挂在侧栏底部动作槽上（id / order / label 都得对上）',
  注册的槽.includes('sidebar.footer.action'), 注册的槽.join('、'))
报('两个组件都注册上了',
  Boolean(组件们.get('settings.section')) && Boolean(组件们.get('sidebar.footer.action')))

槽位 = 0
状态槽.length = 0
try {
  const 树 = 组件们.get('settings.section')()
  报('设置区渲染不炸（TDZ / 写错变量名这种会当场红）', Boolean(树), '根节点 ' + String(树 && 树.type))
} catch (错误) {
  报('设置区渲染不炸（TDZ / 写错变量名这种会当场红）', false, String(错误 && 错误.message))
}

槽位 = 0
状态槽.length = 0
try {
  const 宽 = 组件们.get('sidebar.footer.action')({ wide: true })
  const 窄 = 组件们.get('sidebar.footer.action')({ wide: false })
  报('侧栏按钮宽排 / 窄栏都渲染得出来', Boolean(宽) && Boolean(窄),
    '宽 ' + String(宽 && 宽.type) + ' / 窄 ' + String(窄 && 窄.type))
  报('宽排带文字、窄栏只剩图标',
    宽.children.some((x) => x && x.children && x.children.includes('鱼鱼窝'))
    && !窄.children.some((x) => x && x.children && x.children.includes('鱼鱼窝')))
} catch (错误) {
  报('侧栏按钮渲染不炸', false, String(错误 && 错误.message))
}

console.log('')
console.log(挂 === 0 ? '全过' : ('挂了 ' + 挂 + ' 条'))
process.exit(挂 === 0 ? 0 : 1)
