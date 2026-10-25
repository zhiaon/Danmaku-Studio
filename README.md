# 江砚弹幕 (danmaku-module.js)

ForwardWidget 弹幕模块，对接 DandanPlay v2 兼容协议的弹幕 API（danmu_api 等）。

> **必须在「弹幕服务器」里填写 API 地址**，模块不内置任何默认服务器。

## 特性

- 🎯 **先 match 再 comment**：没有 `commentId` 时先调一次 `/api/v2/match`，取首个匹配的 `episodeId` 再调 comment；match 未命中时返回空，不调 comment
- 📡 **comment 只带一个参数**：`GET /api/v2/comment/{id}?withRelated=true`，不带 `chConvert`，原样返回服务端数据
- 🚫 **没有 search 兜底**：`searchDanmu` 只走 `/api/v2/match`，未命中返回 `{animes: []}`，不调 `/api/v2/search/anime`
- 🎯 **match 请求体只有一个字段**：`POST /api/v2/match` 的请求体就是 `{"fileName": fileName}`，不带 `matchMode` / `videoDuration` / `fileHash` / `fileSize`
- 🗓️ **匹配年份只看参数自带年份**：见下方「匹配年份」一节，不查 search 结果、不按年份过滤结果
- 🪶 **只做协议转换**：整份文件 371 行、16 个函数，不读写 Widget.storage，每次播放都实时请求，本地零缓存
- 🚫 **不内置默认地址**：server 为空时不产生任何请求，避免误连

## 接入

```
https://raw.githubusercontent.com/zhiaon/jiangyan-danmu/main/danmaku-module.js
```

导入后到模块设置里填写「弹幕服务器」，例如自部署的 danmu_api 地址 `https://{domain}/{token}`。

> 地址末尾的 `/` 会被模块自动去掉，但建议还是不要带 `/`。

## 参数（globalParams）

| 参数 | 默认 | 说明 |
|---|---|---|
| server | **必填** | 弹幕服务器地址。未填写时不产生任何弹幕 |
| yearMatch | `on`（开启） | 匹配年份开关，见下方说明 |

## 匹配年份（yearMatch）

- 开启（默认）：只从播放器参数本身取年份，字段包括 `title`、`fileName`、`year`、`releaseYear`、`airDate`、`premiereDate`、`firstAirDate`、`releaseDate`、`firstAired`、`date`，年份形式包括 `(2020)`、`2020年`、裸年份
- 取到年份后拼进 match 的 `fileName`：有 `fileName` 时插到集号前，例如 `凡人修仙传 S01E11` + 2020 → `凡人修仙传(2020) S01E11`；没有 `fileName` 时拼到标题后，再合成 `标题(年份) S01E01` 这样的文件名
- 关闭：不拼年份，`fileName` 原样发 match
- **注意**：剧集、动漫、电视剧的参数通常不带年份，这种情况下开关开着也不会产生年份匹配，这是目前接受的现状；电影参数带年份时，年份匹配正常生效
- 本模块不通过 search 结果找年份，也不对 match 结果按年份过滤

## 模块结构

| id | 函数 | 作用 |
|---|---|---|
| `searchDanmu` | `searchDanmu` | 只走 `/api/v2/match`，未命中返回空列表 |
| `getDetail` | `getDetailById` | `GET /api/v2/bangumi/{animeId}`，实时请求分集列表，多季时可按季过滤 |
| `getComments` | `getCommentsById` | 有 `commentId` / `episodeId` 时直连 comment；没有时先 match 再 comment |

## 版本

当前版本 **4.9.4**

- **v4.9.4**：与 4.9.3 功能相同，纯 JS 重新提交，解决此前 base64 存储导致 Forward 解析报错的问题
- **v4.9.3**：去掉全部注释，排除注释解析干扰，功能与 4.9.2 相同
- **v4.9.2**：match 请求体改回原来的一行，只含 `fileName`
- **v4.9.1**：comment 请求去掉 `chConvert`，只剩 `?withRelated=true`
- **v4.9.0**：改成先 match 再 comment，并去掉 search 请求
- **v4.8.0**：按另一播放器的参数写过五字段 match 请求体，后在 4.9.2 改回单字段
- **v4.7.1**：年份只用 match 匹配，来自参数本身，不用结果匹配年份
- **v3.3.5**：删除已停用的一整套旧引擎（多源合并、打分排序、集号解析、文件名兜底、分段索引、选集预热），文件从 1866 行降到 405 行；行为不变，三接口实测通过
