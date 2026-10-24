/**
 * 江砚弹幕模块（DandanPlay v2 兼容协议）
 *
 * 数据源: 由「弹幕服务器」参数指定（DandanPlay v2 兼容协议，如 danmu_api 自部署实例）
 *   POST /api/v2/match   {matchMode, videoDuration, fileName, fileHash, fileSize}  自动匹配
 *     fileName 优先用播放器传来的 fileName，没有时用标题+季集合成；年份只从 params 拼入 fileName
 *   GET  /api/v2/bangumi/:animeId            分集列表
 *   GET  /api/v2/comment/:commentId          整集弹幕（无 commentId 时先 match 再 comment）
 *
 * 设计原则：只做协议转换，不加工数据
 *   1) 三个环节全部实时请求，本地零缓存，每次播放都是最新数据；
 *   2) 全部走 match，不走 search/anime；流程是先 match 再 comment，match 未命中直接返回空；
 *   3) 年份匹配（开关 yearMatch）：只用 match 匹配年份，不用结果匹配年份。
 *      从 params 自带年份拼入文件名，只发一次 match，由 match 服务端按年份匹配；
 *      不用 search 结果定年份，也不用返回结果筛年份；
 *   4) 分集列表原样返回，只按 seasonId 收窄多季番剧；
 *   5) 弹幕原样返回，不合并、不去重、不切片、不精简字段。
 *
 * 协议依据: InchStudio/ForwardWidgets
 */

WidgetMetadata = {
  id: "zhiaon.logvar.danmu",
  title: "江砚弹幕",
  version: "4.9.0",
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
    },
    {
      name: "yearMatch",
      title: "匹配年份",
      type: "enumeration",
      description: "开启时把 params 自带年份拼入文件名，只用 match 匹配年份；关闭时纯标题不拼年份",
      value: "on",
      enumOptions: [
        { title: "开启", value: "on" },
        { title: "关闭", value: "off" }
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

// ============================ 年份提取 ============================

/** 从一段文本里提取年份：括号年份优先，其次“YYYY年”，最后独立的四位年份 */
function _yearFromText(text) {
  var s = String(text || "");
  var m = s.match(/[（(【\[]\s*(19\d{2}|20\d{2})\s*[）)】\]]/);
  if (m) return m[1];
  m = s.match(/(19\d{2}|20\d{2})\s*年/);
  if (m) return m[1];
  m = s.match(/(?:^|[^\d])(19\d{2}|20\d{2})(?:[^\d]|$)/);
  if (m) return m[1];
  return "";
}

/**
 * params 自带年份：优先 title，其次 year/releaseYear，再依次看
 * airDate/premiereDate/firstAirDate/releaseDate。
 * 这样 Forward 第一次调用时只要参数里有年份，match 文件名就带年份。
 * 注意：年份只从 params 拿，不从 search/match 结果里拿。
 */
function _extractYear(params) {
  if (!params) return "";
  var fields = ["title", "fileName", "year", "releaseYear", "airDate", "premiereDate", "firstAirDate", "releaseDate", "firstAired", "date"];
  for (var i = 0; i < fields.length; i++) {
    var y = _yearFromText(params[fields[i]]);
    if (y) return y;
  }
  return "";
}

/** 解析播放器传来的 fileName，如“凡人修仙传 S01E11”→标题/季/集 */
function _parseFileName(fileName) {
  var s = String(fileName || "").trim();
  var m = s.match(/^(.*?)\s+[Ss](\d+)[Ee](\d+)\b/);
  if (m) return { title: m[1].trim(), season: String(parseInt(m[2], 10)), episode: String(parseInt(m[3], 10)) };
  return { title: s, season: "", episode: "" };
}

/** 把年份拼入播放器 fileName：已有年份不重复；有季集时插在季集前，如“标题(2020) S01E11” */
function _insertYearIntoFileName(fileName, year) {
  var f = String(fileName || "").replace(/（/g, "(").replace(/）/g, ")");
  if (!year || f.indexOf("(" + year + ")") >= 0) return f;
  var m = f.match(/^(.*?)([ \t]+[Ss]\d+[Ee]\d+.*)$/);
  if (m) return m[1] + "(" + year + ")" + m[2];
  return f + "(" + year + ")";
}

/** 按另一播放器的参数格式组装 match 请求体：只发这五个字段，不多不少 */
function _matchBody(params, fileName) {
  return {
    matchMode: String((params && params.matchMode) || "fileNameOnly"),
    videoDuration: (params && params.videoDuration !== undefined && params.videoDuration !== null) ? (Number(params.videoDuration) || 0) : 0,
    fileName: fileName,
    fileHash: String((params && (params.fileHash || params.hash)) || ""),
    fileSize: (params && params.fileSize !== undefined && params.fileSize !== null) ? (Number(params.fileSize) || 0) : 0
  };
}

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
    _server(params); // 仅校验服务器已配置，match 里会再取一次
    // 另一播放器直接传 fileName（如“凡人修仙传 S01E11”）时，从 fileName 里拆标题/季/集
    var parsed = params.fileName ? _parseFileName(params.fileName) : { title: "", season: "", episode: "" };
    var season = params.season !== undefined && params.season !== null
      ? String(params.season) : (parsed.season || "");
    var keyword = params.title || parsed.title || "";

    if (!keyword) {
      console.log(TAG, "搜索关键词为空，返回空列表");
      return { animes: [] };
    }

    // 只走 match，不走 search：年份只用 match 匹配，match 文件名里带 params 自带年份。
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
        episodeCount: 0,
        commentId: m.episodeId                   // match 返回的 episodeId，Forward 拿到可直接调 comment，跳过 getDetail
      });
    }
    console.log(TAG, "匹配", keyword, "命中", animes.length, "部（match 直连）");
    if (animes.length) return { animes: animes };

    // match 未命中直接返回空，不再走 search/anime
    console.log(TAG, "匹配", keyword, "未命中，search 已去掉，返回空列表");
    return { animes: [] };
  } catch (e) {
    console.error(TAG, "searchDanmu 失败", e);
    throw e;
  }
}

