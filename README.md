# 江砚弹幕 (江砚弹幕.js)

[ForwardWidget](https://github.com/InchStudio/ForwardWidgets) 弹幕模块，对接 **LogVar 弹幕API**（DandanPlay v2 兼容协议），支持搜索、分集、分段弹幕加载。

> 数据源：`https://vidm.zhiaon.top/nzhyddtld`（无需 token）

## 特性

- 🎯 **准确**：每次用 `/api/v2/match` 按文件名现场换取新鲜 `episodeId`，避开服务端缓存淘汰导致 ID 失效 404 的坑
- 🧩 **完整**：同一集合并多个上游平台弹幕（qq / 爱奇艺 / 弹弹 …），单一来源会明显缺失（实测同集 14194 / 5701 / 6444 条）；合并后按 `时间(0.1s)+文本` 收敛去重，跨平台重复才真正去得掉
- ⚡ **快**：搜索 / 分集 / 整集弹幕全部落 `Widget.storage` 本地缓存，重复进片头零网络开销
- 📦 **轻量**：本地只存 `{p,m,cid}` 瘦字段 + 平行时间数组，按时间排序，二分定位分段窗口（5000 次切片 < 200ms）
- 🪟 **分段**：默认 180 秒一个窗口，基线固定 `floor(t/seg)*seg` + 前向重叠，只回当前段（~160KB），绝不整集 1.3MB 直发
- 🛡️ **鲁棒**：上游 404 / 空弹幕进 5 分钟冷却不炸播放；失败自动降级到透传 `commentId`
- 🧹 **干净**：搜索结果做类型/季数过滤 + 相关性打分，剔除「解说/合集/音乐会」等无弹幕条目；弹幕侧去脏去重

## 接入

在 ForwardWidget 里导入本文件（或直接填 raw URL）：

```
https://raw.githubusercontent.com/zhiaon/jiangyan-danmu/main/江砚弹幕.js
```

## 可调参数（globalParams）

| 参数 | 默认 | 说明 |
|---|---|---|
| server | `https://vidm.zhiaon.top/nzhyddtld` | 弹幕服务器基地址 |
| mergeSources | 3 | 同一集合并多少个上游平台的弹幕（0 = 单一来源，最快） |
| segmentSeconds | 180 | 每次返回的弹幕时间窗口长度（秒） |
| segmentPad | 3 | 窗口起点向前多取几秒，避免边界弹幕丢失 |
| cacheHours | 24 | 分集列表与整集弹幕的本地缓存有效期（小时） |
| maxCachedEpisodes | 5 | 整集弹幕缓存条数上限，超出淘汰最久未使用的 |

## 模块结构

| id | 函数 | 作用 |
|---|---|---|
| `searchDanmu` | `searchDanmu` | 搜索番剧，类型/季数过滤 + 打分排序 |
| `getDetail` | `getDetailById` | 番剧分集列表，多季合并时按 seasonId 收窄 |
| `getComments` | `getCommentsById` | 主弹幕入口，match→comment 链路 + 分段 |
| `getDanmuWithSegmentTime` | `getDanmuWithSegmentTime` | 按播放时刻取分段弹幕，共用缓存 |

## 本地测试

```bash
node test-logvar-danmu.js   # 37 项真实 API 测试
```

测试覆盖：搜索/季数过滤、电影类型排序、标题噪声清洗、分集列表、整集弹幕加载、分段缓存命中、时间点弹幕、窗口全覆盖、二分切片性能、脏数据过滤、LRU 淘汰、失败冷却、异常路径。
