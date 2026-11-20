// 解析她在自然回复里已经明确说出的身体意图。
// 这是工具调用漏掉时的本地兜底，不把解析结果写回会话，也不生成可见命令。

const DESTINATIONS = [
  ['garden', /(?:庭院|院子|院里|外面|院外)/],
  ['pond', /(?:池塘|鱼塘|池边)/],
  ['field', /(?:菜田|花田|田地|菜园|田里)/],
  ['kitchen', /厨房/],
  ['bathroom', /(?:洗漱区|卫生间|浴室)/],
  ['bedroom', /卧室/],
  ['living', /客厅/],
  ['study', /(?:书房|书桌)/],
  ['studio', /(?:画画区|画架)/],
  ['observatory', /(?:观星区|望远镜)/],
  ['indoor', /(?:房间|屋里|屋内|室内|家里)/],
]

const SEATS = [
  ['seat-extra-beanbag', /(?:懒人沙发|豆袋|软软的沙发)/],
  ['living-sofa', /沙发/],
  ['courtyard-swing', /秋千/],
  ['courtyard-picnic', /野餐垫|野餐/],
  ['courtyard-lounger', /躺椅/],
  ['courtyard-stool-1', /石凳/],
  ['seat-WindowSeat', /藤椅/],
  ['study-reading-chair', /(?:椅子|椅)/],
]

// 只收可直接执行的眼下动作。转述、猜测、回忆和疑问保持为聊天。
const REJECT = /(?:不要|别|不想|不去|不回|不会|不能|没(?:有)?|不是|无需|不用|如果|要不要|建议|请你|你可以|你应该|让你|昨天|刚才|以前|上次|等会|待会|明天|以后|想象|梦里|假装|只是说|可以吗|好吗)/
const LEAD = /^(?:[（(] ?)?(?:那我|我(?:已经|正在|现在|这就|先|正|就)?|那就|这就|现在就|马上|先)?\s*/
const WALK = /^(?:回(?:到|去)?|去|走(?:到|去)|前往|进(?:到|入)?)\s*/
const SIT = /^(?:去)?(?:在|到)?(?:坐(?:到|在|上)?|躺(?:在|到|上)?|窝在|荡)\s*/
const SIT_TAIL = /^(?:的)?(?:上|里|边|旁|中)?(?:坐|躺|窝|歇|休息|待着)/

export function 识别身体意图(text) {
  const sentences = String(text || '').match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || []
  for (const raw of sentences) {
    if (/[？?“”「」『』"`]/.test(raw)) continue
    const sentence = raw.trim().replace(/[。！？!?；;]$/, '')
    const clause = sentence.split(/[，,、：:]/,1)[0].trim()
    if (!clause || REJECT.test(clause)) continue
    const body = clause.replace(LEAD, '')
    const action = SIT.exec(body)
    const seatText = action ? body.slice(action[0].length) : body.replace(/^(?:去|在)/, '')
    for (const [id, pattern] of SEATS) {
      const seat = pattern.exec(seatText)
      if (seat?.index === 0 && (action || SIT_TAIL.test(seatText.slice(seat[0].length)))) {
        return { key: `sit:${id}`, command: 'sit', args: { id }, matched: sentence }
      }
    }
    const movement = WALK.exec(body)
    if (!movement) continue
    const target = body.slice(movement[0].length)
    for (const [dest, pattern] of DESTINATIONS) {
      if (pattern.exec(target)?.index === 0) return { key: `move:${dest}`, command: 'moveTo', args: { dest }, matched: sentence }
    }
  }
  return null
}