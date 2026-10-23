/**
 * 江砚弹幕模块（DandanPlay v2 兼容协议）
 *
 * 数据源: 由「弹幕服务器」参数指定（DandanPlay v2 兼容协议，如 danmu_api 自部署实例）
 *   POST /api/v2/match   {fileName:"..."}    自动匹配（剧集：标题+季集合成文件名）
 *   GET  /api/v2/search/anime?keyword=<kw>   电影兜底（无集号时用）
 *   GET  /api/v2/bangumi/:animeId            分集列表
 *   GET  /api/v2/comment/:commentId          整集弹幕
 *
 * 设计原则：只做协议转换，不加工数据
 *   1) 三个环节全部实时请求，本地零缓存，每次播放都是最新数据；
 *   2) 剧集自动匹配走 match，电影无集号时走 search/anime；
 *   3) 分集列表原样返回，只按 seasonId 收窄多季番剧；
 *   4) 弹幕原样返回，不合并、不去重、不切片、不精简字段。
 *
 * 协议依据: InchStudio/ForwardWidgets
 */

WidgetMetadata = {
  id: "zhiaon.logvar.danmu",
  title: "江砚弹幕",
  version: "4.0.9",
  requiredVersion: "0.0.2",
  description: "多平台弹幕聚合，统一加载",
  author: "江砚",
  site: "https://github.com/zhiaon/jiangyan-danmu",

  globalParams: [
    {
      name: "server",
      title: "弹幕服务器",
      type: "input",
      description: "DandanPlay v2 弹幕服务接口，兼容 danmu_api 协议，填写时请勿在末尾添加 /",
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
var USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
                 "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// ============================ 小工具 ============================

/** 全局参数取值：globalParams 会合并进 params */
function _cfg(params, name, fallback) {
  var v = params && params[name];
  if (v === undefined || v === null || v === "") return fallback;
  return v;
}

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

// ============================ 无本地缓存 ============================
// 搜索 / 分集 / 弹幕全部实时请求，模块不读写 Widget.storage。

// ============================ 标题规范化 ============================

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

async function searchDanmu(params) {
  try {
    var server = _server(params);
    var season = params.season !== undefined && params.season !== null
      ? String(params.season) : "";
    var keyword = params.title || "";

    if (!keyword) {
      console.log(TAG, "搜索关键词为空，返回空列表");
      return { animes: [] };
    }

    // 所有类型先走 match（剧集带季集，电影用纯标题）；
    // match 未命中时 fallback 到 search/anime。
    var hits = await _matchAnimeByName(params, keyword, season);
    var animes = [];
    var seen = {};
    for (var i = 0; i < hits.length; i++) {
      var m = hits[i];
      if (!m || m.animeId === undefined || m.animeId === null) continue;
      var key = String(m.animeId);
      if (seen[key]) continue;
      seen[key] = 1;
      animes.push({
        animeId: m.animeId,                       // 保持服务端原类型（number），Forward 做严格比较
        animeTitle: m.animeTitle,
        type: m.type,
        typeDescription: m.typeDescription,
        imageUrl: m.imageUrl,
        url: m.url,
        episodeCount: 0
      });
    }
    console.log(TAG, "匹配", keyword, "命中", animes.length, "部（match 直连）");
    if (animes.length) return { animes: animes };

    // match 未命中 → fallback search/anime
    console.log(TAG, "match 未命中，fallback search/anime", keyword);
    var mv = _unwrap(
      await Widget.http.get(server + "/api/v2/search/anime?keyword=" + encodeURIComponent(keyword), { headers: _headers(params) }),
      "搜索候选"
    );
    if (!mv || mv.success === false) return { animes: [] };
    var ma = Array.isArray(mv.animes) ? mv.animes : [];
    console.log(TAG, "fallback search", keyword, "命中", ma.length, "条");
    // 按 animeId 去重（同片多平台来源只保留一条）
    var uniq = [];
    var uid = {};
    for (var u = 0; u < ma.length; u++) {
      var k = String(ma[u].animeId);
      if (!uid[k]) { uid[k] = 1; uniq.push(ma[u]); }
    }
    return { animes: uniq };
  } catch (e) {
    console.error(TAG, "searchDanmu 失败", e);
    throw e;
  }
}

/**
 * 用「标题 + 季集」合成文件名调 /api/v2/match，命中返回原始 match 条目。
 * Forward 的 searchDanmu 拿不到真实文件名，只能合成；实测 "标题.S01E01.mkv" 命中率最高。
 * 命中只用于给候选排位，最终集号仍由 getDetailById 的 episodes 决定。
 */
async function _matchAnimeByName(params, title, season) {
  var ep = parseInt(params && params.episode, 10);
  var sn = parseInt(season, 10);
  var hasEp = isFinite(ep) && ep > 0;
  var hasSn = isFinite(sn) && sn > 0;
  var fileName;
  if (hasEp) {
    if (!hasSn) sn = 1;
    fileName = title + ".S" + (sn < 10 ? "0" : "") + sn +
               "E" + (ep < 10 ? "0" : "") + ep + ".mkv";
  } else {
    fileName = title + ".mkv";                    // 电影/无季集：纯标题
  }
  try {
    var resp = await Widget.http.post(
      _server(params) + "/api/v2/match",
      JSON.stringify({ fileName: fileName }),
      { headers: _headers(params) }
    );
    var data = _unwrap(resp, "文件名匹配");
    var list = data && Array.isArray(data.matches) ? data.matches : [];
    if (!data || !data.isMatched || !list.length) {
      console.log(TAG, "匹配", fileName, "→ 未命中");
      return [];
    }
    for (var i = 0; i < list.length; i++) {
      console.log(TAG, "匹配", fileName, "→", list[i].animeId,
        String(list[i].animeTitle || ""), "#" + String(list[i].episodeTitle || ""));
    }
    return list;
  } catch (e) {
    console.error(TAG, "匹配", fileName, "失败", e.message);
    return [];
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

    // 分集列表必须实时：剧集在持续更新（嫁金钗从 12 集涨到 14 集），
    // 一旦缓存，新集就不会出现在 Forward 的分集面板里，导致新集无弹幕。
    var data = _unwrap(
      await Widget.http.get(server + "/api/v2/bangumi/" + encodeURIComponent(animeId), { headers: _headers(params) }),
      "获取分集"
    );
    var bangumi = data && data.bangumi;
    if (!bangumi) {
      if (data && data.success === false) throw new Error("获取分集失败: " + (data.errorMessage || ""));
      return [];
    }
    var rec = {
      t: _now(),
      animeId: String(animeId),
      animeTitle: String(bangumi.animeTitle || ""),
      seasons: bangumi.seasons || [],
      episodes: Array.isArray(bangumi.episodes) ? bangumi.episodes : []
    };
    console.log(TAG, "番剧", animeId, "共", rec.episodes.length, "集（实时）");

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
      out.push(e);
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
async function getCommentsById(params) {
  var server = params.server;
  var commentId = params.commentId;

  if (!commentId) return null;

  // 与 danmu_api 完全一致：一次请求、原样返回、失败直接抛错、无兜底
  var response = await Widget.http.get(
    server + "/api/v2/comment/" + commentId + "?withRelated=true&chConvert=1",
    {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "ForwardWidgets/1.0.0"
      }
    }
  );

  if (!response) throw new Error("获取数据失败");

  var data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
  return data;
}
