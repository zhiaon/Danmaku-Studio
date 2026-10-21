/**
 * 江砚弹幕模块（DandanPlay v2 兼容协议）
 *
 * 数据源: 由「弹幕服务器」参数指定（DandanPlay v2 兼容协议，如 danmu_api 自部署实例）
 *   GET  /api/v2/search/anime?keyword=<kw>   搜索番剧
 *   POST /api/v2/match   {fileName:"..."}    按文件名反查（只用于给候选排位）
 *   GET  /api/v2/bangumi/:animeId            分集列表
 *   GET  /api/v2/comment/:commentId          整集弹幕
 *
 * 设计原则：只做协议转换，不加工数据
 *   1) 三个环节全部实时请求，本地零缓存，每次播放都是最新数据；
 *   2) 搜索结果原样返回，季数匹配的排前面，其余保持服务端原序；
 *   3) 分集列表原样返回，只按 seasonId 收窄多季番剧；
 *   4) 弹幕原样返回，不合并、不去重、不切片、不精简字段。
 *
 * 版本记录
 *   3.3.5  删除已停用的一整套旧引擎（多源合并/打分/集号解析/文件名匹配/分段），约 1400 行。
 *   3.3.4  searchDanmu 并发调用 /api/v2/match，命中的番剧置顶（search 仍作候选来源与兜底）。
 *   3.3.3  searchDanmu 排序完全对齐 danmu_api（季数匹配优先 + 原序）。
 *   3.3.2  移除全部本地缓存，模块不再读写 Widget.storage。
 *   3.3.1  分集列表改为实时请求，剧集更新后新集立即出现。
 *   3.2.1  getCommentsById 与 danmu_api 完全一致：1 次请求、原样返回、无兜底。
 *
 * 协议依据: InchStudio/ForwardWidgets
 */

// ============================ 元数据 ============================

WidgetMetadata = {
  id: "zhiaon.logvar.danmu",
  title: "江砚弹幕",
  version: "3.3.5",
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

    // 搜索不做本地缓存：每次播放都实时请求
    // match 与 search 并发：match 只负责给"命中番剧"排位，search 仍然是候选列表的来源
    var url = server + "/api/v2/search/anime?keyword=" + encodeURIComponent(keyword);
    var searchP = Widget.http.get(url, { headers: _headers(params) });
    var matchP = _matchAnimeByName(params, keyword, season);
    var data = _unwrap(await searchP, "搜索弹幕");
    var hit = await matchP;
    if (!data) return { animes: [] };
    if (data.success === false) {
      throw new Error("搜索弹幕失败: " + (data.errorMessage || "服务返回失败"));
    }
    var animes = Array.isArray(data.animes) ? data.animes : [];
    console.log(TAG, "搜索", keyword, "命中", animes.length, "条（实时）");

    // 排序与 danmu_api 一致
    if (season) {
      var matched = [], nonMatched = [];
      var isMovie = keyword.indexOf("电影") >= 0 || keyword.indexOf("movie") >= 0;
      for (var i = 0; i < animes.length; i++) {
        if (_matchSeasonDanmu(animes[i], keyword, season) && !isMovie) matched.push(animes[i]);
        else nonMatched.push(animes[i]);
      }
      animes = matched.concat(nonMatched);
    } else {
      var isMov = keyword.indexOf("电影") >= 0 || keyword.indexOf("movie") >= 0;
      if (isMov) {
        var m2 = [], n2 = [];
        for (var j = 0; j < animes.length; j++) {
          if (isMov) m2.push(animes[j]); else n2.push(animes[j]);
        }
        animes = m2.concat(n2);
      }
    }

    // 文件名匹配命中的番剧置顶：Forward 自动匹配默认取首个候选
    if (hit) {
      var hid = String(hit.animeId);
      var hIdx = -1;
      for (var k = 0; k < animes.length; k++) {
        if (animes[k] && String(animes[k].animeId) === hid) { hIdx = k; break; }
      }
      if (hIdx > 0) {
        var top = animes.splice(hIdx, 1)[0];
        animes.unshift(top);
        console.log(TAG, "匹配命中置顶", hid, String(top.animeTitle || ""));
      } else if (hIdx === 0) {
        console.log(TAG, "匹配命中已在首位", hid);
      } else {
        console.log(TAG, "匹配命中", hid, "但不在搜索结果中，保持原序");
      }
    }

    return { animes: animes };
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
  if (!isFinite(ep) || ep <= 0) return null;      // 没有集数，match 无从比对
  var sn = parseInt(season, 10);
  if (!isFinite(sn) || sn <= 0) sn = 1;
  var fileName = title + ".S" + (sn < 10 ? "0" : "") + sn +
                 "E" + (ep < 10 ? "0" : "") + ep + ".mkv";
  try {
    var resp = await Widget.http.post(
      _server(params) + "/api/v2/match",
      JSON.stringify({ fileName: fileName }),
      { headers: _headers(params) }
    );
    var data = _unwrap(resp, "文件名匹配");
    var hit = data && data.isMatched && Array.isArray(data.matches) && data.matches[0];
    if (!hit || hit.animeId === undefined || hit.animeId === null) {
      console.log(TAG, "匹配", fileName, "→ 未命中");
      return null;
    }
    console.log(TAG, "匹配", fileName, "→", hit.animeId, String(hit.animeTitle || ""),
      "#" + String(hit.episodeTitle || ""));
    return hit;
  } catch (e) {
    console.error(TAG, "匹配", fileName, "失败", e.message);
    return null;
  }
}

/** 季数匹配（与 danmu_api matchSeason 一致） */
function _matchSeasonDanmu(anime, queryTitle, season) {
  if (!anime || !anime.animeTitle) return false;
  var at = String(anime.animeTitle);
  if (at.indexOf(queryTitle) < 0) return false;
  var title = at.split("(")[0].trim();
  if (!title.startsWith(queryTitle)) return false;
  var after = title.substring(queryTitle.length).trim();
  if (after === "" && String(season) === "1") return true;
  var m = after.match(/\d+/);
  if (m && m[0] === String(season)) return true;
  var cm = after.match(/[一二三四五六七八九十壹贰叁肆伍陆柒捌玖拾]+/);
  if (cm && String(_cn2num(cm[0])) === String(season)) return true;
  return false;
}

function _cn2num(s) {
  if (/^\d+$/.test(s)) return Number(s);
  var map = { "一":1,"二":2,"三":3,"四":4,"五":5,"六":6,"七":7,"八":8,"九":9,"十":10,
    "壹":1,"贰":2,"叁":3,"肆":4,"伍":5,"陆":6,"柒":7,"捌":8,"玖":9,"拾":10 };
  var n = 0;
  for (var i = 0; i < s.length; i++) n = n * 10 + (map[s[i]] || 0);
  return n;
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
