// Fallback for rooms predating the draw summary in the response.
// One entry per changed card; cards already at pearl only contribute to totals.
const rarityRank = {'3★':0,'4★':1,'5★':2,SP:3,hidden:4};
const finishNames = ['普通','银箔','镀金','珠光'];

export function summarizeDraw(results = []) {
  const changes = new Map();
  const repeats = {count:0, converted:0, dust:0, starlight:0};
  for (const row of results) {
    if (!row.first) repeats.count++;
    if (row.converted) {
      repeats.converted++;
      repeats.dust += row.dust || 0;
      repeats.starlight += row.starlight || 0;
    } else if (row.id && (row.first || row.upgrade)) {
      const previous = changes.get(row.id);
      changes.set(row.id,{...row,first:!!(previous?.first || row.first),upgraded:!!(previous?.upgraded || row.upgrade)});
    }
  }
  return {changes:[...changes.values()].sort((a,b)=>(rarityRank[b.rarity]??0)-(rarityRank[a.rarity]??0)||Number(b.first)-Number(a.first)),repeats};
}

export function repeatDrawText({count,converted,dust,starlight}) {
  if (!count) return '';
  const intro = `重复 ${count} 张`;
  if (!converted) return intro+'。';
  const prefix = converted===count ? intro : `${intro}，其中 ${converted} 张已分解`;
  const rewards = [dust>0 && `${dust} 星尘`,starlight>0 && `${starlight} 星辉`].filter(Boolean);
  return rewards.length ? `${prefix}，${converted===count?'分解获得':'获得'} ${rewards.join('、')}。` :
    `${prefix}${converted===count?'，已全部分解':''}。`;
}

export function drawSummaryText(results, catalog = []) {
  const {changes,repeats} = summarizeDraw(results);
  const first = changes.filter(row=>row.first).length;
  const upgraded = changes.length-first;
  const cards = new Map(catalog.map(card=>[card.id,card]));
  const names = changes.slice(0,4).map(row=>{
    const card = row.card || cards.get(row.id);
    const title = [card?.title || row.title || row.id,card?.subtitle].filter(Boolean).join('·').slice(0,28);
    const finish = finishNames[row.finish];
    const quality = (row.upgraded || !row.first) && finish ? '升至'+finish : '';
    const hidden = row.rarity==='hidden' && row.starlight>0 ? `附赠 ${row.starlight} 星辉` : '';
    return [title,quality,hidden].filter(Boolean).join('·');
  });
  const changesText = changes.length ?
    `${[first&&`新卡 ${first} 张`,upgraded&&`升级 ${upgraded} 张`].filter(Boolean).join('、')}：${names.join('、')}${changes.length>names.length?'等':''}。` : '';
  return repeatDrawText(repeats)+changesText;
}
