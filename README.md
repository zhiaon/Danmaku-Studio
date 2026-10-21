# 江砚弹幕 (danmaku-module.js)

ForwardWidget 弹幕模块，对接 DandanPlay v2 兼容协议的弹幕 API（danmu_api 等）。

> **必须在「弹幕服务器」里填写 API 地址**，模块不内置任何默认服务器。

## 特性

- 🎯 **自动匹配**：`searchDanmu` 按关键词搜索番剧，类型/季数过滤 + 相关性打分；`getDetailById` 返回分集列表供 Forward 自动选中对应集
- 📡 **直连原样返回**：`getCommentsById` 拿到 `commentId` 后直接请求 `/api/v2/comment/{id}?withRelated=true&chConvert=1`，原样返回服务端数据，不做搜索/分集/合并/去重/精简——与 danmu_api 官方模块行为完全一致
- 📅 **年份匹配**：优先用服务端 `startDate` 字段提取年份，标题无括号的条目也能正确匹配（如 `凡人修仙传 魔道争锋` → 2021）
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
| server | **必填** | 弹幕服务器基地址（DandanPlay v2 兼容协议），末尾不带 `/`。未填写时不产生任何弹幕 |

## 模块结构

| id | 函数 | 作用 |
|---|---|---|
| `searchDanmu` | `searchDanmu` | 搜索番剧，类型/季数过滤 + 相关性打分 |
| `getDetail` | `getDetailById` | 番剧分集列表，多季合并时按 seasonId 收窄 |
| `getComments` | `getCommentsById` | 主弹幕入口，直连 `/api/v2/comment/{commentId}` 原样返回 |

## 版本

当前版本 **3.3.2**

- **v3.3.2**：搜索也不再缓存，模块彻底不读写 Widget.storage，每次播放全部实时请求
- **v3.3.1**：分集列表改为实时请求，剧集更新后新集立即出现（此前的 24 小时缓存会让新集消失）
- **v3.2.1**：`getCommentsById` 完全照搬 danmu_api——单次请求、原样返回、失败直接抛错、无兜底
- v3.2.0：直连 + 兜底（直连失败回退搜索/分集链路）
- v3.1.7：补回 `like` 字段，与 danmu_api 完全对齐
- v3.1.6：补回 `t` 字段
- v3.1.5：弹幕完全不落盘（读写缓存均禁用）
- v3.1.0：年份匹配从标题括号正则改为优先用服务端 `startDate`