/**
 * 调 /api/v2/match，命中返回原始 match 条目。
 * 播放器传了 fileName 时直接用它（只拼年份）；Forward 拿不到真实文件名时，
 * 用「标题 + 季集」合成，格式：标题(年份) S01E01（空格分隔，英文括号，无后缀）。
 * 请求体按播放器参数写：matchMode/videoDuration/fileName/fileHash/fileSize。
 * 命中只用于给候选排位，最终集号仍由 getDetailById 的 episodes 决定。
 */
async function _matchAnimeByName(params, title, season) {
  var ep = parseInt(params && params.episode, 10);
  var sn = parseInt(season, 10);
  var hasEp = isFinite(ep) && ep > 0;
  var hasSn = isFinite(sn) && sn > 0;

  // 年份匹配开关：控制是否把年份拼入文件名，由 match 服务端按年份匹配
  var yearMatch = String(_cfg(params, "yearMatch", "on")).toLowerCase() !== "off";

  // 标题规范化：中文括号转英文
  var baseTitle = String(title || "").replace(/（/g, "(").replace(/）/g, ")");

  // 年份只从 params 自带读取，不从结果里拿；拼入文件名后只发一次 match
  var year = yearMatch ? _extractYear(params) : "";
  console.log(TAG, "诊断 airDate=", JSON.stringify(params && params.airDate), "premiereDate=", JSON.stringify(params && params.premiereDate), "title=", JSON.stringify(params && params.title), "→ year=", year);
  if (year && baseTitle.indexOf("(" + year + ")") < 0) {
    baseTitle = baseTitle + "(" + year + ")";
  }

  var fileName;
  if (params && params.fileName) {
    // 另一播放器参数：直接用它传来的 fileName，只把 params 年份拼进去，不重拼标题/季集
    fileName = _insertYearIntoFileName(params.fileName, year);
  } else if (hasEp) {
    if (!hasSn) sn = 1;
    fileName = baseTitle + " S" + (sn < 10 ? "0" : "") + sn + "E" + (ep < 10 ? "0" : "") + ep;
  } else {
    fileName = baseTitle;                          // 电影/无季集：纯标题
  }
  try {
    var resp = await Widget.http.post(
      _server(params) + "/api/v2/match",
      JSON.stringify(_matchBody(params, fileName)),
      { headers: _headers(params) }
    );
    var data = _unwrap(resp, "文件名匹配");
    var list = data && Array.isArray(data.matches) ? data.matches : [];
    if (!data || !data.isMatched || !list.length) {
      console.log(TAG, "匹配", fileName, "→ 未命中");
      return [];
    }
    // 不用返回结果筛年份：年份匹配交给 match 服务端，match 返回原样
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
 * 整集弹幕：先 match 再 comment，跟另一播放器一样。
 * 1) 客户端给了 commentId（或 episodeId）就直接用它调 comment；
 * 2) 没给时，先按播放器参数调一次 match（fileName/matchMode/fileHash 等，年份拼入 fileName），
 *    取首条 match 的 episodeId 当 commentId，再调 comment；
 * 3) match 没命中就返回 null，不再调 comment。
 * comment 本身一次请求、原样返回、失败直接抛错。
 */
async function getCommentsById(params) {
  var server = params.server;
  var commentId = params.commentId || params.episodeId || "";

  if (!commentId) {
    // 无 commentId 时先 match 再 comment：fileName 直接用播放器传来的，没有时用标题
    var parsed = params.fileName ? _parseFileName(params.fileName) : { title: "", season: "" };
    var keyword = params.title || parsed.title || "";
    var season = params.season !== undefined && params.season !== null
      ? String(params.season) : (parsed.season || "");
    if (!keyword) return null;
    var hits = await _matchAnimeByName(params, keyword, season);
    if (!hits || !hits.length) return null;
    var first = hits[0];
    commentId = first.episodeId !== undefined && first.episodeId !== null
      ? first.episodeId
      : (first.commentId !== undefined && first.commentId !== null ? first.commentId : "");
    if (!commentId) return null;
    console.log(TAG, "无 commentId，先 match 再 comment", keyword, "→ commentId", commentId);
  }

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
