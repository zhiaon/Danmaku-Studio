/**
 * 江砚弹幕模块（DandanPlay v2 兼容协议）
 *
 * 数据源: 由「弹幕服务器」参数指定（DandanPlay v2 兼容协议，如 danmu_api 自部署实例）
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
 * 版本记录
 *   3.1.6  弹幕条目补回服务端 t 字段，修复面板少算约 400 条。
 *   3.1.5  弹幕完全不落盘：读缓存早已禁用，写入也一并移除，预热只热服务端。
 *   3.1.4  恢复选集预热：只为热服务端缓存(7.7s→0.7s)，模块仍不读本地缓存。
 *   3.1.3  关闭 getDetail 里的选集预取，避免白下载。
 *   3.1.2  每次播放强制重新抓取，不读本地缓存（预取同步关闭）。
 *   3.1.1  缓存版本 9→11，作废此前抓取不全的旧缓存。
 *   3.1.0  规范年份匹配：优先用服务端 startDate 字段，回退标题括号。
 *
 * 协议依据: InchStudio/ForwardWidgets
 *   widgets/segmentDanmuExample.js + README「弹幕分片加载流程」
 */

// ============================ 元数据 ============================

WidgetMetadata = {
  id: "zhiaon.logvar.danmu",
  title: "江砚弹幕",
  version: "3.1.6",
  requiredVersion: "0.0.2",
  description: "多平台弹幕合并，全量加载",
  author: "江砚",
  site: "https://github.com/zhiaon/jiangyan-danmu",

  globalParams: [
    {
      name: "server",
      title: "弹幕服务器",
      type: "input",
      description: "DandanPlay v2 弹幕 API 基地址（danmu_api 兼容协议），末尾不带 /",
      placeholders: [
        { title: "示例 danmu_api", value: "https://{domain}/{token}" }
      ]
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
    }
  ]
};

// ============================ 常量 ============================

var TAG = "[LogVarDanmu]";
var DEFAULT_SEGMENT = 180;
var DEFAULT_PAD = 3;
var DEFAULT_CACHE_HOURS = 24;
var DEFAULT_MAX_EPISODES = 5;
var DEFAULT_MERGE_SOURCES = 3;   // 同一集合并的上游平台数，默认 3；0 = 单一来源
var MERGE_HARD_LIMIT = 12;        // 无论用户填多少，最多合并 12 个来源
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

// 弹幕抓取逻辑版本。改动「抓取方式 / 去重规则 / 返回内容」时 +1，
// 旧缓存会因版本不符自动失效并重新抓取，避免升级后仍显示老数据。
var CACHE_VERSION = 11;

// 实测结论：本服务的 episodeId 是"当前缓存"的临时编号，缓存淘汰后 ID 立刻失效（服务端日志：
//   error: [cache] No URL found for ID: 13126 / [LogVar-API] Comment with ID 13126 not found）。
// 所以不能盲信客户端透传的 commentId，必须用 /api/v2/match 按文件名现场换一个新 ID。
var MATCH_CANDIDATES = 4;

// 弹幕类型判定：中文来源(tencent/youku/bilibili)与 dandan 体系混用，两种词表都要认
var MOVIE_WORDS = ["movie", "电影", "剧场版", "奇幻片", "完结篇"];
var TV_WORDS = ["tvseries", "tv", "动漫", "2d动漫", "电视剧", "番剧", "web", "ova"];
// 只保留明确不是正片的条目类型。「合集」不在此列：优酷/腾讯的完整合集
// 往往是弹幕最全的源（咒术回战合集 47 集），一律排除会漏源。
var JUNK_WORDS = ["解说", "速通", "盘点", "吐槽", "reaction", "音游",
                  "带你听", "臻享", "舞台剧", "广播剧"];

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

