// 本地测试脚本：模拟 iOS JavaScriptBridge 的 Widget 环境，打真实 API 验证模块
const fs = require('fs');
const assert = require('assert');

const SERVER = 'https://vidm.zhiaon.top/nzhyddtld';
const VERBOSE = process.argv.includes('--verbose');

// ---------- 模拟 Widget ----------
const store = new Map();
let httpCalls = [];

global.Widget = {
  http: {
    get: async (url, options) => {
      const t0 = Date.now();
      httpCalls.push({ method: 'GET', url, ms: 0 });
      try {
        const r = await fetch(url, {
          method: 'GET',
          headers: { ...{ 'User-Agent': 'ForwardWidgets/1.0.0' }, ...(options.headers || {}) },
          redirect: 'follow',
        });
        const text = await r.text();
        let data = text;
        try { data = JSON.parse(text); } catch (e) { /* 非 JSON */ }
        httpCalls[httpCalls.length - 1].ms = Date.now() - t0;
        httpCalls[httpCalls.length - 1].status = r.status;
        httpCalls[httpCalls.length - 1].bytes = text.length;
        if (!r.ok) throw new Error('HTTP error! status: ' + r.status);
        return { data, status: r.status };
      } catch (e) {
        httpCalls[httpCalls.length - 1].error = e.message;
        throw e;
      }
    },
    post: async (url, body, options) => {
      const t0 = Date.now();
      httpCalls.push({ method: 'POST', url, ms: 0 });
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'ForwardWidgets/1.0.0' },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        });
        const text = await r.text();
        let data = text;
        try { data = JSON.parse(text); } catch (e) { }
        httpCalls[httpCalls.length - 1].ms = Date.now() - t0;
        httpCalls[httpCalls.length - 1].status = r.status;
        httpCalls[httpCalls.length - 1].bytes = text.length;
        if (!r.ok) throw new Error('HTTP error! status: ' + r.status);
        return { data, status: r.status };
      } catch (e) {
        httpCalls[httpCalls.length - 1].error = e.message;
        throw e;
      }
    }
  },
  storage: {
    get: (k) => (store.has(k) ? store.get(k) : null),
    set: (k, v) => store.set(k, v),
    remove: (k) => store.delete(k),
  }
};

// ---------- 加载模块 ----------
// 兼容两种布局：开发时 ./widgets/江砚弹幕.js，发布仓库根目录 ./江砚弹幕.js
// 旧别名 logvar-danmu.js 已废弃，仅作最后兜底
const CANDIDATES = ['./widgets/江砚弹幕.js', './江砚弹幕.js', './widgets/logvar-danmu.js'];
const MODULE_PATH = process.env.MODULE_PATH || CANDIDATES.find(function (p) { return fs.existsSync(p); });
if (!MODULE_PATH) {
  console.error('找不到模块文件，试过：' + CANDIDATES.join(', '));
  process.exit(1);
}
console.log('加载模块：' + MODULE_PATH);
global.WidgetMetadata = undefined;
const code = fs.readFileSync(MODULE_PATH, 'utf8');
// eslint-disable-next-line no-eval
eval(code);

// ---------- 结果输出 ----------
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
const lastCalls = (n) => httpCalls.slice(-n);
function resetCalls() { httpCalls = []; }

function sample(list, n = 4) {
  return (list || []).slice(0, n).map(d => JSON.stringify(d).slice(0, 70)).join('  ');
}

// 真实片名/季/集参数 —— 这是 Forward 客户端透传给弹幕模块的常态
const EP = { server: SERVER, seriesName: '咒术回战 第2季', season: '2', episode: '1', segmentTime: '0', segmentSeconds: '180', segmentPad: '3' };
const EP2 = { server: SERVER, seriesName: '鬼灭之刃 灶门炭治郎 立志篇', season: '1', episode: '1', segmentTime: '0', segmentSeconds: '180', segmentPad: '3' };

