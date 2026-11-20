import assert from 'node:assert/strict'
import test from 'node:test'
import { 识别身体意图 } from '../lib/body-intent.mjs'

test('识别回房间', () => {
  assert.deepEqual(识别身体意图('我先回房间，等会儿再和你聊。'), {
    key: 'move:indoor', command: 'moveTo', args: { dest: 'indoor' }, matched: '我先回房间，等会儿再和你聊',
  })
})

test('识别坐椅子和沙发', () => {
  assert.equal(识别身体意图('我去椅子上坐着。')?.args.id, 'study-reading-chair')
  assert.equal(识别身体意图('我已经窝在沙发里了。')?.args.id, 'living-sofa')
})

test('识别坐具开头的明确状态句和去庭院', () => {
  assert.equal(识别身体意图('椅子上坐着等你回来。')?.args.id, 'study-reading-chair')
  assert.equal(识别身体意图('我去院子里看看。')?.args.dest, 'garden')
})

test('否定句和对用户的建议不触发', () => {
  assert.equal(识别身体意图('我不回房间，先陪着你。'), null)
  assert.equal(识别身体意图('你可以回房间休息。'), null)
  assert.equal(识别身体意图('要不要坐在椅子上？'), null)
  assert.equal(识别身体意图('我觉得回房间也不错。'), null)
  assert.equal(识别身体意图('我想坐在沙发上，但还是陪你聊吧。'), null)
})
