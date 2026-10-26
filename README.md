# 江砚弹幕 (danmaku-module.js)

[![Version](https://img.shields.io/badge/version-4.9.4-blue)](https://github.com/zhiaon/jiangyan-danmu/blob/main/danmaku-module.js)

为 Forward 兼容播放器提供的开源弹幕接入模块，对接单个 DandanPlay v2 兼容 API，完成搜索、选集和弹幕加载。

**江砚弹幕是播放器模块，不是 danmu_api 服务端。** 模块需要连接另行部署的兼容 API，不附带公共接口、账号或密钥。仓库公开完整源码，单文件可独立运行。

## 在线安装

复制下面的 Raw 直链，在播放器的模块管理中选择「通过链接添加」或「通过 URL 导入」，粘贴后确认：

```text
https://raw.githubusercontent.com/zhiaon/jiangyan-danmu/main/danmaku-module.js
```

安装后填写「弹幕服务器」。模块 ID 保持 `zhiaon.logvar.danmu`，从旧版升级时原服务器配置继续有效。

```text
https://{domain}/{token}
```

> 地址末尾的 `/` 会被模块自动去掉，但建议还是不要带 `/`。server 为空时不产生任何请求，避免误连。

## 4.9.4 更新

- 纯 JS 重新提交，解决此前 base64 存储导致 Forward 解析报错的问题，功能与 4.9.3 相同。

## 4.9 功能

- **先 match 再 comment**：没有 `commentId` 时先调一次 `/api/v2/match`，取首个匹配的 `episodeId` 再调 comment；match 未命中时返回空，不调 comment。
- **comment 只带一个参数**：`GET /api/v2/comment/{id}?withRelated=true`，不带 `chConvert`，原样返回服务端数据。
- **没有 search 兜底**：`searchDanmu` 只走 `/api/v2/match`，未命中返回 `{animes: []}`，不调 `/api/v2/search/anime`。
- **match 请求体只有一个字段**：`POST /api/v2/match` 的请求体就是 `{"fileName": fileName}`，不带 `matchMode` / `videoDuration` / `fileHash` / `fileSize`。
- **实时请求**：整份文件 371 行、16 个函数，不读写 Widget.storage，每次播放都实时请求，本地零缓存。
- **只做协议转换**：不做多源合并、打分、去重、缓存、集号推断等中间层。

## 参数（globalParams）

| 参数 | 默认 | 说明 |
|---|---|---|
| server | **必填** | 弹幕服务器地址。未填写时不产生任何弹幕 |
| yearMatch | `on`（开启） | 匹配年份开关，见下方说明 |

## 匹配年份（yearMatch）

- 开启（默认）：只从播放器参数本身取年份，字段包括 `title`、`fileName`、`year`、`releaseYear`、`airDate`、`premiereDate`、`firstAirDate`、`releaseDate`、`firstAired`、`date`，年份形式包括 `(2020)`、`2020年`、裸年份。
- 取到年份后拼进 match 的 `fileName`：有 `fileName` 时插到集号前，例如 `凡人修仙传 S01E11` + 2020 → `凡人修仙传(2020) S01E11`；没有 `fileName` 时拼到标题后，再合成 `标题(年份) S01E01` 这样的文件名。
- 关闭：不拼年份，`fileName` 原样发 match。
- 本模块不通过 search 结果找年份，也不对 match 结果按年份过滤。

## 模块结构

| id | 函数 | 作用 |
|---|---|---|
| `searchDanmu` | `searchDanmu` | 只走 `/api/v2/match`，未命中返回空列表 |
| `getDetail` | `getDetailById` | `GET /api/v2/bangumi/{animeId}`，实时请求分集列表，多季时可按季过滤 |
| `getComments` | `getCommentsById` | 有 `commentId` / `episodeId` 时直连 comment；没有时先 match 再 comment |

## 更新与兼容

通过相同 Raw 地址更新即可。主分支直链始终提供当前正式版本。

- 仅配置一个 API，不使用来源编码 ID，旧版的选择和配置继续有效。
- 如果更新后 Forward 里仍显示旧版本，先区分是 Raw CDN 缓存还是 Forward App 本地缓存：删掉旧模块、彻底退出 Forward 再重开，用原 Raw 地址重新导入，导入后把弹幕服务器填回，并保持匹配年份开启。
- 服务器不可用时没有本地缓存兜底，请求会直接失败，这是实时请求的代价。

## 已知限制

- 剧集、动漫、电视剧的参数通常不带年份，这种情况下匹配年份开关开着也不会产生年份匹配，这是目前接受的现状；电影参数带年份时，年份匹配正常生效。
- match 未命中时不回退到 search，搜索结果为空是预期行为，不是接口故障。
- 本模块不托管、不存储、不提供任何视频和弹幕内容，弹幕数据全部来自用户自行填写的弹幕服务器。

## 开发

无需构建，单文件即成品。修改后请先做语法检查，再提交纯文本：

```sh
node --check danmaku-module.js
```

> 提交时请直接传纯 JS 文本，不要自行转成 base64 再传。GitHub Contents API 返回的 `content` 字段本身就是 base64 传输编码，那不代表仓库里存的是 base64；仓库里的文件必须以 `WidgetMetadata` 开头的纯 JS，否则 Forward 会解析报错。提交后请用纯文本比对验证本地与线上一致。

| 路径 | 内容 |
| --- | --- |
| `danmaku-module.js` | 可导入成品，371 行、16 个函数 |
| `README.md` | 本说明 |

## 反馈与贡献

欢迎通过 [Issues](https://github.com/zhiaon/jiangyan-danmu/issues) 反馈问题与改进。请提供模块版本、播放器和系统版本、作品类型与季集、预期行为及脱敏诊断，不要附带私人接口或凭据。

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

## 许可与致谢

作者：[江砚](https://github.com/zhiaon)。

本仓库暂未附带 LICENSE 文件。感谢 [danmu_api](https://github.com/huangxd-/danmu_api)、[ForwardWidgets](https://github.com/InchStudio/ForwardWidgets) 和 [弹弹play](https://www.dandanplay.com/) 的开源实现、协议与文档。
