

WidgetMetadata = {
  id: "zhiaon.logvar.danmu",
  title: "许舟弹幕",
  version: "4.9.4",
  requiredVersion: "0.0.2",
  description: "Forward 弹幕接入模块，对接 DandanPlay v2 兼容 API",
  author: "许舟",
  site: "https://github.com/zhiaon/Danmaku-Studio",

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

      id: "searchDanmu",
      title: "搜索弹幕",
      functionName: "searchDanmu",
      type: "danmu",
      params: []
    },
    {

      id: "getDetail",
      title: "获取分集",
      functionName: "getDetailById",
      type: "danmu",
      params: []
    },
    {

      id: "getComments",
      title: "获取弹幕",
      functionName: "getCommentsById",
      type: "danmu",
      params: []
    }
  ]
};

var TAG = "[LogVarDanmu]";
var USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
                 "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

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

function _headers(params) {
  var base = _server(params);
  return {
    "User-Agent": USER_AGENT,
    "Accept": "application/json",

    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": base + "/",
    "Origin": base
  };
}

function _now() {
  return Math.floor(Date.now() / 1000);
}

function _unwrap(resp, what) {
  if (!resp) throw new Error(what + ": 无响应");
  if (resp.status && resp.status >= 400) {
    throw new Error(what + ": HTTP " + resp.status);
  }
  return resp.data;
}

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

function _extractYear(params) {
  if (!params) return "";
  var fields = ["title", "fileName", "year", "releaseYear", "airDate", "premiereDate", "firstAirDate", "releaseDate", "firstAired", "date"];
  for (var i = 0; i < fields.length; i++) {
    var y = _yearFromText(params[fields[i]]);
    if (y) return y;
  }
  return "";
}

function _parseFileName(fileName) {
  var s = String(fileName || "").trim();
  var m = s.match(/^(.*?)\s+[Ss](\d+)[Ee](\d+)\b/);
  if (m) return { title: m[1].trim(), season: String(parseInt(m[2], 10)), episode: String(parseInt(m[3], 10)) };
  return { title: s, season: "", episode: "" };
}

function _insertYearIntoFileName(fileName, year) {
  var f = String(fileName || "").replace(/（/g, "(").replace(/）/g, ")");
  if (!year || f.indexOf("(" + year + ")") >= 0) return f;
  var m = f.match(/^(.*?)([ \t]+[Ss]\d+[Ee]\d+.*)$/);
  if (m) return m[1] + "(" + year + ")" + m[2];
  return f + "(" + year + ")";
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
    _server(params);

    var parsed = params.fileName ? _parseFileName(params.fileName) : { title: "", season: "", episode: "" };
    var season = params.season !== undefined && params.season !== null
      ? String(params.season) : (parsed.season || "");
    var keyword = params.title || parsed.title || "";

    if (!keyword) {
      console.log(TAG, "搜索关键词为空，返回空列表");
      return { animes: [] };
    }

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
        animeId: m.animeId,
        animeTitle: m.animeTitle,
        type: m.type,
        typeDescription: m.typeDescription,
        imageUrl: m.imageUrl,
        url: m.url,
        episodeCount: 0,
        commentId: m.episodeId
      });
    }
    console.log(TAG, "匹配", keyword, "命中", animes.length, "部（match 直连）");
    if (animes.length) return { animes: animes };

    console.log(TAG, "匹配", keyword, "未命中，search 已去掉，返回空列表");
    return { animes: [] };
  } catch (e) {
    console.error(TAG, "searchDanmu 失败", e);
    throw e;
  }
}

async function _matchAnimeByName(params, title, season) {
  var ep = parseInt(params && params.episode, 10);
  var sn = parseInt(season, 10);
  var hasEp = isFinite(ep) && ep > 0;
  var hasSn = isFinite(sn) && sn > 0;

  var yearMatch = String(_cfg(params, "yearMatch", "on")).toLowerCase() !== "off";

  var baseTitle = String(title || "").replace(/（/g, "(").replace(/）/g, ")");

  var year = yearMatch ? _extractYear(params) : "";
  console.log(TAG, "诊断 airDate=", JSON.stringify(params && params.airDate), "premiereDate=", JSON.stringify(params && params.premiereDate), "title=", JSON.stringify(params && params.title), "→ year=", year);
  if (year && baseTitle.indexOf("(" + year + ")") < 0) {
    baseTitle = baseTitle + "(" + year + ")";
  }

  var fileName;
  if (params && params.fileName) {

    fileName = _insertYearIntoFileName(params.fileName, year);
  } else if (hasEp) {
    if (!hasSn) sn = 1;
    fileName = baseTitle + " S" + (sn < 10 ? "0" : "") + sn + "E" + (ep < 10 ? "0" : "") + ep;
  } else {
    fileName = baseTitle;
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

async function getDetailById(params) {
  try {
    var server = _server(params);
    var animeId = params.animeId;
    if (!animeId) throw new Error("缺少 animeId");

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

async function getCommentsById(params) {
  var server = params.server;
  var commentId = params.commentId || params.episodeId || "";

  if (!commentId) {

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
    server + "/api/v2/comment/" + commentId + "?withRelated=true",
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
