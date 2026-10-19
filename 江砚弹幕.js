/**
 * LogVar 弹幕API 弹幕模块（DandanPlay v2 兼容协议）
 *
 * 数据源: https://vidm.zhiaon.top/nzhyddtld
 *   GET  /api/v2/search/anime?keyword=<kw>        搜索番剧
 *   GET  /api/v2/bangumi/:animeId                 分集列表
 *   GET  /api/v2/comment/:commentId?format=json   整集弹幕
 *   POST /api/v2/match   {fileName:"..."}         按文件名反查 episodeId（兜底）
 *
 * 为什么"准确且快"
 *   1) 搜索 / 分集 / 整集弹幕全部落 Widget.storage，重复进片头不重复请求；
 *   2) 本地只保留 {p,m,cid} 瘦字段并排序，另存一份纯数字时间数组；
 *   3) 分段定位用二分查找 [start,end)，14000 条弹幕的窗口切分是 O(log n)；
 *   4) 只把当前分段（默认 180 秒）回给客户端，绝不把 1.3MB 整集直发；
 *   5) 分段基线固定为 floor(t/seg)*seg，播放器抖动也不会跨段错位，
 *      再用 pad 秒前向重叠，边界弹幕不丢；
 *   6) 搜索侧做 类型/季数 过滤 + 相关性打分，dandan 合并源优先，
 *      剔除"解说/合集/音乐会/臻享"这类注定没弹幕的条目；
 *   7) 弹幕侧剔除 空文本 / 时间不可解析 / (时间+参数+文本) 完全重复 的脏数据；
 *   8) commentId 缺失时用 match 接口按 "系列名 SxxEyy" 文件名反查。
 *
 * 协议依据: InchStudio/ForwardWidgets
 *   widgets/segmentDanmuExample.js + README「弹幕分片加载流程」
 */

// ============================ 元数据 ============================

WidgetMetadata = {
  id: "zhiaon.logvar.danmu",
  title: "江砚弹幕",
  version: "1.0.0",
  requiredVersion: "0.0.2",
  description: "江砚弹幕 - LogVar 弹幕API（DandanPlay 兼容协议）分段弹幕，本地缓存 + 二分定位，快速精准。",
  author: "江砚",
  site: "https://vidm.zhiaon.top/nzhyddtld",

  globalParams: [
    {
      name: "server",
      title: "弹幕服务器",
      type: "input",
      value: "https://vidm.zhiaon.top/nzhyddtld",
      description: "LogVar 弹幕API 基地址，末尾不带 /",
      placeholders: [
        { title: "LogVar（vidm.zhiaon.top）", value: "https://vidm.zhiaon.top/nzhyddtld" },
        { title: "弹弹play 官方", value: "https://api.dandanplay.net" }
      ]
    },
    {
      name: "segmentSeconds",
      title: "分段时长(秒)",
      type: "input",
      value: "180",
      description: "每次向客户端返回的弹幕时间窗口长度，300 秒以上更省请求"
    },
    {
      name: "segmentPad",
      title: "分段前向重叠(秒)",
      type: "input",
      value: "3",
      description: "窗口起点向前多取几秒，避免边界弹幕丢失"
    },
    {
      name: "cacheHours",
      title: "缓存时长(小时)",
      type: "input",
      value: "24",
      description: "分集列表与整集弹幕的本地缓存有效期"
    },
    {
      name: "maxCachedEpisodes",
      title: "最多缓存集数",
      type: "input",
      value: "5",
      description: "整集弹幕缓存条数上限，超出淘汰最久未使用的（每集约 0.5~1MB）"
    }
  ],

  modules: [
    {
      // id 固定，Forward 靠它识别"搜索弹幕"入口
      id: "searchDanmu",
      title: "搜索弹幕",
      functionName: "searchDanmu",
      type: "danmu",
      params: []
    },
    {
      // id 固定，返回番剧分集列表，供客户端匹配季集
      id: "getDetail",
      title: "获取分集",
      functionName: "getDetailById",
      type: "danmu",
      params: []
    },
    {
      // id 固定，主弹幕入口
      id: "getComments",
      title: "获取弹幕",
      functionName: "getCommentsById",
      type: "danmu",
      params: []
    },
    {
      // id 固定，播放进度推进时按时刻取分段弹幕
      id: "getDanmuWithSegmentTime",
      title: "获取指定时刻弹幕",
      functionName: "getDanmuWithSegmentTime",
      type: "danmu",
      params: []
    }
  ]
};

