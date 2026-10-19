# 江砚弹幕 (danmaku-module.js)

ForwardWidget 弹幕模块，对接 DandanPlay v2 兼容协议的弹幕 API（danmu_api 等），多来源合并 + 本地缓存 + 全量加载。

## 特性

- 🎯 **准确**：每次用 `/api/v2/match` 按文件名现场换取新鲜 `episodeId`，避开服务端缓存淘汰导致 ID 失效 404 的坑
- 🧩 **完整**：同一集合并多个上游平台弹幕（qq / 爱奇艺 / 弹弹 …），单一来源会明显缺失（实测同集 14194 / 5701 / 6444 条）；合并后按 `时间(0.1s)+文本` 收敛去重，跨平台重复才真正去得掉
- 🚫 **不数镜像**：qq 与 tencent 上游同源、弹幕 100% 重复，配额只对「新增弹幕>0」的来源计数，避免镜像吃满名额把真正的增量来源挡在门外
- 💾 **缓存**：搜索 / 分集 / 整集弹幕三级 `Widget.storage` 缓存，重复进入零网络开销
- 🛡️ **容错**：上游源失效返回空弹幕不阻断播放，失败进 5 分钟冷却不反复撞墙

## 接入

在 ForwardWidget 中导入模块文件：

```
https://raw.githubusercontent.com/zhiaon/jiangyan-danmu/main/danmaku-module.js
```

## 可调参数（globalParams）

| 参数 | 默认 | 说明 |
|---|---|---|
| server | `https://vidm.zhiaon.top/nzhyddtld` | 弹幕服务器基地址（DandanPlay v2 兼容协议） |
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
| `getComments` | `getCommentsById` | 主弹幕入口，match→comment 链路 + 多来源合并 |

返回格式：`{count, comments}`，与 danmu_api 模块完全一致。

## 本地测试

```bash
node test-logvar-danmu.js   # 43 项真实 API 测试
```

## 版本记录

| 版本 | 变更 |
|---|---|
| 1.2.3 | 弹幕服务器参数描述改通用表述（DandanPlay v2 兼容协议），不再限定 LogVar |
| 1.2.2 | 移除 `getDanmuWithSegmentTime` 注册，弹幕入口与 danmu_api 完全一致（3 函数） |
| 1.2.1 | `getCommentsById` 返回 `{count, comments}` 对齐 danmu_api；此前返回裸数组导致弹幕数显示 0 |
| 1.2.0 | 多来源合并不再被镜像源耗尽配额（qq/tencent 100% 重复），3 个独立来源 26339 条而非 19895 |
| 1.1.0 | 首屏加速：透传 `commentId` 命中则跳过 match 反查（~4.5s → ~1s） |
| 1.0.0 | 首个版本：分段加载 + 本地缓存 + 多来源合并 |
