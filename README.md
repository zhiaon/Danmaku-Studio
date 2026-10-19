# 江砚弹幕 (danmaku-module.js)

ForwardWidget 弹幕模块，对接 DandanPlay v2 兼容协议的弹幕 API（danmu_api 等）。

> **必须在「弹幕服务器」里填写 API 地址**，模块不内置任何默认服务器。

## 特性

- 🎯 **准确**：用 `/api/v2/match` 按文件名现场换取新鲜 `episodeId`，避开服务端缓存淘汰导致 ID 失效 404 的坑；透传 `commentId` 命中时直接跳过反查
- 🧩 **完整**：同一集合并多个上游平台弹幕（qq / 爱奇艺 / 弹弹 …），单一来源会明显缺失（实测同集 14194 / 5701 / 6444 条）；合并后按 `时间(0.1s)+文本` 收敛去重
- 🚫 **不数镜像**：qq 与 tencent 上游同源、弹幕 100% 重复，配额只对「新增弹幕>0」的来源计数，避免镜像吃满名额把真正的增量来源挡在门外
- 💾 **缓存**：搜索 / 分集 / 整集弹幕三级 `Widget.storage` 缓存，重复进入零网络开销
- 🛡️ **容错**：上游源失效返回空弹幕不阻断播放，失败进 5 分钟冷却不反复撞墙

## 接入

```
https://raw.githubusercontent.com/zhiaon/jiangyan-danmu/main/danmaku-module.js
```

导入后到模块设置里填写「弹幕服务器」，例如自部署的 danmu_api 地址 `https://{domain}/{token}`。

## 参数（globalParams）

| 参数 | 默认 | 说明 |
|---|---|---|
| server | **必填** | 弹幕服务器基地址（DandanPlay v2 兼容协议），末尾不带 `/`。未填写时不产生任何弹幕 |
| mergeSources | 3 | 同一集合并多少个上游平台的弹幕（0 = 单一来源，最快，上限 6） |
| segmentSeconds | 180 | 分段窗口长度（秒） |
| segmentPad | 3 | 窗口起点向前多取几秒，避免边界弹幕丢失 |
| cacheHours | 24 | 分集列表与整集弹幕的本地缓存有效期（小时） |
| maxCachedEpisodes | 5 | 整集弹幕缓存条数上限，超出淘汰最久未使用的 |

## 模块结构

| id | 函数 | 作用 |
|---|---|---|
| `searchDanmu` | `searchDanmu` | 搜索番剧，类型/季数过滤 + 相关性打分 |
| `getDetail` | `getDetailById` | 番剧分集列表，多季合并时按 seasonId 收窄 |
| `getComments` | `getCommentsById` | 主弹幕入口，返回 `{count, comments}` |

## 版本

当前版本 **2.0.0**