// ============================ 常量 ============================

var TAG = "[LogVarDanmu]";
var DEFAULT_SERVER = "https://vidm.zhiaon.top/nzhyddtld";
var DEFAULT_SEGMENT = 180;
var DEFAULT_PAD = 3;
var DEFAULT_CACHE_HOURS = 24;
var DEFAULT_MAX_EPISODES = 5;
var SEARCH_CACHE_HOURS = 12;      // 搜索关键词结果缓存（与整集缓存分开，更宽松）
var SEARCH_TOP_N = 30;            // 搜索结果最多返回条数
var USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
                 "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// 搜索索引键前缀
var K_SEARCH = "zldm_sa_";        // 搜索关键词
var K_BANGUMI = "zldm_bg_";       // 番剧分集
var K_COMMENT = "zldm_cm_";       // 整集弹幕
var K_IDX = "zldm_idx";           // 缓存淘汰队列

// 该服务上游弹幕源会间歇性失效：同一路径上一刻还是 1.3MB 弹幕，下一刻就 404 + 空 comments。
// 失败也缓存一小段时间，避免播放中反复撞墙刷请求；到期后自动重试。
var K_FAIL = "zldm_fl_";
var FAIL_TTL = 5 * 60;

// 实测结论：本服务的 episodeId 是"当前缓存"的临时编号，缓存淘汰后 ID 立刻失效（服务端日志：
//   error: [cache] No URL found for ID: 13126 / [LogVar-API] Comment with ID 13126 not found）。
// 所以不能盲信客户端透传的 commentId，必须用 /api/v2/match 按文件名现场换一个新 ID。
var MATCH_CANDIDATES = 4;

// 弹幕类型判定：中文来源(tencent/youku/bilibili)与 dandan 体系混用，两种词表都要认
var MOVIE_WORDS = ["movie", "电影", "剧场版", "奇幻片", "完结篇"];
var TV_WORDS = ["tvseries", "tv", "动漫", "2d动漫", "电视剧", "番剧", "web", "ova"];
var JUNK_WORDS = ["解说", "合集", "音乐会", "交响", "速通", "臻享", "带你听", "舞台剧",
                  "广播剧", "纪录片", "同人", "音游", "游戏", "盘点", "吐槽", "reaction",
                  "remake", "舞台", "特典"];

// ============================ 小工具 ============================

/** 全局参数取值：globalParams 会合并进 params */
function _cfg(params, name, fallback) {
  var v = params && params[name];
  if (v === undefined || v === null || v === "") return fallback;
  return v;
}

/** 字符串 → 正数，非法值回退默认 */
function _num(v, fallback) {
  var n = parseFloat(v);
  return isFinite(n) && n > 0 ? n : fallback;
}

/** 服务器基地址，去掉尾部斜杠，防双重斜杠导致 404 */
function _server(params) {
  var s = String(_cfg(params, "server", DEFAULT_SERVER) || DEFAULT_SERVER).trim();
  while (s.length > 0 && s.charAt(s.length - 1) === "/") s = s.slice(0, -1);
  return s;
}

/** 统一请求头：带 UA + Referer，LogVar 的 CDN/缓存识别更稳 */
function _headers(params) {
  var base = _server(params);
  return {
    "User-Agent": USER_AGENT,
    "Accept": "application/json",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": base + "/",
    "Origin": base
  };
}