(async () => {
  console.log('\n=== 元数据校验 ===');
  const M = global.WidgetMetadata;
  ok('id 存在', !!M.id);
  ok('requiredVersion', M.requiredVersion === '0.0.2', M.requiredVersion);
  const ids = M.modules.map(m => m.id).join(',');
  ok('模块 id 齐全', ['searchDanmu', 'getDetail', 'getComments'].every(i => ids.includes(i)), ids);
  ok('全部 type=danmu', M.modules.every(m => m.type === 'danmu'));
  ok('函数已定义', ['searchDanmu', 'getDetailById', 'getCommentsById', 'getDanmuWithSegmentTime'].every(f => typeof eval(f) === 'function'));
  ok('globalParams 数量', M.globalParams.length >= 3, M.globalParams.map(p => p.name).join(','));

  console.log('\n=== 1. 搜索 + 季数过滤 ===');
  resetCalls();
  const r1 = await searchDanmu({ server: SERVER, title: '咒术回战', type: 'tv', season: '2' });
  ok('返回 animes', Array.isArray(r1.animes) && r1.animes.length > 0, r1.animes.length + ' 条');
  ok('第1条是第2季', /第2季|第二季/.test(r1.animes[0].animeTitle), r1.animes[0].animeId + ' ' + r1.animes[0].animeTitle + ' (' + r1.animes[0].source + ')');
  resetCalls();
  await searchDanmu({ server: SERVER, title: '咒术回战', type: 'tv', season: '2' });
  ok('重复搜索命中缓存（0 次请求）', httpCalls.length === 0, httpCalls.length + ' 次请求');

  console.log('\n=== 2. 电影类型排序 ===');
  resetCalls();
  const r2 = await searchDanmu({ server: SERVER, title: '鬼灭之刃', type: 'movie' });
  ok('Top1 是剧场版', /剧场版|无限列车|无限城/.test(r2.animes[0].animeTitle), r2.animes[0].animeTitle + ' (' + r2.animes[0].source + ')');

  console.log('\n=== 3. 系列名 + 标题噪声清洗 ===');
  const r3 = await searchDanmu({ server: SERVER, type: 'tv', season: '3', seriesName: '进击的巨人', title: '进击的巨人 第3季 (2018)【4K HDR】中配版' });
  ok('命中第3季', r3.animes.length > 0, r3.animes.slice(0, 3).map(a => a.animeId + ':' + a.animeTitle).join(' | '));

  console.log('\n=== 4. 分集列表 ===');
  resetCalls();
  const eps = await getDetailById({ server: SERVER, animeId: '831278', season: '2' });
  ok('返回 23 集', eps.length === 23, eps.length + ' 集');
  ok('字段齐全', ['seasonId', 'episodeId', 'episodeTitle', 'episodeNumber', 'airDate', 'url'].every(k => k in eps[0]));

  console.log('\n=== 5. 整集弹幕加载（match 现场换新鲜 ID）===');
  resetCalls();
  const t0 = Date.now();
  const allRes = await getCommentsById({ ...EP, segmentTime: '0' });
  const all = allRes.comments;
  console.log('  加载耗时 ' + (Date.now() - t0) + 'ms');
  ok('返回 {count, comments} 对象', !!allRes && typeof allRes === 'object' && !Array.isArray(allRes) && Array.isArray(allRes.comments));
  ok('count 与 comments.length 一致', allRes.count === allRes.comments.length, 'count=' + allRes.count);
  ok('全量返回非空', all.length > 0, all.length + ' 条');
  ok('条目格式 {p,m}', all.every(d => typeof d.p === 'string' && typeof d.m === 'string'), sample(all, 2));
  ok('已按时间升序', all.every((d, i) => i === 0 || parseFloat(all[i - 1].p) <= parseFloat(d.p)));
  ok('跨桥体积 < 3MB', JSON.stringify(all).length < 3145728, (JSON.stringify(all).length / 1024).toFixed(1) + 'KB');
  // 多来源合并会让请求数远超 8（match×N + comment×3 + bangumi×3 + 重试），
  // 所以扫全量而不是 lastCalls(8)
  ok('走了 match 反查', httpCalls.some(c => c.method === 'POST' && c.url.includes('/match')),
    httpCalls.map(c => c.method).join(','));
  console.log('  有效弹幕: ' + all.length + ' 条，请求 ' + httpCalls.length + ' 次' +
    '（POST ' + httpCalls.filter(c => c.method === 'POST').length + ' 次）');
  console.log('  请求链:', lastCalls(8).map(c => c.method + (c.url.split('/api/')[1] || '').split('?')[0] + ' ' + c.ms + 'ms').join('  '));

  console.log('\n=== 6. 分段接口：只回当前窗口 + 缓存零网络 ===');
  resetCalls();
  const seg0 = (await getDanmuWithSegmentTime({ ...EP, segmentTime: '0' })).comments;
  ok('只含前 180 秒', seg0.length > 0 && seg0.every(d => parseFloat(d.p) < 180), seg0.length + ' 条');
  ok('分段数 < 全量数', seg0.length < all.length, seg0.length + ' < ' + all.length);
  resetCalls();
  const t1 = Date.now();
  const seg0b = (await getDanmuWithSegmentTime({ ...EP, segmentTime: '0' })).comments;
  ok('缓存命中 0 次请求', httpCalls.length === 0);
  ok('分段查询耗时', (Date.now() - t1) < 50, (Date.now() - t1) + 'ms');
  ok('结果一致', JSON.stringify(seg0) === JSON.stringify(seg0b));

  console.log('\n=== 7. 时间点弹幕（播放进度推进）===');
  resetCalls();
  const mid = (await getDanmuWithSegmentTime({ ...EP, segmentTime: '900' })).comments;
  ok('900s 窗口 [897,1080)', mid.every(d => { const t = parseFloat(d.p); return t >= 897 && t < 1080; }), mid.length + ' 条');
  console.log('  示例:', sample(mid, 3));

  console.log('\n=== 8. 窗口全覆盖验证（不丢弹幕）===');
  const full = await _loadEpisode({ ...EP });
  ok('加载成功', !!full, full ? full.items.length + ' 条' : 'null');
  const SEG = 180, PAD = 3;
  let maxT = 0;
  for (let i = 0; i < full.times.length; i++) if (full.times[i] > maxT) maxT = full.times[i];
  const covered = new Set();
  const winHits = [];
  for (let t = 0; t < Math.ceil(maxT); t += SEG) {
    const win = _window(String(t), String(SEG), String(PAD));
    winHits.push([win.start, win.end]);
    full.times.forEach((tt, i) => { if (tt >= win.start && tt < win.end) covered.add(i); });
  }
  ok('所有弹幕都被至少一个窗口覆盖', covered.size === full.times.length, covered.size + '/' + full.times.length);
  ok('窗口数合理', winHits.length > 0 && winHits.length < 1000, winHits.length + ' 个窗口');
  console.log('  窗口示例:', JSON.stringify(winHits.slice(0, 4)));

  console.log('\n=== 9. 二分切片性能 ===');
  const big = await _loadEpisode({ ...EP2 });
  ok('第二集加载成功', !!big, big ? big.items.length + ' 条' : 'null');
  if (big) {
    const perfT0 = Date.now();
    for (let i = 0; i < 5000; i++) _sliceWindow(big, _window(String((i % 4000)), '180', '3'));
    ok('5000 次窗口切片耗时', (Date.now() - perfT0) < 300, (Date.now() - perfT0) + 'ms');
  }

  console.log('\n=== 10. 去重统计（多来源合并 vs 单一来源）===');
  console.log('  合并 ' + full.sources + ' 来源：原始 ' + full.total + ' → 有效 ' + full.items.length +
    '（丢弃 ' + full.dropped + '，去重率 ' + (full.dropped / full.total * 100).toFixed(1) + '%）');
  ok('items/times 下标对齐', full.times.length === full.items.length &&
    full.times.every((t, i) => Math.abs(parseFloat(full.items[i].p) - t) < 1e-6));
  // 去重率 >90% 只对单一来源成立；合并时跨平台重复会被合理丢弃，所以单独跑一次单一来源校验。
  // 缓存键不含 mergeSources，必须先清掉整集缓存，否则拿到的还是合并结果
  for (const k of Array.from(store.keys())) if (k.startsWith('zldm_cm_')) store.delete(k);
  const single = await _loadEpisode({ ...EP, mergeSources: '0' });
  console.log('  单一来源：原始 ' + single.total + ' → 有效 ' + single.items.length +
    '（丢弃 ' + single.dropped + '，去重率 ' + (single.dropped / single.total * 100).toFixed(1) + '%）');
  ok('单一来源有效弹幕 > 90% 原始量', single.items.length > single.total * 0.9,
    (single.items.length / single.total * 100).toFixed(1) + '%');
  ok('单一来源 items/times 下标对齐', single.times.length === single.items.length &&
    single.times.every((t, i) => Math.abs(parseFloat(single.items[i].p) - t) < 1e-6));
  ok('合并后条数 >= 单一来源（多来源确实更全）', full.items.length >= single.items.length,
    full.items.length + ' >= ' + single.items.length);

  console.log('\n=== 11. 缓存淘汰 ===');
  const before = Array.from(store.keys()).filter(k => k.startsWith('zldm_cm_')).length;
  await _loadEpisode({ ...EP, maxCachedEpisodes: '1' });
  await _loadEpisode({ ...EP2, maxCachedEpisodes: '1' });
  await _loadEpisode({ ...EP, maxCachedEpisodes: '1' });
  const idx = store.get('zldm_idx');
  ok('淘汰队列长度受控', idx.length <= 1, idx.length + ' 条: ' + idx.map(x => x.k).join(','));
  ok('最新访问在队首', /zldm_cm_/.test(idx[0].k), idx[0].k);
  ok('整集缓存 key 数量受控', Array.from(store.keys()).filter(k => k.startsWith('zldm_cm_')).length <= 1,
    Array.from(store.keys()).filter(k => k.startsWith('zldm_cm_')).map(k => k.slice(-12)).join(','));

  console.log('\n=== 12. 失败冷却（上游 404 不炸播放）===');
  resetCalls();
  const dead = await getCommentsById({ server: SERVER, commentId: '99999999999', segmentTime: '0' });
  ok('无效 commentId 返回空弹幕不抛错', !!dead && dead.count === 0 && dead.comments.length === 0, 'count=' + dead.count);
  resetCalls();
  const dead2 = await getCommentsById({ server: SERVER, commentId: '99999999999', segmentTime: '0' });
  ok('冷却期内 0 次请求', httpCalls.length === 0, httpCalls.length + ' 次');
  ok('冷却记录已写入', !!store.get('zldm_fl_' + 'zldm_cm_' + 'id:99999999999'.length) || Array.from(store.keys()).some(k => k.startsWith('zldm_fl_')));

  console.log('\n=== 13. 异常路径 ===');
  resetCalls();
  try { await searchDanmu({ server: SERVER, title: '     ' }); ok('空关键词返回空列表不抛错', true); }
  catch (e) { ok('空关键词', false, e.message); }
  try { await getCommentsById({ server: SERVER, segmentTime: '0' }); ok('缺 commentId 且无法匹配应抛错', false); }
  catch (e) { ok('缺 commentId 抛错', /无法确定弹幕标识/.test(e.message), e.message); }

  console.log('\n=== 网络请求统计（最近 30 条）===');
  httpCalls.slice(-30).forEach((c) => console.log('  ' + (c.error ? '❌' : '✅') + ' ' + c.method + ' ' +
    (c.url.split(SERVER)[1] || c.url) + '  ' + (c.bytes ? (c.bytes / 1024).toFixed(0) + 'KB' : '') + '  ' + c.ms + 'ms' +
    (c.status ? ' [' + c.status + ']' : '') + (c.error ? '  ERR:' + c.error : '')));

  console.log('\n' + '='.repeat(56));
  console.log('  通过 ' + pass + ' / ' + (pass + fail) + (fail ? '   失败 ' + fail : ''));
  console.log('='.repeat(56));
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('❌ 测试中断:', e);
  console.log('最近请求:', JSON.stringify(httpCalls.slice(-5), null, 2));
  process.exit(2);
});
