# CineFlow

![CineFlow Preload](build/bg.png)

流畅、可定制的桌面电影/节目推荐应用。

**CineFlow**基于Electron + Vite构建，使用TMDB数据源、豆瓣API兜底，支持自然语言搜索、个性化推荐、搜索词条词云化、灵动岛模式、片源统一管理与应用内播放，并支持一键投屏到局域网设备。

## 简介

**CineFlow**是一款面向桌面端的电影/节目推荐应用，主打简洁UI、灵动岛模式、片源自管理与应用内续播。它使用TMDB作为元数据源，支持电影、电视剧、演员、关键词与类型发现。


除元数据发现外，它还内置一个**跨片源的实时搜索页**：按一个回车横扫你配置的全部在线片源，把同一部影视在多个源上的命中归并成一行，点一下直接起播 —— 找片与看片之间不再需要跳出去。

## 功能亮点

### 发现与浏览

- **每日推荐**：首页展示今日电影 / 节目、海报、评分、类型与简介。
- **电影 + 节目双检索**：同时覆盖 TMDB `movie` 与 `tv`，电视剧/综艺/节目都能被搜索与推荐。
- **双路搜索**：一路按影片标题命中关键词找片，一路把天气、心情、场景这类自然语言翻成检索意图（回南天、梅雨、高铁候机、夜宵、聚会、家务背景音…），两路结果合并去重。
- **自然语言搜索**：支持电影名、节目名、演员、题材等关键词，并自动扩展相关推荐；另备天气/心情/场景（回南天、梅雨、高铁候机、夜宵、聚会、家务背景音…）等扩展说法。
- **三页浏览，键盘 `←` / `→` 环形切换**：首页 / 分类片库 / 播放历史三块整屏板，`→` 走 `分类片库 → 播放历史 → 首页` 循环、`←` 反向循环。
- **分类片库**：媒体类型 × 年份双向筛选，下滑自动续拉、不限页数.
- **搜索记录**：搜索框下方弹出记录面板；搜索记录词条为词云/标签云样式，支持单条删除与清空，点一下即重放。
- **个性化推荐**：基于本机点击、收藏与搜索偏好调整推荐内容。(需自行申请API)
- **收藏面板**：顶栏"收藏"按钮，收藏列表从左侧拉出，一键直达介绍页播放。
- **灵动岛模式**：最小化后切换为灵动岛，支持拖动、展开搜索、贴边吸附与一键恢复主窗口；岛上形态下自动收起扩展页面，只保留基线岛。

### 观看与续播

- **应用内播放**：支持 HLS/DASH/FLV，电视剧资源可在播放器内显示本季剧集并切集。
- **播放历史与"接着看"**：零挂钩记录看过的每一条（含上次用的播放源、线路、集数与秒数）；支持单条删除（可撤销）与清空恢复。
- **播放器投屏**：播放器内投屏弹窗，主进程用 SSDP 发现 `MediaRenderer` 并经 SOAP 推送当前地址，可一键断开；本机蓝牙只列出无线显示器/扩展坞类型设备。
- **广告分片过滤**：三级过滤播放资源广告，任何异常自动回退原始清单，不影响播放。
- **播放优化**：窗口态拖动进度条抑制加载圈，全屏播放优先尝试 4K 并保持自适应回退。
- **无凭证也能播**：无TMDB凭证时，由豆瓣API兜底，豆瓣摘要资料卡下方会保留一条内置播放源

### 片源与网络

- **片源管理**：设置页右侧展示，支持单源/全部手动测速等。这里配置的源同时就是**搜索页横扫的范围** —— 加一条源，搜索页立刻多一路命中。
- **外部资源导入**：支持TVBox 配置、JSON 数组、`名称|接口地址` 分行写法或一个配置地址。
- **网络加速**：元数据经加密解析并在启动时预热建立本机索引，无代理也能完整展示；播放流量可选跟随代理/强制代理/直连，代理断开时播放不断开；连接复用 + 同域解析去重 + 端点健康门控，直连时海报与分片不再干等超时。
- **本机安全配置**：TMDB Key、代理与偏好设置保存在本机 `settings.json`，不写入源码，也不会被打进安装包。

### 保持最新

- **CF图标检查更新**：有新版本时左上角CF图标右上角亮圆点，并在其下方弹出气泡（版本号、按系统安装包、体积）。点图标可随时手动复查，再点收起。
- **一键更新，不跳浏览器**：点"立即更新"原地流式下载，完成后静默运行安装包，应用自行退出让安装器覆盖，再由安装器把新版拉起来。
- **按系统推荐**：Windows → `*-Setup.exe`；macOS → `*-arm64.dmg`（Apple Silicon）/ `*-x64.dmg`（Intel）；Linux → `*.AppImage`。
- **有一定边界**：只有**安装版**能原地覆盖；`win-unpacked` / 便携版会安装到标准位置并退出当前进程，旧的绿色目录不会被改写。

## 下载与安装

前往 GitHub Releases 下载最新版本：

[下载 CineFlow 最新版](https://github.com/incldue/CineFlow/releases)

支持环境：

- Windows 10 / Windows 11 / macOS / Linux（AppImage）
- Linux AppImage：x86_64；下载后执行 `chmod +x CineFlow-*-x86_64.AppImage`，再运行该文件（无需安装）

## 快速开始

### 1. 配置 TMDB

CineFlow 使用 TMDB 获取电影 / 节目元数据。首次启动后：

1. 点击右上角设置按钮。
2. 填入 TMDB v3 API Key 或 Read Access Token。
3. 点击保存并测试连接。
4. 也可以直接在设置里用“TMDB凭证”卡片的**一键获取**：浏览器里由用户点"批准"，应用自己轮询拿到、校验并落盘，再自动刷新首页。

开发模式也可以复制 `.env.example` 为 `.env`：

```ini
TMDB_API_KEY=
TMDB_READ_TOKEN=
```

两者任选其一即可。**(关于申请TMDB的API可以看目录内的"申请API.md").**


### 2. 代理设置

如果本机开启代理后可以在浏览器内访问 TMDB，但 CineFlow 提示网络失败，可在设置页填写：

```text
system
http://127.0.0.1:7890
socks5://127.0.0.1:7890
direct
```

- `system`：使用系统代理。
- `direct`：强制直连。
- `http://` / `socks5://`：使用指定本地代理。

## 项目结构

```text
CineFlow/
├─ build/                # 应用图标等构建资源
├─ electron/             # Electron 主进程与 preload
├─ scripts/              
├─ src/
├─ index.html
├─ package.json
├─ vite.config.mjs
|--申请API.md
└─ README.md
```

Proudly supported by the LINUX DO community.

## Star增长

<a href="https://www.star-history.com/?repos=incldue%2Fcineflow&type=date&logscale=&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=incldue/cineflow&type=date&theme=dark&legend=bottom-right" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=incldue/cineflow&type=date&legend=bottom-right" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=incldue/cineflow&type=date&legend=bottom-right" />
 </picture>
</a>



## License

本项目基于 [MIT License](LICENSE) 开源。