/** djb2 哈希，给关键词做稳定缓存 key（不依赖 crypto） */
function _hash(str) {
  var h = 5381;
  for (var i = 0; i < str.length; i++) {
    h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

function _now() {
  return Math.floor(Date.now() / 1000);
}

/** 统一 HTTP 错误抛出，保留状态码便于在 App 测试工具里定位 */
function _unwrap(resp, what) {
  if (!resp) throw new Error(what + ": 无响应");
  if (resp.status && resp.status >= 400) {
    throw new Error(what + ": HTTP " + resp.status);
  }
  return resp.data;
}

// ============================ 本地缓存 ============================

/** Widget.storage 全部 try/catch，避免个别 key 损坏炸掉整个模块 */
function _sget(key) {
  try { return Widget.storage.get(key); } catch (e) { return null; }
}

function _sset(key, value) {
  try { Widget.storage.set(key, value); }
  catch (e) { console.error(TAG, "缓存写入失败", key, e); }
}

function _sdel(key) {
  try { if (key) Widget.storage.remove(key); } catch (e) { /* 忽略 */ }
}

/** 读缓存并校验 TTL，过期自动清 */
function _scache(key, ttlSeconds) {
  var rec = _sget(key);
  if (!rec || typeof rec !== "object") return null;
  if (!_nowOk(rec.t, ttlSeconds)) { _sdel(key); return null; }
  return rec;
}

function _nowOk(savedAt, ttlSeconds) {
  return typeof savedAt === "number" && (_now() - savedAt) < ttlSeconds;
}

/** 缓存淘汰：FIFO 按最近访问排序，超量删除最久的整集弹幕。入参 key 已是完整存储键 */
function _touch(key, maxEpisodes) {
  try {
    var idx = _sget(K_IDX);
    if (!Array.isArray(idx)) idx = [];
    var kept = [];
    for (var i = 0; i < idx.length; i++) {
      if (idx[i] && idx[i].k && idx[i].k !== key) kept.push(idx[i]);
    }
    kept.unshift({ k: key, t: _now() });
    if (kept.length > maxEpisodes) {
      for (var j = maxEpisodes; j < kept.length; j++) _sdel(kept[j].k);
      kept.length = maxEpisodes;
    }
    _sset(K_IDX, kept);
  } catch (e) { /* 淘汰失败不影响主流程 */ }
}

// ============================ 标题规范化 ============================

/**
 * 把片名压成搜索关键词。
 * Forward 传来的 title 往往带 (年份)【来源】第2季 4K 中配版 之类噪声，
 * 直接拿去搜 LogVar 会命中无关条目，必须先洗干净。
 */
function _keyword(raw) {
  if (raw === undefined || raw === null) return "";
  var t = String(raw);
  // 1) 各种括号内容：年份、来源、画幅标注
  t = t.replace(/【[^】]*】/g, " ");
  t = t.replace(/〔[^〕]*〕/g, " ");
  t = t.replace(/（[^）]{0,40}）/g, " ");
  t = t.replace(/\([^)]{0,40}\)/g, " ");
  // 2) 尾部来源标记（"from dandan&bahamut"）
  t = t.replace(/from\s+[a-z0-9&._-]+/gi, " ");
  // 3) 季 / 话 标记（阿拉伯 + 中文数字）
  t = t.replace(/第\s*[0-9]+\s*[季部]/g, " ");
  t = t.replace(/第\s*[一二三四五六七八九十]+\s*[季部]/g, " ");
  t = t.replace(/[0-9]+\s*季/g, " ");
  t = t.replace(/第\s*[0-9]+\s*[话集]/g, " ");
  t = t.replace(/第\s*[一二三四五六七八九十]+\s*[话集]/g, " ");
  // 4) 独立年份
  t = t.replace(/(?:19|20)\d{2}/g, " ");
  // 5) 画质 / 编码 / 音轨 / 画幅
  t = t.replace(/\b(8k|4k|uhd|2160p|1080p|720p|480p|x264|x265|hevc|h265|h264|av1|aac|ac3|ddp|dtshd|hdr10|hdr|dvdrip|bdrip|web-dl|hdtv|webrip|remux)\b/gi, " ");
  t = t.replace(/\b(\d+\.\d|s\d{1,2})\b/g, " ");
  t = t.replace(/(中配|粤配|国语|日语|双语|简中|繁体|台配|高清|超清)/g, " ");
  // 6) SxxEyy 编号（match 接口用，搜关键词时要剔除）
  t = t.replace(/\bs\d{1,2}e\d{1,3}\b/gi, " ");
  // 7) 标点与多余空白
  t = t.replace(/[-–—_/\\|:，,.。・·!！?？*"']+|from\s+/gi, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/** 从 params 里挑最合适的搜索关键词：系列名 > 标题 > 集名 */
function _pickKeyword(params) {
  var c = _keyword(params.seriesName);
  if (c) return c;
  c = _keyword(params.title);
  if (c) return c;
  c = _keyword(params.episodeName);
  if (c) return c;
  return _keyword(params.link || "");
}

/** 季数匹配：中文数字互转，兼容"第2季 / 第二季 / 2季 / Season 2" */
function _seasonHit(anime, season) {
  if (!season) return false;
  var s = String(season).trim();
  if (!s) return false;
  var hay = String(anime.animeTitle || "") + " " + _aliases(anime);
  var num = parseInt(s, 10);
  var cands = [s];
  if (isFinite(num) && num > 0) cands.push(String(_toChinese(num)));
  for (var i = 0; i < cands.length; i++) {
    var c = cands[i];
    var patterns = ["第" + c + "季", "第" + c + "部", "第" + c + "期",
                    c + "季", c + "部",
                    "season " + c, "season" + c, "s" + c];
    for (var j = 0; j < patterns.length; j++) {
      if (hay.toLowerCase().indexOf(patterns[j].toLowerCase()) >= 0) return true;
    }
  }
  return false;
}

function _aliases(anime) {
  var al = anime.aliases;
  if (!al) return "";
  if (typeof al === "string") return al;
  if (Array.isArray(al)) return al.join(" ");
  return "";
}

var CN_DIGIT = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

function _toChinese(n) {
  n = Math.floor(Math.abs(parseInt(n, 10) || 0));
  if (n <= 0) return "";
  if (n < 10) return CN_DIGIT[n];
  if (n === 10) return "十";
  if (n < 20) return "十" + CN_DIGIT[n % 10];
  if (n < 100) return CN_DIGIT[Math.floor(n / 10)] + "十" + (n % 10 ? CN_DIGIT[n % 10] : "");
  return String(n);
}

/** 是否剧场版/电影类 */
function _isMovie(anime) {
  var t = String(anime.type || "").toLowerCase();
  var desc = String(anime.typeDescription || "");
  var title = String(anime.animeTitle || "");
  if (t === "movie" || t === "电影") return true;
  var hay = (desc + " " + title).toLowerCase();
  for (var i = 0; i < MOVIE_WORDS.length; i++) {
    var w = MOVIE_WORDS[i];
    if (w === "movie" || w === "电影") continue;
    if (hay.indexOf(w.toLowerCase()) >= 0) return true;
  }
  return false;
}

/** 命中"解说/合集"等无弹幕内容的垃圾条目 */
function _isJunk(anime) {
  var hay = String(anime.animeTitle || "") + " " + _aliases(anime);
  for (var i = 0; i < JUNK_WORDS.length; i++) {
    if (hay.toLowerCase().indexOf(JUNK_WORDS[i].toLowerCase()) >= 0) return true;
  }
  return false;
}

/**
 * 搜索结果打分排序。
 * 目的：LogVar 会把 7 个源合并返回 40+ 条，顺序毫无意义，
 *      必须按"类型相符 → 标题精确 → 弹幕量 → 来源合并度 → 评分"排。
 */
function _rank(animes, ctx) {
  var wantMovie = ctx.type === "movie";
  var kw = ctx.keyword.toLowerCase();
  var scored = [];
  for (var i = 0; i < animes.length; i++) {
    var a = animes[i];
    if (!a || !a.animeId) continue;

    var s = 0;
    var title = String(a.animeTitle || "");
    var low = title.toLowerCase();
    var src = String(a.source || "").toLowerCase();

    // 类型相符性（权重最高）
    var movie = _isMovie(a);
    if (wantMovie) s += movie ? 120 : -80;
    else s += movie ? -80 : 40;

    // 标题质量
    if (kw) {
      if (low.indexOf(kw) >= 0) s += 60;
      if (low === kw) s += 40;
      if (_aliases(a).toLowerCase().indexOf(kw) >= 0) s += 10;
    }

    // 弹幕量：episodeCount 越大越可能命中真实剧集
    var ec = parseInt(a.episodeCount, 10);
    if (isFinite(ec) && ec > 0) s += Math.min(30, Math.round(Math.log(ec + 1) * 12));

    // 来源：dandan 合并源弹幕最全；纯国产平台源偏冷门
    if (src.indexOf("dandan") >= 0 && src.indexOf("bahamut") >= 0) s += 25;
    else if (src.indexOf("dandan") >= 0) s += 20;
    else if (src === "bahamut") s += 12;
    else if (src === "tencent" || src === "youku" || src === "bilibili") s += 4;
    else s += 8;

    // 评分
    var r = parseFloat(a.rating);
    if (isFinite(r) && r > 0) s += Math.min(20, r * 2);

    if (_isJunk(a)) s -= 100;
    if (a.isFavorited) s += 5;

    scored.push({ item: a, score: s });
  }
  scored.sort(function (x, y) { return y.score - x.score; });

  var out = [];
  for (var k = 0; k < scored.length; k++) {
    var it = scored[k].item;
    // 只回传客户端需要的字段，减小跨桥传输体积
    out.push({
      animeId: String(it.animeId),
      bangumiId: it.bangumiId,
      animeTitle: String(it.animeTitle || ""),
      type: it.type,
      typeDescription: it.typeDescription,
      imageUrl: it.imageUrl,
      source: it.source,
      rating: it.rating,
      episodeCount: it.episodeCount,
      startDate: it.startDate,
      aliases: it.aliases
    });
    if (out.length >= SEARCH_TOP_N) break;
  }
  return out;
}

// ============================ 1. 搜索弹幕 ============================

/**
 * 搜索弹幕：按系列名调 LogVar 搜索接口，过滤类型/季数，打分排序后返回。
 *
 * 缓存：关键词 → 原始搜索列表（不预先按季过滤，换个季还能复用同一份缓存）。
 */
async function searchDanmu(params) {
  try {
    var server = _server(params);
    var season = params.season !== undefined && params.season !== null
      ? String(params.season) : "";
    var keyword = _pickKeyword(params);
    if (!keyword) {
      console.log(TAG, "搜索关键词为空，返回空列表");
      return { animes: [] };
    }

    var ttl = SEARCH_CACHE_HOURS * 3600;
    var key = K_SEARCH + _hash(keyword + "|" + season);
    var rec = _scache(key, ttl);

    if (!rec || !Array.isArray(rec.list)) {
      var url = server + "/api/v2/search/anime?keyword=" + encodeURIComponent(keyword);
      var data = _unwrap(await Widget.http.get(url, { headers: _headers(params) }), "搜索弹幕");
      if (!data) return { animes: [] };
      if (data.success === false) {
        throw new Error("搜索弹幕失败: " + (data.errorMessage || "服务返回失败"));
      }
      rec = { t: _now(), list: Array.isArray(data.animes) ? data.animes : [] };
      _sset(key, rec);
      console.log(TAG, "搜索", keyword, "命中", rec.list.length, "条，已缓存");
    }

    // 季数过滤：没有命中就退回全量，宁可多给用户选，不可直接空手
    var pool = rec.list;
    if (season) {
      var hit = [];
      for (var i = 0; i < pool.length; i++) {
        if (_seasonHit(pool[i], season)) hit.push(pool[i]);
      }
      if (hit.length) {
        console.log(TAG, "第" + season + "季命中", hit.length, "条");
        pool = hit;
      }
    }

    return { animes: _rank(pool, { type: params.type, keyword: keyword }) };
  } catch (e) {
    console.error(TAG, "searchDanmu 失败", e);
    throw e;
  }
}

// ============================ 2. 获取分集 ============================

/**
 * 获取分集：/api/v2/bangumi/:animeId → bangumi.episodes
 * 返回原样 episode 字段（seasonId/episodeId/episodeTitle/episodeNumber/airDate/url），
 * 客户端靠 episodeNumber + seasonId 对齐 TMDB 的季集。
 */
async function getDetailById(params) {
  try {
    var server = _server(params);
    var animeId = params.animeId;
    if (!animeId) throw new Error("缺少 animeId");

    var ttl = _num(params.cacheHours, DEFAULT_CACHE_HOURS) * 3600;
    var key = K_BANGUMI + animeId;
    var rec = _scache(key, ttl);

    if (!rec || !Array.isArray(rec.episodes)) {
      var data = _unwrap(
        await Widget.http.get(server + "/api/v2/bangumi/" + encodeURIComponent(animeId), { headers: _headers(params) }),
        "获取分集"
      );
      var bangumi = data && data.bangumi;
      if (!bangumi) {
        if (data && data.success === false) throw new Error("获取分集失败: " + (data.errorMessage || ""));
        return [];
      }
      rec = {
        t: _now(),
        animeId: String(animeId),
        animeTitle: String(bangumi.animeTitle || ""),
        seasons: bangumi.seasons || [],
        episodes: Array.isArray(bangumi.episodes) ? bangumi.episodes : []
      };
      _sset(key, rec);
      console.log(TAG, "番剧", animeId, "共", rec.episodes.length, "集，已缓存");
    }

    // 多季合并的番剧：按 seasonId 收窄，客户端就不用猜哪集是第几季
    var eps = rec.episodes;
    var season = params.season !== undefined && params.season !== null ? String(params.season) : "";
    if (season && Array.isArray(rec.seasons) && rec.seasons.length > 1) {
      var idx = parseInt(season, 10) - 1;
      var target = null;
      if (isFinite(idx) && idx >= 0 && idx < rec.seasons.length) target = rec.seasons[idx];
      if (!target) {
        for (var i = 0; i < rec.seasons.length; i++) {
          if (_seasonHit(rec.seasons[i], season)) { target = rec.seasons[i]; break; }
        }
      }
      if (target && target.id) {
        var subset = [];
        for (var j = 0; j < eps.length; j++) {
          if (eps[j].seasonId === target.id) subset.push(eps[j]);
        }
        if (subset.length) eps = subset;
      }
    }

    var out = [];
    for (var k = 0; k < eps.length; k++) {
      var e = eps[k];
      if (!e || e.episodeId === undefined || e.episodeId === null) continue;
      out.push({
        seasonId: e.seasonId,
        episodeId: String(e.episodeId),
        episodeTitle: String(e.episodeTitle || ""),
        episodeNumber: e.episodeNumber,
        airDate: e.airDate,
        url: e.url
      });
    }
    return out;
  } catch (e) {
    console.error(TAG, "getDetailById 失败", e);
    throw e;
  }
}

// ============================ 3. 整集弹幕加载 ============================

/**
 * 解析 commentId：优先客户端给的，其次用 match 接口按文件名反查。
 * 反查能救活 "commentId 没传但 title/link 有" 的播放场景。
 */
/**
 * 生成文件名候选列表。
 * LogVar 的匹配器同时支持 "中文第N季 + SxxEyy"、"中文第N季"、"SxxEyy" 等写法，
 * 多准备几种拼法能显著提高匹配率。
 */
function _matchFilenames(params) {
  var base = _keyword(params.seriesName || params.title || "");
  if (!base) {
    base = _keyword(params.episodeName || "");
  }
  if (!base) return [];

  var epRaw = params.episode !== undefined && params.episode !== null ? String(params.episode) : "";
  var sn = parseInt(epRaw, 10);
  var season = params.season !== undefined && params.season !== null ? String(params.season) : "";
  var si = parseInt(season, 10);
  var p2 = function (s) { return String(s).length < 2 ? "0" + s : s; };
  var cn = _toChinese(isFinite(sn) && sn > 0 ? sn : 1);
  var out = [];

  var push = function (s) {
    if (!s) return;
    for (var i = 0; i < out.length; i++) if (out[i] === s) return;
    out.push(s);
  };

  if (isFinite(sn) && sn > 0) {
    var sTag = (isFinite(si) && si > 0 ? "S" + p2(si) : "") + "E" + p2(sn);
    var seasonZh = isFinite(si) && si > 0 ? "第" + si + "季" : "第1季";
    var seasonCn = "第" + _toChinese(isFinite(si) && si > 0 ? si : 1) + "季";
    // 中文季号 + SxxEyy 实测命中率最高，放最前
    push(base + " " + seasonZh + " " + sTag + ".mkv");
    push(base + " " + seasonCn + " " + sTag + ".mkv");
    push(base + " " + sTag + ".mkv");
    push(base + " 第" + sn + "话");
    push(base + " 第" + cn + "话");
    push(base + " 第" + sn + "集");
  } else {
    push(base + ".mkv");
    push(base);
  }
  return out.slice(0, MATCH_CANDIDATES);
}

/** 按文件名现场换取新的 episodeId；无命中返回 "" */
async function _matchId(params, fileName) {
  var server = _server(params);
  var resp = await Widget.http.post(
    server + "/api/v2/match",
    JSON.stringify({ fileName: fileName }),
    { headers: _headers(params) }
  );
  var data = _unwrap(resp, "文件名匹配");
  var hit = data && data.isMatched && Array.isArray(data.matches) && data.matches[0];
  var id = hit ? String(hit.episodeId || "") : "";
  console.log(TAG, "匹配", fileName, "→", id || "未命中");
  return id;
}

/** 拉取单集弹幕原始数组；失败或空返回 null */
async function _fetchRaw(params, server, commentId) {
  var data;
  try {
    data = _unwrap(
      await Widget.http.get(
        server + "/api/v2/comment/" + encodeURIComponent(commentId) + "?format=json",
        { headers: _headers(params) }
      ),
      "获取弹幕"
    );
  } catch (e) {
    console.error(TAG, "弹幕获取失败", commentId, e.message);
    return null;
  }
  if (!data || data.success === false) {
    console.error(TAG, "弹幕服务拒绝", commentId, data && data.errorMessage);
    return null;
  }
  var raw = Array.isArray(data) ? data
    : (Array.isArray(data.comments) ? data.comments
      : (Array.isArray(data.barrage_list) ? data.barrage_list : null));
  return (raw && raw.length > 0) ? raw : null;
}

/**
 * 依次尝试：候选文件名 match（现场换新鲜 ID）→ 客户端透传的 commentId。
 * 命中即返回，避免把时间浪费在注定 404 的旧 ID 上。
 */
async function _resolveAndFetch(params) {
  var server = _server(params);
  var cands = _matchFilenames(params);
  var passed = params.commentId ? String(params.commentId) : "";

  for (var i = 0; i < cands.length; i++) {
    try {
      var id = await _matchId(params, cands[i]);
      if (!id) continue;
      var raw = await _fetchRaw(params, server, id);
      if (raw) return { commentId: id, raw: raw };
    } catch (e) {
      console.error(TAG, "候选失败", cands[i], e.message);
    }
  }
  // 兜底：透传的 ID 有时仍有效（缓存还没被挤掉）
  if (passed) {
    var raw2 = await _fetchRaw(params, server, passed);
    if (raw2) return { commentId: passed, raw: raw2 };
  }
  return null;
}

/** 该集是否处于"已知失败"冷却期：是则直接当空弹幕处理，不再发请求 */
function _isCooling(danmuKey) {
  var rec = _scache(K_FAIL + danmuKey, FAIL_TTL);
  return !!(rec && rec.cool);
}

function _markCooling(danmuKey, reason) {
  _sset(K_FAIL + danmuKey, { t: _now(), cool: true, reason: reason });
}

/**
 * 加载整集弹幕，带本地缓存、失败冷却与淘汰。
 * 缓存记录：{ t, commentId, logical, count, total, dropped, items, times }
 * items 与 times 下标严格对齐（times[i] === items[i].p 的时间部分）。
 *
 * 返回约定：成功返回 rec；ID 失效 / 上游失效 / 该集没弹幕返回 null（上层转空数组）。
 */
async function _loadEpisode(params) {
  var ttl = _num(params.cacheHours, DEFAULT_CACHE_HOURS) * 3600;
  var maxEp = Math.floor(_num(params.maxCachedEpisodes, DEFAULT_MAX_EPISODES));

  // 缓存键用"片名+季+集"的逻辑标识，不用易失效的 episodeId，缓存才能跨缓存淘汰继续有效
  var cands = _matchFilenames(params);
  var logical = cands.length ? cands[0]
    : (params.commentId ? "id:" + params.commentId
      : (params.tmdbId ? "tmdb:" + params.tmdbId + ":" + params.type : ""));
  if (!logical) throw new Error("无法确定弹幕标识（缺少 commentId 与片名/季/集）");

  var dk = K_COMMENT + _hash(logical);
  if (_isCooling(dk)) {
    console.log(TAG, "该集处于失败冷却期，跳过请求", logical);
    return null;
  }

  var rec = _scache(dk, ttl);
  if (rec && Array.isArray(rec.items) && Array.isArray(rec.times)) {
    console.log(TAG, "命中本地缓存", logical, rec.items.length, "条");
    _touch(dk, maxEp);   // 命中也更新访问时间，LRU 才准
    return rec;
  }

  var hit;
  try {
    hit = await _resolveAndFetch(params);
  } catch (e) {
    _markCooling(dk, e.message);
    console.error(TAG, "弹幕解析失败，进入冷却", logical, e.message);
    return null;
  }
  if (!hit) {
    _markCooling(dk, "ID 失效或上游无弹幕");
    console.error(TAG, "未取到弹幕，进入冷却", logical);
    return null;
  }

  var idx = _buildIndex(hit.raw);
  if (idx.items.length === 0) {
    _markCooling(dk, "弹幕全部无效");
    return null;
  }
  rec = {
    t: _now(),
    commentId: hit.commentId,
    logical: logical,
    count: idx.items.length,
    total: idx.total,
    dropped: idx.dropped,
    items: idx.items,
    times: idx.times
  };
  _sset(dk, rec);
  _touch(dk, maxEp);
  _sdel(K_FAIL + dk);
  console.log(TAG, "弹幕加载完成", logical, "id=" + hit.commentId,
    "原始", idx.total, "有效", idx.items.length, "丢弃", idx.dropped);
  return rec;
}

/**
 * 把服务端弹幕数组压成"瘦条目 + 排序时间数组"，一次性完成三件事：
 *   - 剔除 空文本 / 时间不可解析 的脏弹幕
 *   - 剔除 (时间+参数+文本) 完全重复的多源重复弹幕
 *   - 只保留 {p,m,cid}，去掉 t/like 等客户端不需要的字段
 * 排序用 时间→原始顺序 双键稳定排序，同时间戳弹幕先后不乱。
 */
function _buildIndex(rawList) {
  var slim = [];
  var order = [];       // [time, originalIndex]
  var seen = Object.create(null);
  var dropped = 0;

  for (var i = 0; i < rawList.length; i++) {
    var d = rawList[i];
    if (!d) { dropped++; continue; }

    var p = d.p;
    if (typeof p === "number") p = String(p);
    if (typeof p !== "string") p = "";

    var comma = p.indexOf(",");
    var t = parseFloat(comma >= 0 ? p.slice(0, comma) : p);
    if (!isFinite(t)) { dropped++; continue; }

    var m = d.m;
    if (m === undefined || m === null) m = "";
    else if (typeof m !== "string") m = String(m);
    if (!m.trim()) { dropped++; continue; }

    // 去重键：时间精确到毫秒 + 完整参数串 + 文本，安全不误杀"哈哈哈"连发
    var dk = t.toFixed(3) + "|" + p + "|" + m;
    if (seen[dk]) { dropped++; continue; }
    seen[dk] = 1;

    var item = { p: p, m: m };
    if (d.cid !== undefined && d.cid !== null) item.cid = d.cid;
    slim.push(item);
    order.push([t, slim.length - 1]);
  }

  order.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });

  var times = new Array(order.length);
  for (var k = 0; k < order.length; k++) times[k] = order[k][0];

  return {
    items: slim,
    times: times,
    total: rawList.length,
    dropped: dropped
  };
}

/** // ============================ 4. 分段窗口 ============================

/** 二分查找：第一个 >= v 的下标 */
function _lowerBound(times, v) {
  var lo = 0;
  var hi = times.length;
  while (lo < hi) {
    var mid = (lo + hi) >> 1;
    if (times[mid] < v) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * 算出本次该返回的时间窗口。
 * 基线固定在 floor(t/seg)*seg 的整数倍上，播放器来回抖 1~2 秒都落在同一窗口，
 * 不会出现"同一段弹幕被请求两次却拿到不同内容"的错位。
 * pad 秒前向重叠保证正好落在整分钟起点的弹幕不会漏。
 */
function _window(segmentTime, segSeconds, padSeconds) {
  var t = parseFloat(segmentTime);
  if (!isFinite(t) || t < 0) t = 0;
  var base = Math.floor(t / segSeconds) * segSeconds;
  var start = Math.max(0, base - padSeconds);
  return { start: start, end: base + segSeconds, base: base };
}

/** 按窗口从整集索引里切出弹幕（二分定位 + slice，不回整集） */
function _sliceWindow(rec, win) {
  var lo = _lowerBound(rec.times, win.start);
  var hi = _lowerBound(rec.times, win.end);
  if (hi <= lo) return [];
  return rec.items.slice(lo, hi);
}

/** 分段上下文：分段长度 / 前向重叠 / 当前窗口 */
async function _segmentContext(params) {
  var seg = _num(params.segmentSeconds, DEFAULT_SEGMENT);
  var pad = _num(params.segmentPad, DEFAULT_PAD);
  if (pad >= seg) pad = 0;
  return { seg: seg, pad: pad, win: _window(params.segmentTime, seg, pad) };
}

/** 统一出口：加载整集 → 切窗口。上游失效时返回空数组，不阻断播放 */
async function _danmuAt(params) {
  var rec = await _loadEpisode(params);
  if (!rec) return [];
  var ctx = await _segmentContext(params);
  var list = _sliceWindow(rec, ctx.win);
  console.log(TAG, "commentId=" + rec.commentId,
              "窗口[" + ctx.win.start.toFixed(1) + "," + ctx.win.end.toFixed(1) + ")",
              "命中", list.length, "条");
  return list;
}

// ============================ 5. 弹幕入口 ============================

/**
 * 获取弹幕。
 * segmentTime 有值时只回该分段；为空时按 0 处理（取第一段），
 * 保证任何调用都拿到"一小段"而不是整集 1.3MB。
 */
async function getCommentsById(params) {
  try {
    return await _danmuAt(params);
  } catch (e) {
    console.error(TAG, "getCommentsById 失败", e);
    throw e;
  }
}

/**
 * 按播放时刻取分段弹幕。
 * 与 getCommentsById 共用缓存，同一时刻重复调用零网络开销。
 */
async function getDanmuWithSegmentTime(params) {
  try {
    return await _danmuAt(params);
  } catch (e) {
    console.error(TAG, "getDanmuWithSegmentTime 失败", e);
    throw e;
  }
}
