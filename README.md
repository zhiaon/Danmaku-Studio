# 江砚弹幕 (danmaku-module.js)

ForwardWidget 弹幕模块，对接 DandanPlay v2 兼容协议的弹幕 API（danmu_api 等）。

> **必须在「弹幕服务器」里填写 API 地址**，模块不内置任何默认服务器。

## 特性

- 🎯 **实时请求**：搜索、分集、弹幕三个环节每次播放都重新请求服务器，本地零缓存、零残留，数据始终最新
- 📡 **直连原样返回**：`getCommentsById` 拿到 `commentId` 后直接请求 `/api/v2/comment/{id}?withRelated=true&chConvert=1`，原样返回服务端数据，不做搜索/分集/合并/去重/精简
- 🎯 **match 优先排位**：搜索时并发调用 `/api/v2/match`（文件名用「标题.S01E01.mkv」合成），命中的番剧直接置顶；未命中或没有集数时完全退回搜索原序
- 🔀 **搜索排序对齐 danmu_api**：季数匹配的排前面，其余保持服务端原序，不做自有打分/类型偏好/剔除
- 🚫 **不内置默认地址**：server 为空时不产生任何请求，避免误连

## 接入

```
https://raw.githubusercontent.com/zhiaon/jiangyan-danmu/main/danmaku-module.js
```

导入后到模块设置里填写「弹幕服务器」，例如自部署的 danmu_api 地址 `https://{domain}/{token}`。

> 地址末尾**不要带** `/`，否则会拼出 `//api` 导致 404。

## 参数（globalParams）

| 参数 | 默认 | 说明 |
|---|---|---|
| server | **必填** | 弹幕服务器地址，末尾不带 `/`。未填写时不产生任何弹幕 |

## 模块结构

| id | 函数 | 作用 |
|---|---|---|
| `searchDanmu` | `searchDanmu` | 搜索番剧：并发 `/api/v2/match`，命中置顶；其后季数匹配优先 + 原序 |
| `getDetail` | `getDetailById` | 番剧分集列表，实时请求，原样返回 |
| `getComments` | `getCommentsById` | 主弹幕入口，直连 `/api/v2/comment/{commentId}` 原样返回 |

## 版本

当前版本 **3.3.4**

- **v3.3.4**：searchDanmu 并发调用 `/api/v2/match`（合成文件名 `标题.S01E01.mkv`），命中的番剧置顶；搜索仍是候选来源与兜底，match 失败/无集数不影响结果
- **v3.3.3**：searchDanmu 排序对齐 danmu_api（季数匹配优先 + 原序），不再做自有打分/类型偏好/剔除
- **v3.3.2**：搜索也不再缓存，模块彻底不读写 Widget.storage，每次播放全部实时请求
- **v3.3.1**：分集列表改为实时请求，剧集更新后新集立即出现（此前 24 小时缓存导致新集消失）
- **v3.2.1**：getCommentsById 完全照搬 danmu_api——单次请求、原样返回、失败直接抛错、无兜底