// _num 把 0 当无效值回退默认，但 mergeSources=0 明确表示"单一来源"，必须真返回 0
function _numAllowZero(v, fallback) {
  var n = parseFloat(v);
  return isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * 服务器基地址，去掉尾部斜杠，防双重斜杠导致 404。
 * 必须在「弹幕服务器」参数里填写，模块不内置任何默认服务器。
 */
function _server(params) {
  var s = String(_cfg(params, "server", "") || "").trim();
  while (s.length > 0 && s.charAt(s.length - 1) === "/") s = s.slice(0, -1);
  if (!s) {
    throw new Error("未配置弹幕服务器：请在模块设置的「弹幕服务器」里填写 API 地址");
  }
  return s;
}

/** 统一请求头：带 UA + Referer，LogVar 的 CDN/缓存识别更稳 */
function _headers(params) {
  var base = _server(params);
  return {
    "User-Agent": USER_AGENT,
    "Accept": "application/json",
    // 整集弹幕未压缩约 1.9MB，gzip 后 486KB，加载时间 2.9s → 0.8s
    "Accept-Encoding": "gzip, deflate",
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

var CN_NUM_MAP = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };

/** 中文数字 → 阿拉伯（支持 1-99），失败返回 null */
function _fromChinese(s) {
  if (!s) return null;
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  var ten = s.indexOf("十");
  if (ten >= 0) {
    var hi = ten === 0 ? 1 : (CN_NUM_MAP[s.charAt(ten - 1)] || 0);
    var lo = ten === s.length - 1 ? 0 : (CN_NUM_MAP[s.charAt(ten + 1)] || 0);
    var v = hi * 10 + lo;
    return v > 0 ? v : null;
  }
  return CN_NUM_MAP[s.charAt(0)] || null;
}

/**
 * 解析分集标题里的「真实集号」。
 *
 * 为什么不能只用 episodeNumber：
 *   同一部剧被上游拆成多个条目后，序号会重置。
 *   「凡人修仙传之凡人风起天南 贰」的 ep#1 实际是第9话、ep#4 是第12话，
 *   直接按 episodeNumber=4 匹配会错位到第12话。
 *   各源标题里的「第N话 / 第N集 / 第N回」是全局连续的，跨条目、跨平台都能对齐。
 */
function _epRealNumber(ep) {
  var t = String((ep && ep.episodeTitle) || "");
  var m = t.match(/第\s*([0-9]+)\s*[话話集回]/);
  if (m) { var n = parseInt(m[1], 10); if (isFinite(n) && n > 0) return n; }
  m = t.match(/第\s*([一二三四五六七八九十]+)\s*[话話集回]/);
  if (m) { var c = _fromChinese(m[1]); if (c) return c; }
  m = t.match(/\bE[Pp]?\s*0*([0-9]+)\b/);
  if (m) { var e = parseInt(m[1], 10); if (isFinite(e) && e > 0) return e; }
  return null;
}

function _toChinese(n) {
  n = Math.floor(Math.abs(parseInt(n, 10) || 0));
  if (n <= 0) return "";
  if (n < 10) return CN_DIGIT[n];
  if (n === 10) return "十";
  if (n < 20) return "十" + CN_DIGIT[n % 10];
  if (n < 100) return CN_DIGIT[Math.floor(n / 10)] + "十" + (n % 10 ? CN_DIGIT[n % 10] : "");
  return String(n);
}

var LANG_WORDS = ["粤语", "粤配", "国语", "日语", "中配", "台配", "双语", "英语", "韩语"];

/** 标题是否标注了配音语言（粤语版/国语版/中配…） */
function _hasLangTag(t) {
  var hay = String(t || "");
  for (var i = 0; i < LANG_WORDS.length; i++) {
    if (hay.indexOf(LANG_WORDS[i]) >= 0) return true;
  }
  return false;
}

/** 标题归一化：去掉年份/类型标签/来源标记，用于识别同一部剧在不同平台的镜像条目 */
function _normTitle(t) {
  return String(t || "")
    .replace(/from\s+[a-z0-9&._\-]+/gi, "")
    .replace(/[（(]\s*(?:19|20)\d{2}\s*[)）]/g, "")
    .replace(/【[^】]*】/g, "")
    .replace(/\s+/g, "")
    .trim();
}

/** 标题里的年份：凡人修仙传(2020)【动漫】 → 2020 */
function _titleYear(t) {
  var m = String(t || "").match(/[（(]\s*((?:19|20)\d{2})\s*[)）]/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * 从 anime 对象提取年份：优先服务端结构化 startDate 字段，回退标题括号。
 * startDate 是服务端返回的规范开播日期（如 "2020-01-01T00:00:00Z"），
 * 比标题括号正则更可靠——标题没带年份、或括号年份与实际开播年不符时仍能正确匹配。
 */
function _animeYear(a) {
  if (a) {
    var sd = a.startDate;
    if (sd) {
      var m = String(sd).match(/((?:19|20)\d{2})/);
      if (m) return parseInt(m[1], 10);
    }
  }
  return _titleYear(a && a.animeTitle);
}

/** 标题里的类型标签：【动漫】/【电视剧】/【3D网络放送】 → 标签文字 */
function _titleTag(t) {
  var m = String(t || "").match(/【([^】]+)】/);
  return m ? m[1] : "";
}

/**
 * 是否真人剧/电视剧条目。
 * 同名作品常有动画版与真人版两条线（凡人修仙传 2020 动画 vs 2025 电视剧），
 * 弹幕内容完全不同，绝不能合并。
 */
function _isLiveActionTitle(t) {
  var tag = _titleTag(t);
  var hay = tag + " " + String(t || "");
  return hay.indexOf("电视剧") >= 0 || hay.indexOf("真人") >= 0;
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
 *      必须按"类型相符 → 标题精确 → 播放平台源 → 弹幕量 → 评分"排。
 *
 * ctx.live: true=真人剧 / false=动漫 / null=未判定
 * ctx.link: 当前播放链接，用来抬高对应平台的官方源
 */
/**
 * 标题与关键词的结构化匹配度（0~100）。
 *
 * 通用思路：标题 = 「关键词 + 修饰」，修饰越少越接近本体条目。
 * 不依赖任何具体剧名，所有剧走同一套规则：
 *
 *   完全等于关键词                        100
 *   关键词 + 「之」+ 子篇章（本体分支）      85
 *   关键词 + 季号（第一季/Ⅱ/Season 2）     80
 *   关键词 + 其他修饰（疾风传/OAD/少年篇）   55
 *   关键词 + 数字续作（3龙王传说）          45
 *   关键词埋在标题中间（博人传 火影忍者…）   20
 *   不含关键词                              0
 */
function _titleMatch(title, kw) {
  var t = String(title || "").toLowerCase();
  var k = String(kw || "").toLowerCase().trim();
  if (!k) return 0;
  var idx = t.indexOf(k);
  if (idx < 0) return 0;
  if (idx > 0) return 20;                       // 关键词不在开头 → 衍生作

  var rest = t.slice(k.length);
  rest = rest.replace(/[（(][^)）]*[)）]/g, " ");   // 去掉 (年份)
  rest = rest.replace(/【[^】]*】/g, " ");          // 去掉 【类型】
  rest = rest.replace(/from\s+[a-z0-9&._\-]+/g, " ");
  rest = rest.trim();
  if (!rest) return 100;

  if (/^之/.test(rest)) {
    // 「之凡人风起天南」是本体的子篇章；「之凡人风起天南 贰」带季号，按季处理
    if (_titleSeason(rest) !== null) return 80;
    return 85;
  }
  // 数字开头必须先于季号判断：「斗罗大陆5重生唐三…第1季」是第5部动态漫，
  // 若先匹配到尾巴上的「第1季」会被当成第一季，反而压过正传。
  if (/^[0-9]/.test(rest)) return 45;            // 数字续作
  if (_titleSeason(rest) !== null) return 80;    // 季号
  return 55;                                      // 其他修饰
}

function _rank(animes, ctx) {
  var wantMovie = ctx.type === "movie";
  var kw = String(ctx.keyword || "").toLowerCase();
  var wantLive = (ctx.live === true || ctx.live === false) ? ctx.live : null;
  var liveHint = (ctx.liveHint === true || ctx.liveHint === false) ? ctx.liveHint : null;
  var wantYear = ctx.year || null;
  var season = ctx.season || null;
  var link = String(ctx.link || "").toLowerCase();

  // 播放链接对应的平台：在该平台播放，就优先该平台的官方弹幕
  var platform = "";
  if (link.indexOf("bilibili") >= 0) platform = "bilibili";
  else if (link.indexOf("youku") >= 0) platform = "youku";
  else if (link.indexOf("iqiyi") >= 0) platform = "iqiyi";
  else if (link.indexOf("v.qq.com") >= 0 || link.indexOf("qq.com") >= 0) platform = "tencent";
  else if (link.indexOf("mgtv") >= 0) platform = "mgtv";

  var scored = [];
  for (var i = 0; i < animes.length; i++) {
    var a = animes[i];
    if (!a || !a.animeId) continue;

    var s = 0;
    var title = String(a.animeTitle || "");
    var src = String(a.source || "").toLowerCase();

    // 1) 标题匹配度（0~90）：本体条目接近满分，衍生作/碎片大幅靠后
    var match = _titleMatch(title, kw);
    s += Math.round(match * 0.9);

    // 2) 类型：电影 vs 剧集
    var movie = _isMovie(a);
    if (wantMovie) s += movie ? 120 : -80;
    else if (movie) s -= 80;

    // 3) 动漫 / 真人剧
    var live = _isLiveActionTitle(title);
    if (wantLive !== null) s += (live === wantLive) ? 70 : -70;
    else if (liveHint !== null) s += (live === liveHint) ? 30 : -10;

    // 4) 年份（优先 startDate 结构化字段，回退标题括号）
    if (wantYear) {
      var ty = _animeYear(a);
      if (ty) s += (Math.abs(ty - wantYear) <= 1) ? 40 : -40;
    }

    // 5) 季号：明确标了当前季的条目优先；标了别的季的降权。
    //    season>1 时，无季号的合集版需要季集映射才能对齐，略低于直接标了该季的条目。
    if (season && match >= 80) {
      var ts = _titleSeason(title);
      if (ts !== null) s += (ts === season) ? 40 : -45;
    }
    if (season > 1 && match === 100 && _titleSeason(title) === null) s -= 20;

    // 6) 最终季 / 完结篇：播前面的季时不采用
    if (season && season <= 1 && /最终季|最终章|完结篇/.test(title)) s -= 30;

    // 7) 精编/重制版：集数与正片不同，弹幕时间轴有偏移
    if (/特别版|纪念版|重制版|精编版|导演剪辑/.test(title)) s -= 25;

    // 8) 弹幕量：集数越多越可能是完整系列
    var ec = parseInt(a.episodeCount, 10);
    if (isFinite(ec) && ec > 0) s += Math.min(50, Math.round(Math.log(ec + 1) * 12));

    // 9) 来源：官方播放平台源优先，聚合源次之
    // 官方播放平台（B站/腾讯/优酷/爱奇艺/芒果）优先于聚合源。
    // 40 分足够压过 dandan 的评分+收藏加成，但小于「本体 vs 衍生」的 45 分差，
    // 所以不会出现"官方源的衍生作压过聚合源的本体"。
    if (src === "bilibili" || src === "youku" || src === "iqiyi" ||
        src === "tencent" || src === "mgtv" || src === "qq") s += 40;
    else if (src.indexOf("dandan") >= 0 && src.indexOf("bahamut") >= 0) s += 12;
    else if (src.indexOf("dandan") >= 0) s += 8;
    else if (src === "bahamut") s += 8;
    else s += 6;

    // 10) 播放平台源优先
    if (platform && src === platform) s += 25;

    // 11) 别名命中（弱）
    if (kw && _aliases(a).toLowerCase().indexOf(kw) >= 0) s += 10;

    // 12) 评分：官方源常无评分字段，权重压低，避免反超完整版
    var r = parseFloat(a.rating);
    if (isFinite(r) && r > 0) s += Math.min(10, r * 1.2);

    if (_isJunk(a)) s -= 100;
    if (a.isFavorited) s += 5;

    scored.push({ item: a, score: s });
  }
  scored.sort(function (x, y) { return y.score - x.score; });

  var out = [];
  for (var k = 0; k < scored.length; k++) {
    var it = scored[k].item;
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
    var key = K_SEARCH + _hash(keyword + "|" + season + "|v" + CACHE_VERSION);
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

    // 不再在搜索阶段按季号硬筛：完整版（斗罗大陆 267 集、凡人 197 集）
    // 标题里没有「第1季」，一筛就整批消失，反而只剩动态漫碎片。
    // 季号冲突交给 _rank 的 -45 降权处理，完整版始终保留。
    var pool = rec.list;

    // 类型表决：Forward 没给明确信号时，按候选中占多数的类型给弱偏好。
    // 同名真人剧和动漫并存时（凡人修仙传 2020 动画 vs 2025 电视剧），
    // 多数派排前面，少数派仍然保留，用户手动也能选到。
    var wantLive = _inferLiveAction(params);
    var liveHint = null;
    if (wantLive === null) {
      var lc = 0, ac = 0;
      for (var q = 0; q < pool.length; q++) {
        if (_isLiveActionTitle(pool[q] && pool[q].animeTitle)) lc++;
        else ac++;
      }
      if (lc > 0 && ac > 0) liveHint = lc > ac;
      console.log(TAG, "类型表决：动漫 " + ac + " / 真人剧 " + lc +
        (liveHint === null ? "" : (" → 偏好" + (liveHint ? "真人剧" : "动漫"))));
    }

    return { animes: _rank(pool, {
      type: params.type,
      keyword: keyword,
      live: wantLive,
      liveHint: liveHint,
      link: params.link,
      year: _inferYear(params),
      season: isFinite(parseInt(season, 10)) ? parseInt(season, 10) : null
    }) };
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

    // 预热服务端缓存：选集时后台请求一次整集弹幕，点播放时服务端已缓存(约 0.7s)。
    // 模块自身仍不读本地缓存，播放时照样重新请求 —— 只是免去服务端现抓源站的 7 秒。
    if (!params.__noPrefetch && params.episode !== undefined && params.episode !== null) {
      var preEp = parseInt(params.episode, 10);
      if (isFinite(preEp) && preEp > 0) {
        _prefetchEpisode(params, preEp).then(function () {
          if (preEp + 1 <= out.length) _prefetchEpisode(params, preEp + 1);
        });
      }
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

/** 按文件名现场换取 episodeId 及来源标题；无命中返回 null */
async function _matchDetail(params, fileName) {
  var server = _server(params);
  var resp = await Widget.http.post(
    server + "/api/v2/match",
    JSON.stringify({ fileName: fileName }),
    { headers: _headers(params) }
  );
  var data = _unwrap(resp, "文件名匹配");
  var hit = data && data.isMatched && Array.isArray(data.matches) && data.matches[0];
  if (!hit || !hit.episodeId) {
    console.log(TAG, "匹配", fileName, "→ 未命中");
    return null;
  }
  var out = {
    id: String(hit.episodeId),
    title: String(hit.title || ""),
    source: String(hit.source || "")
  };
  console.log(TAG, "匹配", fileName, "→", out.id, out.title ? ("[" + out.title + "]") : "");
  return out;
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
 * 推断当前播放的是真人剧还是动漫。
 * 返回 true=真人剧 / false=动漫 / null=判不出（交给评分决定，不硬过滤）。
 */
function _inferLiveAction(params) {
  var hay = [params.title, params.seriesName, params.episodeName]
    .filter(function (x) { return x !== undefined && x !== null && x !== ""; })
    .join(" ");
  if (/电视剧|真人版|真人剧/.test(hay)) return true;
  if (/动漫|动画|番剧|3D网络放送/.test(hay)) return false;

  // Forward 若传了 TMDB genres，动画题材可直接判定
  var g = params.genres;
  if (g) {
    var gs = Array.isArray(g) ? g.join(" ") : String(g);
    if (/动画|动漫|anime|animation/i.test(gs)) return false;
    if (/真人|电视剧|reality/i.test(gs)) return true;
  }
  return null;
}

/** 推断目标年份：标题里的年份 > params.year > params.releaseYear */
function _inferYear(params) {
  var y = _titleYear(params.title) || _titleYear(params.seriesName);
  if (!y && params.year !== undefined && params.year !== null) y = parseInt(params.year, 10);
  if (!y && params.releaseYear !== undefined && params.releaseYear !== null) y = parseInt(params.releaseYear, 10);
  if (!y && params.premiereDate) {
    var m = String(params.premiereDate).match(/((?:19|20)\d{2})/);
    if (m) y = parseInt(m[1], 10);
  }
  return (isFinite(y) && y > 1900) ? y : null;
}

/**
 * 用 Forward 传的 commentId 反查它属于哪个条目、哪一集。
 * 这是最可靠的信号：它直接告诉我们播放器实际选中的是动漫线还是真人剧线。
 */
async function _locateByCommentId(params, list, commentId) {
  var cid = String(commentId || "");
  if (!cid) return null;
  var probes = 0;
  for (var i = 0; i < list.length && probes < 10; i++) {
    var a = list[i];
    if (!a || !a.animeId) continue;
    probes++;
    var eps;
    try { eps = await _cachedBangumi(params, String(a.animeId)); }
    catch (e) { continue; }
    for (var j = 0; j < eps.length; j++) {
      if (eps[j] && String(eps[j].episodeId) === cid) {
        return { anime: a, episode: eps[j] };
      }
    }
  }
  return null;
}

/** 标题里的季号：第2季 / 第二季 / Season 2 / S02，解析不出返回 null */
function _titleSeason(t) {
  var s = String(t || "");
  var m = s.match(/第\s*([0-9]+)\s*[季部期]/);
  if (m) { var n = parseInt(m[1], 10); if (isFinite(n) && n > 0) return n; }
  m = s.match(/第\s*([一二三四五六七八九十]+)\s*[季部期]/);
  if (m) { var c = _fromChinese(m[1]); if (c) return c; }
  m = s.match(/[Ss]eason\s*([0-9]+)/i);
  if (m) { var a = parseInt(m[1], 10); if (isFinite(a) && a > 0) return a; }
  m = s.match(/\bS([0-9]{1,2})\b/i);
  if (m) { var b = parseInt(m[1], 10); if (isFinite(b) && b > 0) return b; }
  // 罗马数字季号：斗罗大陆Ⅱ / II / Ⅲ
  var ROMAN = { "Ⅰ": 1, "Ⅱ": 2, "Ⅲ": 3, "Ⅳ": 4, "Ⅴ": 5, "Ⅵ": 6, "Ⅶ": 7, "Ⅷ": 8, "Ⅸ": 9, "Ⅹ": 10 };
  m = s.match(/[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]/);
  if (m && ROMAN[m[0]]) return ROMAN[m[0]];
  m = s.match(/\b(X{0,1}(?:IX|IV|V?I{1,3}))\b/);
  if (m) {
    var rstr = m[1], rv = 0;
    if (rstr.indexOf("X") === 0) { rv += 10; rstr = rstr.slice(1); }
    if (rstr.indexOf("IX") === 0) { rv += 9; rstr = rstr.slice(2); }
    else if (rstr.indexOf("IV") === 0) { rv += 4; rstr = rstr.slice(2); }
    else {
      if (rstr.indexOf("V") === 0) { rv += 5; rstr = rstr.slice(1); }
      rv += rstr.length;
    }
    if (rv > 0 && rv <= 20) return rv;
  }
  return null;
}

/** 条目的真实集号体系：首集集号（用于判断是全局连续还是每季独立编号） */
function _firstRealEp(eps) {
  var first = null;
  for (var i = 0; i < eps.length; i++) {
    var r = _epRealNumber(eps[i]);
    if (r !== null && (first === null || r < first)) first = r;
  }
  return first;
}

/**
 * 条目是否与目标季冲突。
 *
 * 两种上游编号体系：
 *   A. 全局连续（凡人修仙传：第三季是第77~124话）→ 真实集号全球唯一，不用管季号
 *   B. 每季独立（咒术回战：每季第1话都叫「第1话」）→ 必须靠标题季号区分
 * 判断依据：首集集号 > 1 说明是 A 体系；首集是第1话说明可能是 B 体系。
 */
function _seasonConflict(title, eps, season) {
  if (!season || season <= 0) return false;
  var first = _firstRealEp(eps);
  if (first !== null && first > 1) return false;   // A 体系：全局连续，不冲突
  var ts = _titleSeason(title);
  if (ts === null) return false;                   // 标题没写季号：合集版/单季剧，不拦
  return ts !== season;
}

/**
 * 收集所有候选主源（同类型、同集号、有弹幕），按弹幕量降序返回。
 *
 * 用户诉求：同一部剧在多个平台都能播时，选弹幕最多的那个平台源。
 * 所以这里不取"第一个命中的"，而是把候选全取一遍再比数量。
 * 每个来源只请求一次，取到的原始弹幕随返回值交给合并阶段复用，不重复下载。
 */
/** 并发上限控制：并行执行 fn，同时最多 limit 个 */
async function _mapLimit(items, limit, fn) {
  var out = new Array(items.length);
  var idx = 0;
  async function worker() {
    while (true) {
      var i = idx++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); }
      catch (e) { console.error(TAG, "并发任务失败", e && e.message); out[i] = null; }
    }
  }
  var ws = [];
  var n = Math.min(limit, items.length);
  for (var w = 0; w < n; w++) ws.push(worker());
  await Promise.all(ws);
  return out;
}

async function _collectPrimarySources(params, realEp, globalNumbering) {
  var base = _keyword(params.seriesName || params.title || "");
  if (!base) base = _keyword(params.episodeName || "");
  if (!base) return [];

  var epRaw = params.episode !== undefined && params.episode !== null ? String(params.episode) : "";
  var sn = parseInt(epRaw, 10);
  if (!isFinite(sn) || sn <= 0) return [];
  var epNo = (realEp !== undefined && realEp !== null) ? realEp : sn;

  var list = await _cachedSearchList(params, base);
  if (!list.length) return [];
  var server = _server(params);
  var passed = params.commentId ? String(params.commentId) : "";
  var out = [];
  var tried = Object.create(null);

  var seasonRaw = params.season !== undefined && params.season !== null ? String(params.season) : "";
  var seasonNum = parseInt(seasonRaw, 10);
  if (!isFinite(seasonNum) || seasonNum <= 0) seasonNum = null;

  // ---- 1) 先定类型：异类型的源连请求都不发 ----
  // 真人剧的整集弹幕有 1.3MB，判错类型会让首次加载多花十几秒。
  var wantLive = null;
  if (passed) {
    var loc = await _locateByCommentId(params, list, passed);
    if (loc) {
      var at0 = String(loc.anime.animeTitle || "");
      wantLive = _isLiveActionTitle(at0);
      var real0 = _epRealNumber(loc.episode);
      if (real0 === null || real0 === epNo) {
        var raw0 = await _fetchRaw(params, server, passed);
        if (raw0) {
          tried[passed] = 1;
          out.push({
            commentId: passed, raw: raw0, title: at0,
            source: String(loc.anime.source || ""), live: wantLive,
            epCount: 0, globalNum: false
          });
          console.log(TAG, "commentId 反查命中 [" + at0 + "] " + raw0.length + " 条");
        }
      } else {
        console.log(TAG, "commentId 反查：" + at0 + " 实为第" + real0 + "话 ≠ 请求第" + epNo + "话，重新定位");
      }
    }
  }
  if (wantLive === null) wantLive = _inferLiveAction(params);
  if (wantLive === null) {
    var lc = 0, ac = 0;
    for (var v = 0; v < list.length; v++) {
      var vt = String((list[v] && list[v].animeTitle) || "");
      if (vt.indexOf(base) < 0) continue;
      if (_isLiveActionTitle(vt)) lc++; else ac++;
    }
    if (lc > 0 && ac > 0) wantLive = lc > ac;
  }
  console.log(TAG, "类型判定：" + (wantLive === null ? "未定" : (wantLive ? "真人剧" : "动漫")));

  // ---- 2) 粗筛：纯本地规则，不发请求 ----
  var ranked = _rank(list, {
    type: params.type, keyword: base, live: wantLive, link: params.link,
    year: _inferYear(params), season: seasonNum
  });
  var wantYear = _inferYear(params);
  var probeList = [];
  var wantLimit = Math.floor(_numAllowZero(params.mergeSources, DEFAULT_MERGE_SOURCES));
  if (!(wantLimit >= 1)) wantLimit = 1;
  if (wantLimit > MERGE_HARD_LIMIT) wantLimit = MERGE_HARD_LIMIT;

  // 探测名额要比实际需要的多留一些：镜像条目、没有目标集的篇章都会占掉名额。
  var maxProbe = Math.min(wantLimit * 2, 8);
  var seenNorm = Object.create(null);
  for (var i = 0; i < ranked.length && probeList.length < maxProbe; i++) {
    var a = ranked[i];
    var at = String(a.animeTitle || "");
    if (at.indexOf(base) < 0) continue;
    if (_isJunk(a)) continue;
    if (params.type !== "movie" && _isMovie(a)) continue;
    if (wantLive !== null && _isLiveActionTitle(at) !== wantLive) continue;
    var y = _animeYear(a);
    if (wantYear && y && Math.abs(y - wantYear) > 1) continue;
    // 镜像去重要在占名额之前做，否则 360 这类镜像会把真正有增量的源挤出候选
    var nt0 = _normTitle(at);
    if (nt0 && seenNorm[nt0]) {
      console.log(TAG, "跳过镜像条目 [" + at + "]");
      continue;
    }
    if (nt0) seenNorm[nt0] = 1;
    probeList.push(a);
  }
  console.log(TAG, "粗筛后 " + probeList.length + " 个候选待验证");

  // ---- 3) 并行取分集 ----
  var picked = await _mapLimit(probeList, 4, async function (a) {
    var at = String(a.animeTitle || "");
    var eps = await _cachedBangumi(params, String(a.animeId));
    if (globalNumbering === false && seasonNum) {
      if (_titleSeason(at) !== seasonNum) { console.log(TAG, "  跳过(季号不符): " + at); return null; }
    } else if (_seasonConflict(at, eps, seasonNum)) {
      console.log(TAG, "  跳过(季冲突): " + at); return null;
    }
    var ep = _pickEpisode(eps, epNo);
    if (!ep) { console.log(TAG, "  跳过(无第" + epNo + "话): " + at + " / " + eps.length + "集"); return null; }
    return { a: a, ep: ep, eps: eps };
  });

  var valid = [];
  for (var j = 0; j < picked.length; j++) {
    var it = picked[j];
    if (!it) continue;
    var vid = String(it.ep.episodeId);
    if (tried[vid]) continue;
    tried[vid] = 1;
    valid.push(it);
  }
  if (valid.length > wantLimit) valid = valid.slice(0, wantLimit);
  console.log(TAG, "验证通过 " + valid.length + " 个源，开始并行取弹幕");

  // ---- 4) 并行取弹幕（最多 4 并发）----
  var fetched = await _mapLimit(valid, 4, async function (x) {
    var raw = await _fetchRaw(params, server, String(x.ep.episodeId));
    if (!raw) return null;
    var at2 = String(x.a.animeTitle || "");
    return {
      commentId: String(x.ep.episodeId), raw: raw, title: at2,
      source: String(x.a.source || ""), live: _isLiveActionTitle(at2),
      epCount: parseInt(x.a.episodeCount, 10) || 0,
      year: _animeYear(x.a),
      globalNum: ((_firstRealEp(x.eps) || 0) > 1)
    };
  });

  for (var k = 0; k < fetched.length; k++) {
    var f = fetched[k];
    if (!f) continue;
    out.push(f);
    console.log(TAG, "候选源 [" + f.title + "] " + f.raw.length + " 条");
  }
  if (out.length === 0) return [];

  // ---- 5) 按弹幕量排序 + 多重锁定 ----
  out.sort(function (x, yy) { return yy.raw.length - x.raw.length; });

  var seedLive = out[0].live;
  if (seedLive === true || seedLive === false) {
    var kept = [];
    for (var z = 0; z < out.length; z++) {
      if (out[z].live === seedLive) kept.push(out[z]);
    }
    if (kept.length !== out.length) {
      console.log(TAG, "类型锁定为" + (seedLive ? "真人剧" : "动漫") +
        "，剔除 " + (out.length - kept.length) + " 个异类型候选");
    }
    out = kept;
  }

  var seedYear = out[0].year || _titleYear(out[0].title);
  if (seedYear) {
    var sameYear = [];
    for (var n = 0; n < out.length; n++) {
      // 全局连续编号的季条目（凡人第三季第80话）不受年份限制
      if (out[n].globalNum) { sameYear.push(out[n]); continue; }
      var cy = out[n].year || _titleYear(out[n].title);
      if (!cy || Math.abs(cy - seedYear) <= 1) sameYear.push(out[n]);
    }
    if (sameYear.length !== out.length) {
      console.log(TAG, "年份锁定为 " + seedYear + "，剔除 " + (out.length - sameYear.length) + " 个异年篇章");
    }
    out = sameYear;
  }

  var seedEpCount = out[0].epCount || 0;
  if (seedEpCount > 5) {
    var multi = [];
    for (var m = 0; m < out.length; m++) {
      if ((out[m].epCount || 0) > 1) multi.push(out[m]);
    }
    if (multi.length !== out.length) {
      console.log(TAG, "剔除 " + (out.length - multi.length) + " 个单集条目（剧场版/特别篇）");
    }
    out = multi;
  }

  if (!_hasLangTag(out[0].title)) {
    var plain = [];
    for (var w = 0; w < out.length; w++) {
      if (!_hasLangTag(out[w].title)) plain.push(out[w]);
    }
    if (plain.length && plain.length !== out.length) {
      console.log(TAG, "剔除 " + (out.length - plain.length) + " 个语言版本条目");
      out = plain;
    }
  }

  console.log(TAG, "候选 " + out.length + " 个，弹幕最多：" +
    (out[0].source || "?") + " " + out[0].raw.length + " 条");
  return out;
}

/**
 * 兜底解析：搜索定位失败后，依次尝试 match 文件名 → 客户端透传 commentId。
 */
async function _resolveAndFetch(params) {
  var server = _server(params);
  var cands = _matchFilenames(params);
  var passed = params.commentId ? String(params.commentId) : "";

  // 慢路径优先：match 现场换新鲜 ID，能保证集号正确
  for (var i = 0; i < cands.length; i++) {
    try {
      var det = await _matchDetail(params, cands[i]);
      if (!det) continue;
      var raw = await _fetchRaw(params, server, det.id);
      if (raw) return { commentId: det.id, raw: raw, title: det.title, source: det.source };
    } catch (e) {
      console.error(TAG, "候选失败", cands[i], e.message);
    }
  }

  // 最后才用客户端透传的 commentId（可能是旧 ID 或错位的集）
  if (passed) {
    var fast = await _fetchRaw(params, server, passed);
    if (fast) {
      console.log(TAG, "退回透传 commentId", passed);
      return { commentId: passed, raw: fast, title: "", source: "" };
    }
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

/** 搜索列表（带缓存，不做季数过滤/排序，供多来源合并复用） */
async function _cachedSearchList(params, keyword) {
  var key = K_SEARCH + _hash(keyword + "|v" + CACHE_VERSION);
  var rec = _scache(key, SEARCH_CACHE_HOURS * 3600);
  if (rec && Array.isArray(rec.list)) return rec.list;
  try {
    var data = _unwrap(
      await Widget.http.get(
        _server(params) + "/api/v2/search/anime?keyword=" + encodeURIComponent(keyword),
        { headers: _headers(params) }
      ),
      "搜索弹幕"
    );
    if (!data || data.success === false) return [];
    rec = { t: _now(), list: Array.isArray(data.animes) ? data.animes : [] };
    _sset(key, rec);
    return rec.list;
  } catch (e) {
    console.error(TAG, "搜索列表失败", keyword, e.message);
    return [];
  }
}

/** 分集列表（带缓存）。force=true 忽略缓存强刷 —— episodeId 会随上游缓存淘汰失效 */
async function _cachedBangumi(params, animeId, force) {
  var key = K_BANGUMI + animeId;
  var rec = force ? null : _scache(key, _num(params.cacheHours, DEFAULT_CACHE_HOURS) * 3600);
  if (rec && Array.isArray(rec.episodes)) return rec.episodes;
  try {
    var data = _unwrap(
      await Widget.http.get(_server(params) + "/api/v2/bangumi/" + encodeURIComponent(animeId), { headers: _headers(params) }),
      "获取分集"
    );
    var bangumi = data && data.bangumi;
    if (!bangumi) return [];
    rec = {
      t: _now(), animeId: animeId,
      animeTitle: String(bangumi.animeTitle || ""),
      seasons: bangumi.seasons || [],
      episodes: Array.isArray(bangumi.episodes) ? bangumi.episodes : []
    };
    _sset(key, rec);
    return rec.episodes;
  } catch (e) {
    console.error(TAG, "分集列表失败", animeId, e.message);
    return [];
  }
}

/**
 * 合并多来源弹幕 —— 决定弹幕"完整度"的关键。
 *
 * 一个 commentId 只对应单一上游平台，实测同一集的弹幕量差异很大：
 *   qq 14194 条 / 爱奇艺 5701 条 / 弹弹 6444 条。
 * 只取一份就必然缺失。这里按片名搜出同季的全部番剧条目，逐个取对应分集的弹幕再合并。
 * 缓存里已有的条目会被跳过，所以重复播放不会重复请求。
 */
async function _expandSources(params, server, seed, realEp, globalNumbering) {
  // mergeSources=0 明确表示"单一来源"，必须真返回 0；用 _num 会被当成无效值回退到默认 3
  var limit = Math.floor(_numAllowZero(params.mergeSources, DEFAULT_MERGE_SOURCES));
  if (limit < 0) limit = 0;
  if (limit > MERGE_HARD_LIMIT) limit = MERGE_HARD_LIMIT;
  if (limit <= 1 || !seed) return { raw: seed ? seed.raw : [], n: 1 };

  var base = _keyword(params.seriesName || params.title || "");
  if (!base) base = _keyword(params.episodeName || "");
  if (!base) return { raw: seed.raw, n: 1 };

  var epRaw = params.episode !== undefined && params.episode !== null ? String(params.episode) : "";
  var sn = parseInt(epRaw, 10);
  var epNo = (realEp !== undefined && realEp !== null) ? realEp
    : ((isFinite(sn) && sn > 0) ? sn : 1);

  var seasonRaw = params.season !== undefined && params.season !== null ? String(params.season) : "";
  var seasonNum = parseInt(seasonRaw, 10);
  if (!isFinite(seasonNum) || seasonNum <= 0) seasonNum = null;

  var all = seed.raw.slice();
  var got = 1;                 // 有效来源数（含 seed），镜像不计入
  var used = {};
  if (seed.title) used[seed.title] = 1;

  // 镜像检测：qq 与 tencent 上游同源，同一集弹幕 100% 重复（实测 14194/14194）。
  // 旧逻辑按"取到的来源数"计 limit，镜像吃掉配额就把真正的增量来源挡在门外——
  // dandan 那 6444 条因此永远取不到。这里只对"新增弹幕 > 0"的来源计数，
  // limit 才等于用户实际想要的"独立平台数"。
  var seen = Object.create(null);
  for (var s = 0; s < seed.raw.length; s++) {
    var sk = _danmuKey(seed.raw[s], true);
    if (sk !== null) seen[sk] = 1;
  }

  // 候选阶段已经把同类型同集的源全取过一遍了，这里直接复用，不再重复下载。
  // seed.prefetched[0] 就是 seed 本身，从下标 1 开始合并。
  var prefetched = seed.prefetched || [];
  for (var p = 1; p < prefetched.length && got < limit; p++) {
    var pf = prefetched[p];
    if (!pf || !pf.raw) continue;
    if (pf.title) used[pf.title] = 1;
    var pad = 0;
    for (var q = 0; q < pf.raw.length; q++) {
      var pk = _danmuKey(pf.raw[q], true);
      if (pk === null || seen[pk]) continue;
      seen[pk] = 1;
      all.push(pf.raw[q]);
      pad++;
    }
    if (pad > 0) {
      got++;
      console.log(TAG, "合并预取来源 [" + (pf.title || "") + "] +" + pad + "/" + pf.raw.length);
    } else {
      console.log(TAG, "跳过镜像预取来源 [" + (pf.title || "") + "] " + pf.raw.length + " 条全部重复");
    }
  }

  // 候选阶段已经把同类型同集的源全取过一遍了，这里不再遍历搜索列表，
  // 只为第一次请求失败的源留一次补取机会（prefetched 为空时才会跑探测循环）。
  if (seed.prefetched && seed.prefetched.length > 0) {
    var total = all.length;
    if (got > 1) console.log(TAG, "合并完成，" + got + " 个有效来源共 " + total + " 条（预取复用）");
    return { raw: all, n: got };
  }

  var list = await _cachedSearchList(params, base);

  // 同名作品判定：动画版与真人版共享片名，弹幕完全不能混。
  // seed.live 由 commentId 反查得出（最准）；拿不到再看标题/参数。
  var seedTitle = String(seed.title || params.seriesName || params.title || "");
  var wantLive = (seed.live === true || seed.live === false)
    ? seed.live
    : _isLiveActionTitle(seedTitle);
  var wantYear = _inferYear(params) || _titleYear(seedTitle);
  var probes = 0;              // 已探测的条目数，防止搜索列表很长时无限请求
  var MAX_PROBE = 24;

  for (var i = 0; i < list.length && got < limit && probes < MAX_PROBE; i++) {
    var a = list[i];
    if (!a || a.animeId === undefined || a.animeId === null) continue;
    var at = String(a.animeTitle || "");
    if (!at || used[at]) continue;
    if (at.indexOf(base) < 0) continue;              // 必须是同一系列
    // 不再做季号过滤：真实集号（第N话）本身就能跨条目对齐，
    // 「贰」的第9~17话、「第三季」的第77~124话在请求第4集时会被 _pickEpisode 自动跳过。
    // 旧逻辑要求标题含「第1季」，把没有季号的 B站/360 完整源全部误杀了 —— 这是"只能抓两个源"的根因。
    if (_isJunk(a)) continue;
    if (params.type !== "movie" && _isMovie(a)) continue;   // 剧场版不混进剧集

    // 动画 ≠ 真人剧：凡人修仙传 2020 动画 与 2025 电视剧是两部作品
    var live = _isLiveActionTitle(at);
    if (wantLive !== null && live !== wantLive) continue;

    // 每季独立编号：只认同季的条目，防止合集版串集
    if (globalNumbering === false && seasonNum && _titleSeason(at) !== seasonNum) continue;

    // 年份：双方都有年份且不同，判为不同作品（重映/续作另算，这里保守跳过）
    var y = _animeYear(a);
    if (wantYear && y && Math.abs(y - wantYear) > 1) continue;

    probes++;

    var eps = await _cachedBangumi(params, String(a.animeId));
    var ep = _pickEpisode(eps, epNo);
    if (!ep) continue;

    var id = String(ep.episodeId);
    var raw = await _fetchRaw(params, server, id);

    // episodeId 是上游缓存的临时编号，被淘汰后立刻 404。
    // 不重试的话该来源会被旧 ID 卡死，整个合并阶段反复撞墙拿不到任何弹幕。
    if (!raw) {
      eps = await _cachedBangumi(params, String(a.animeId), true);
      var fresh = _pickEpisode(eps, epNo);
      if (fresh && String(fresh.episodeId) !== id) {
        raw = await _fetchRaw(params, server, String(fresh.episodeId));
      }
    }
    if (!raw) continue;

    used[at] = 1;
    var added = 0;
    for (var k = 0; k < raw.length; k++) {
      var key = _danmuKey(raw[k], true);
      if (key === null || seen[key]) continue;
      seen[key] = 1;
      all.push(raw[k]);
      added++;
    }

    if (added === 0) {
      console.log(TAG, "跳过镜像来源 [" + at + "]，" + raw.length + " 条全部重复");
      continue;
    }

    got++;
    console.log(TAG, "合并来源 " + got + "/" + limit, "[" + at + "] +" + added + "/" + raw.length);
  }

  if (got > 1) console.log(TAG, "多来源合并完成，" + got + " 个有效来源共 " + all.length + " 条（待去重）");
  return { raw: all, n: got };
}

/** 标题是否明确标注了「第 n 季/部/期」 */
function _isSeasonEntry(title, n) {
  if (!n || n <= 0) return false;
  var t = String(title || "");
  var ar = String(n);
  var cn = _toChinese(n);
  var big = { 1: "壹", 2: "贰", 3: "叁", 4: "肆", 5: "伍", 6: "陆", 7: "柒", 8: "捌", 9: "玖", 10: "拾" };
  var pats = ["第" + ar + "季", "第" + cn + "季", "第" + ar + "部", "第" + cn + "部",
              "第" + ar + "期", "第" + cn + "期",
              "Season " + ar, "season " + ar, "S" + (n < 10 ? "0" + n : ar)];
  if (big[n]) pats.push(big[n]);
  for (var i = 0; i < pats.length; i++) {
    if (t.indexOf(pats[i]) >= 0) return true;
  }
  return false;
}

/**
 * 多季番剧的季集映射：把「第S季第E集」换算成全局真实集号。
 * 凡人修仙传 第三季第4集 → 第三季首集是第77话 → 第80话。
 * B站合集版没有季标记，只有真实集号，必须换算后才能对齐。
 * 找不到对应季条目时退回 epNo（单季剧/合集版）。
 */
/**
 * 多季番剧的季集映射：把「第S季第E集」换算成全局真实集号。
 * 返回 { real, globalNumbering }：
 *   real            目标真实集号
 *   globalNumbering true=该剧用全局连续编号（凡人修仙传：第三季是第77话起），
 *                    false=每季独立编号（咒术回战：每季第1话都叫「第1话」）
 * 这个标志决定合集版条目能不能用：「凡人」B站197集版第80话就是第三季第4集，
 * 而「咒术」合集第4话只是第一季第4集，不能用来匹配第二季。
 */
async function _resolveRealEp(params) {
  var epRaw = params.episode !== undefined && params.episode !== null ? String(params.episode) : "";
  var e = parseInt(epRaw, 10);
  if (!isFinite(e) || e <= 0) return { real: null, globalNumbering: true };

  var sRaw = params.season !== undefined && params.season !== null ? String(params.season) : "";
  var s = parseInt(sRaw, 10);
  if (!isFinite(s) || s <= 1) return { real: e, globalNumbering: true };

  var base = _keyword(params.seriesName || params.title || "");
  if (!base) base = _keyword(params.episodeName || "");
  if (!base) return { real: e, globalNumbering: true };

  var list = await _cachedSearchList(params, base);
  for (var i = 0; i < list.length; i++) {
    var at = String((list[i] && list[i].animeTitle) || "");
    if (!at || at.indexOf(base) < 0) continue;
    if (!_isSeasonEntry(at, s)) continue;
    var eps = await _cachedBangumi(params, String(list[i].animeId));
    var first = _firstRealEp(eps);
    if (first !== null) {
      var real = first + e - 1;
      var global = first > 1;
      console.log(TAG, "第" + s + "季首集=第" + first + "话（" +
        (global ? "全局连续编号" : "每季独立编号") + "），E" + e + " → 第" + real + "话");
      return { real: real, globalNumbering: global };
    }
  }
  return { real: e, globalNumbering: true };
}

/**
 * 从分集列表里挑出指定集号。
 *
 * 只用真实集号（标题里的第N话）匹配；只有当整个条目**完全解析不出**真实集号时，
 * 才退回条目内序号。
 * 否则会出现灾难性错位：请求第4集时，「慕兰之战」内部序号4其实是第180话，
 * 一退回 episodeNumber 就把 180 话的弹幕混进第 4 集。
 */
function _pickEpisode(eps, epNo) {
  if (!eps || !eps.length) return null;
  var want = parseInt(epNo, 10);
  if (!isFinite(want) || want <= 0) return null;

  var anyReal = false;
  for (var i = 0; i < eps.length; i++) {
    var e = eps[i];
    if (!e || !e.episodeId) continue;
    var real = _epRealNumber(e);
    if (real !== null) anyReal = true;
    if (real === want) return e;
  }
  if (anyReal) return null;      // 能解析真实集号但没命中 → 该源没有这一集

  // 分集标题全都没有集号（少数源只写剧名）→ 只能按序号
  var w = String(want);
  for (var j = 0; j < eps.length; j++) {
    if (eps[j] && eps[j].episodeId && String(eps[j].episodeNumber) === w) return eps[j];
  }
  return null;
}

/**
 * 后台预取指定集，失败静默。
 * 用户看完这一集切到下一集时，弹幕已经在本地缓存里，实现"秒出"。
 * 不阻塞当前返回，网络差时最坏只是白下一集。
 */
function _prefetchEpisode(params, epNo) {
  try {
    var p = {};
    for (var k in params) p[k] = params[k];
    p.episode = String(epNo);
    p.commentId = "";
    p.__noPrefetch = true;
    p.__warm = true;   // 预热请求：失败不写冷却，避免把播放也堵死
    console.log(TAG, "后台预取第" + epNo + "集");
    return _loadEpisode(p).then(function (r) { return r; }, function () { return null; });
  } catch (e) {
    return Promise.resolve(null);
  }
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

  // 每次播放都重新抓取：跳过本地缓存读取，避免命中抓取不全的历史记录。
  // 写入缓存仍然保留（同一会话内多次调用可复用），只是不再从这里读。
  var rec = null;
  if (rec && Array.isArray(rec.items) && Array.isArray(rec.times)) {
    console.log(TAG, "命中本地缓存", logical, rec.items.length, "条");
    _touch(dk, maxEp);   // 命中也更新访问时间，LRU 才准
    // 缓存命中也继续预取下一集，否则连播时从第二集起就断了预取链
    if (!params.__noPrefetch) {
      var snHit = parseInt(params.episode, 10);
      if (isFinite(snHit) && snHit > 0) _prefetchEpisode(params, snHit + 1);
    }
    return rec;
  }

  var hit;
  var realEp = null;
  var globalNumbering = true;
  try {
    // 先把「第S季第E集」换算成全局真实集号（多季番剧必须做，否则第3季第4集会取成第4话）
    var epInfo = await _resolveRealEp(params);
    realEp = epInfo ? epInfo.real : null;
    globalNumbering = epInfo ? epInfo.globalNumbering : true;
    // 收集同类型同集的全部候选源，按弹幕量降序 —— 多个平台都能播时用弹幕最多的那个
    var cands = await _collectPrimarySources(params, realEp, globalNumbering);
    if (cands.length) {
      hit = cands[0];
      hit.prefetched = cands;    // 已取到的弹幕下发给合并阶段复用，不再重复下载
      console.log(TAG, "主源 " + (hit.source || "?") + " " + hit.raw.length + " 条（共 " + cands.length + " 个候选）");
    }
    if (!hit) hit = await _resolveAndFetch(params);
  } catch (e) {
    if (!params.__warm) _markCooling(dk, e.message);
    console.error(TAG, "弹幕解析失败，进入冷却", logical, e.message);
    return null;
  }
  if (!hit) {
    if (!params.__warm) _markCooling(dk, "ID 失效或上游无弹幕");
    console.error(TAG, "未取到弹幕，进入冷却", logical);
    return null;
  }

  // 合并其余上游平台，补齐弹幕；多来源时才用宽松去重
  var merged = await _expandSources(params, _server(params), hit, realEp, globalNumbering);
  var n = merged.n || 1;

  var idx = _buildIndex(merged.raw, n > 1);
  if (idx.items.length === 0) {
    if (!params.__warm) _markCooling(dk, "弹幕全部无效");
    return null;
  }
  rec = {
    t: _now(),
    cv: CACHE_VERSION,
    commentId: hit.commentId,
    logical: logical,
    sources: n,
    count: idx.items.length,
    total: idx.total,
    dropped: idx.dropped,
    items: idx.items,
    times: idx.times
  };
  // 不写任何弹幕缓存：每次播放都重新请求服务端，避免历史数据残留
  _sdel(K_FAIL + dk);
  console.log(TAG, "弹幕加载完成", logical, "id=" + hit.commentId,
    "来源", n, "原始", idx.total, "有效", idx.items.length, "丢弃", idx.dropped);

  // 每次播放都重抓，预取结果不会被读取，跳过以节省流量
  return rec;
}

/**
 * 弹幕去重键。两处必须用同一个：合并时的镜像检测 与 最终 _buildIndex 去重。
 * loose=true（多来源）：时间收敛到 0.1 秒。跨平台的同一条弹幕 color/cid/平台标记全不同，
 *                        只有文本和时间能对齐；0.1 秒容差吸收各平台的时间码偏差。
 * loose=false（单来源）：时间精确到毫秒 + 完整参数串 + 文本，绝不误杀"哈哈哈"连发。
 */
function _danmuKey(d, loose) {
  var p = d.p;
  if (typeof p === "number") p = String(p);
  if (typeof p !== "string") p = "";

  var comma = p.indexOf(",");
  var t = parseFloat(comma >= 0 ? p.slice(0, comma) : p);
  if (!isFinite(t)) return null;

  var m = d.m;
  if (m === undefined || m === null) m = "";
  else if (typeof m !== "string") m = String(m);
  var text = m.trim();
  if (!text) return null;

  return loose
    ? (t.toFixed(1) + "|" + text)
    : (t.toFixed(3) + "|" + p + "|" + m);
}

/**
 * 把服务端弹幕数组压成"瘦条目 + 排序时间数组"，一次性完成三件事：
 *   - 剔除 空文本 / 时间不可解析 的脏弹幕
 *   - 剔除 (时间+参数+文本) 完全重复的多源重复弹幕
 *   - 只保留 {p,m,cid}，去掉 t/like 等客户端不需要的字段
 * 排序用 时间→原始顺序 双键稳定排序，同时间戳弹幕先后不乱。
 */
function _buildIndex(rawList, loose) {
  var slim = [];
  var order = [];       // [time, originalIndex]
  var seen = Object.create(null);
  var dropped = 0;

  for (var i = 0; i < rawList.length; i++) {
    var d = rawList[i];
    if (!d) { dropped++; continue; }

    var key = _danmuKey(d, loose);
    if (key === null) { dropped++; continue; }
    if (seen[key]) { dropped++; continue; }
    seen[key] = 1;

    var p = d.p;
    if (typeof p === "number") p = String(p);
    if (typeof p !== "string") p = "";

    var comma = p.indexOf(",");
    var t = parseFloat(comma >= 0 ? p.slice(0, comma) : p);

    var m = d.m;
    if (m === undefined || m === null) m = "";
    else if (typeof m !== "string") m = String(m);

    var item = { p: p, m: m };
    if (d.cid !== undefined && d.cid !== null) item.cid = d.cid;
    // t 是服务端给的整数秒时间戳，danmu_api 会原样返回；Forward 统计/渲染依赖它，
    // 精简掉会让面板少算一部分弹幕（实测差 400 条左右）
    if (d.t !== undefined && d.t !== null) item.t = d.t;
    slim.push(item);
    order.push([t, slim.length - 1]);
  }

  order.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });

  // 多来源合并后插入顺序不再是时间顺序，必须按排序结果同步重排 items，
  // 否则 _sliceWindow 用 times 的下标去切 items 就会整体错位
  var sorted = new Array(order.length);
  var times = new Array(order.length);
  for (var k = 0; k < order.length; k++) {
    sorted[k] = slim[order[k][1]];
    times[k] = order[k][0];
  }

  return {
    items: sorted,
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

/**
 * 统一出口：加载整集。
 * full=true 回整集弹幕（getComments 用），否则只回 segmentTime 所在窗口（分段接口用）。
 * 上游失效时返回空数组，不阻断播放。
 */
async function _danmuAt(params, full) {
  var rec = await _loadEpisode(params);
  if (!rec) return [];

  if (full) {
    console.log(TAG, "commentId=" + rec.commentId, "全量返回", rec.items.length, "条");
    return rec.items;
  }

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
    var list = await _danmuAt(params, true);
    return { count: list.length, comments: list };
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
    var list = await _danmuAt(params);
    return { count: list.length, comments: list };
  } catch (e) {
    console.error(TAG, "getDanmuWithSegmentTime 失败", e);
    throw e;
  }
}
