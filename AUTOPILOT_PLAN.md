# GamerHead Autopilot 改造方案

> 分支:`feature/autopilot-batch`(基于 `main` @ `4a7ad15`)
> 状态:**待 review,尚未写任何实现代码**
> 目标:一次输入直接拿成品,支持一批 10 个成片,单页控制台,最终输出下载 URL

---

## 目录

- [0. 需求还原](#0-需求还原)
- [1. 现状为什么做不到](#1-现状为什么做不到)
- [2. 目标形态](#2-目标形态)
- [3. 总体架构](#3-总体架构)
- [4. 关键技术难点:服务端合成](#4-关键技术难点服务端合成)
- [5. 上传通道:为什么必须直传 GCS](#5-上传通道为什么必须直传-gcs)
- [6. 作业状态机与无人看守推进](#6-作业状态机与无人看守推进)
- [7. 流水线与校验门](#7-流水线与校验门)
- [8. 批量与变体设计](#8-批量与变体设计)
- [9. 单页控制台](#9-单页控制台)
- [10. API 设计](#10-api-设计)
- [11. 数据模型](#11-数据模型)
- [12. deploy.sh 兼容方案](#12-deploysh-兼容方案)
- [13. 环境变量](#13-环境变量)
- [14. 成本与配额](#14-成本与配额)
- [15. 实施分期](#15-实施分期)
- [16. 风险登记](#16-风险登记)
- [17. 待确认事项](#17-待确认事项)
- [附录 A:代码勘查证据](#附录-a代码勘查证据)

---

## 0. 需求还原

原始需求三条,我的理解如下:

| 原文 | 理解 |
|---|---|
| 每一步需要人来跟踪,希望输入指令之后直接拿到成品,中间的脚本和对话不用每一步操作 | 现状每步都要人干预是痛点。要**一次提交、全自动跑完**,脚本/台词不再逐段确认 |
| 如果可以支持批量产出 10 个成片会更好 | 一个 brief → **N 个(≤10)不同成片**,用于挑选/A-B 投放 |
| 控制台上输入合并到一个页面,中间步骤直接生成但是要有校验,最终结果直接输出 url 供用户下载 | **单页表单**替代三步向导;每步**自动但有校验**;交付**可下载 URL** |
| 和之前版本在 deploy.sh 中可以兼容,可以考虑增加一个选项 | 老部署路径行为不变,**新增一个选项**开启 Autopilot |

---

## 1. 现状为什么做不到

代码勘查结论(证据见[附录 A](#附录-a代码勘查证据)),有四个硬阻碍:

| # | 阻碍 | 位置 | 说明 |
|---|---|---|---|
| 1 | 流程由 UI 状态机驱动,服务端无编排者 | `App.tsx` / `components/Studio.tsx` | 服务端只有原子端点(`generate-script`、`generate-avatar`、`generate-video`…),"下一步做什么"全在前端。没有任何服务端对象代表"一个成片任务" |
| 2 | **最终合成在浏览器里** | `utils/videoUtils.ts:341` `compositePipVideo` | PiP / stacked 用 Canvas + `MediaRecorder` 实时绘制。关掉标签页即中断,更无法批量 10 个 |
| 3 | gameplay 素材进不了服务端 | `services/gemini.ts:74` | 只把压缩后的 720p webm 以 base64 走 `inlineData` 给脚本模型,**不落 GCS**;合成用的原片始终留在浏览器 |
| 4 | 字幕 SRT 在前端拼装 | `utils/subtitles.ts` | 服务端只有 `burn-subtitles`(接收前端传来的 SRT),自己不会生成 |

**有利条件**:容器内 `ffmpeg 7.1.5-0+deb13u1` 已具备 `overlay` / `scale` / `amix` / `vstack` 全部所需滤镜(实测确认),服务端复刻浏览器合成在能力上没有障碍。同时 `beginVideoJob`(`server.js:1343`)已封装好 Omni 回退链与 `content_blocked` 自动重投,**Autopilot 可直接复用,不需重写**。

---

## 2. 目标形态

```
一页表单填完 → 点 Generate → 等 → 拿到 N 个成片的下载 URL
```

- 中间脚本、分镜、头像、片段、拼接、合成、字幕**全自动**
- 每步**有校验**,不合格重试或标记失败,不让坏数据流向下一步
- **关掉浏览器任务继续跑**,回来还能看到结果
- **部分成功也交付**:10 个里成 8 个就给 8 个 URL,不整单回滚

---

## 3. 总体架构

```
浏览器（单页 Autopilot 控制台）
   │ ① POST /api/autopilot/upload-url        换取签名上传 URL
   │ ② PUT  → 直传 GCS                       绕过 Cloud Run 32MiB 限制
   │ ③ POST /api/autopilot/jobs              建作业 → { jobId }
   │ ④ GET  /api/autopilot/jobs/:id          轮询进度 + 取最终 URL
   ▼
Cloud Run 编排器  AutopilotJob 状态机（每步 checkpoint 到 Datastore）
   ├─ 脚本    gemini-3.7-flash          （复用 generate-script 逻辑）
   ├─ 头像    gemini-3.1-flash-image    （复用 generate-avatar 逻辑）
   ├─ 片段    beginVideoJob()           （复用 Omni 1.1→Flash→Veo 链 + 拦截重投）
   └─ 合成    ffmpeg 服务端新代码        （PiP / stacked / 音混 / 字幕）
   ▼
gs://<bucket>/autopilot/<jobId>/final-<n>.mp4
   ▼
签名 URL（1 小时）返回给浏览器下载
```

设计要点:**不能用一个阻塞请求跑完**。

实测单个 Omni 片段约 36 秒。10 个成片 × 约 4 段 = 40 个片段,叠加脚本/头像/合成,现实耗时约 **15 分钟**。虽然 Cloud Run `timeoutSeconds=3600` 撑得住,但:

- 一个挂 15 分钟的 HTTP 请求太脆,断网/刷新即全废
- 无法满足"关掉页面继续跑"

因此必须是**异步作业**模型。

---

## 4. 关键技术难点:服务端合成

这是本次改造**最大的新代码块**。需要把 `compositePipVideo` 的几何规则 1:1 搬到 ffmpeg 滤镜图。已从源码逐行提取出规则:

### 4.1 画布

| 目标比例 | 画布 |
|---|---|
| `16:9` | 1920 × 1080 |
| `9:16` | 1080 × 1920 |

### 4.2 背景(gameplay)

**cover 模式**缩放裁切:比画布宽则裁两侧,比画布高则裁上下,始终居中。
ffmpeg 对应 `scale` + `crop`。

### 4.3 前景(streamer)按布局

| 布局 | 规则 | ffmpeg |
|---|---|---|
| `classic-pip` | 头像占画面 **10% 面积**;`padding = width × 0.02`;位置四角可选(`top-left` / `top-right` / `bottom-left` / `bottom-right`,默认 `bottom-left`) | `overlay=x:y` |
| `stacked` | 上下分割,依 `stackedPlacement` 决定主播在上或下 | `vstack` |
| `streamer-only` | 不合成,仅拼接各片段 | 复用现有 `stitch-clips` |

### 4.4 音频

按 UI 的 gameplay / streamer 音量滑杆做混音 → `volume` + `amix`。

### 4.5 字幕

沿用**现成**的服务端能力:`buildAssFromSrt`(`server.js:1795`)+ `burnSrtIntoVideo`(`server.js:1856`)。
只需把 `utils/subtitles.ts` 的 SRT 生成逻辑**移植一份到服务端**(前端版保留不动)。

### 4.6 验收标准

P1 阶段必须做**与浏览器版的视觉比对**:同一批片段 + 同一 gameplay,分别用浏览器版和服务端版合成,逐帧比对关键帧位置/尺寸/裁切一致后,才允许进入后续阶段。

---

## 5. 上传通道:为什么必须直传 GCS

**Cloud Run HTTP/1 请求体上限 32 MiB,不可调整**(已查证)。而 UI 允许 gameplay 最大 250 MB。

| 方案 | 可行性 |
|---|---|
| 直接 POST 上传到 Cloud Run | ❌ 超过 32 MiB 即失败 |
| 前端压缩后再传 | ⚠️ 可绕过,但牺牲成片画质(合成底图变成压缩过的) |
| **签名 URL 直传 GCS** | ✅ 浏览器直接 PUT 到 GCS,完全绕过 Cloud Run |

选**签名 URL 直传**。除了绕过限制,也避免几百 MB 流量穿过应用层。项目已有 `roles/iam.serviceAccountTokenCreator`,签名能力现成。

### 副作用:必须给 bucket 配 CORS

README 已记录当前 bucket **无 CORS 配置**(这也是恢复片段要走流式代理而非签名 URL 的原因)。浏览器直传 GCS 需要 CORS 允许 `PUT` + 应用来源。

→ 这一步纳入 [deploy.sh 模式 4](#12-deploysh-兼容方案) 自动配置,并回读校验。

---

## 6. 作业状态机与无人看守推进

### 6.1 问题

Cloud Run 默认**请求之外 CPU 被 throttle**(实测当前服务 `cpu-throttling` 注解为空 = 默认节流,`minScale` 为空 = 0)。响应返回后后台循环不保证继续执行。

### 6.2 三层降级推进

任一层可用即可推进作业:

| 层 | 机制 | 生效条件 |
|---|---|---|
| L1 快路径 | 进程内 worker 循环 | `--no-cpu-throttling` + `--min-instances=1` |
| L2 兜底 | `POST /api/autopilot/jobs/:id/tick` 幂等推进一步,浏览器轮询时顺带驱动 | 页面开着 |
| L3 保底 | Cloud Scheduler cron 调 `/api/autopilot/resume` 捡起僵住作业 | deploy 模式 4 可选开启 |

### 6.3 断点续跑

每步完成即 checkpoint 到 Datastore。实例被回收后从断点继续,**不重复已完成的生成**(不重复烧钱)。

`tick` 必须**幂等**:重复调用同一状态不产生额外副作用。

---

## 7. 流水线与校验门

每步产物都验,不合格重试或标记失败:

| # | 步骤 | 校验门 | 失败处理 |
|---|---|---|---|
| 0 | 入参 | 必填项完整;比例/布局合法;gameplay 能 ffprobe 出时长与分辨率 | 立即 `400`,不建作业 |
| 1 | 脚本 | JSON schema 通过;段数 ≥ 1;每段 `duration ∈ {4,6,8}`;台词非空;总时长 ≤ gameplay 时长 | 升温重试 2 次 → 该变体失败 |
| 2 | 头像 | 图片可解码;比例符合布局要求(`stacked` 需与成片反向比例) | 重试 2 次 → 该变体失败 |
| 3 | 片段 | 每段 `videoUri` 存在;ffprobe 时长/分辨率符合预期 | **复用现有链**:Omni 1.1 → Omni Flash → `content_blocked` 重投 → (可选)Veo |
| 4 | 合成 | 输出可 probe;时长 ≈ 各段之和(±0.5s);含音轨;文件大小 > 0 | 重跑 1 次 → 该变体失败 |
| 5 | 交付 | GCS 对象存在且大小合理;签名 URL 可访问 | 标记该变体失败,**其余照常交付** |

**部分成功交付**是刻意设计:批量场景下个别变体失败很正常,不应拖垮整单。

---

## 8. 批量与变体设计

"10 个成片"理解为**同一 brief 产出 10 个不同成片**用于挑选/投放测试。变体维度可锁:

| 模式 | 脚本 | 头像 | 用途 |
|---|---|---|---|
| `vary-script`(默认) | 10 份不同(升温 / 换切入角度) | 锁定 1 个 | 测文案,主播形象统一 |
| `vary-avatar` | 锁定 1 份 | 10 个不同 | 测主播形象 |
| `vary-both` | 各自独立 | 各自独立 | 最大多样性 |

**gameplay 只上传一次,N 个变体共用** —— 省时间也省流量。

> ⚠️ **待确认**:若"10 个成片"实际是**10 个不同 gameplay 各出 1 片**,批量模型需改为多素材输入,方案会有差异。当前按"一素材多变体"设计。见[第 17 节](#17-待确认事项)。

---

## 9. 单页控制台

新增 `components/Autopilot.tsx`,一页三块。**不复用**三步向导。

| 区块 | 内容 |
|---|---|
| **输入区** | 游戏标题 / URL / CTA / 设备 / 台词节奏 / 附加说明;目标比例;布局与位置;字幕开关;变体数(1–10);变体模式;gameplay 上传(带直传进度条) |
| **进度区** | 提交后出现。一行一个变体,展示 脚本 → 头像 → 片段(3/4) → 合成 的实时状态与错误原因 |
| **成品区** | 每个变体一个内联预览播放器 + 下载按钮(签名 URL);外加"全部下载" |

**原三步向导 + Avatar + Studio 完全保留不动**,Autopilot 是并列的新入口(仅在 `AUTOPILOT_ENABLED` 时显示)。

文本输入沿用 `components/TextInput.tsx` 的 IME 安全组件。

---

## 10. API 设计

全部挂在现有 `apiRouter` 下,继承现成鉴权与 `ownerEmail` 归属隔离(查他人资源返回 `404` 而非 `403`,不泄露 id 存在性)。

| Method | Path | 说明 |
|---|---|---|
| `POST` | `/api/autopilot/upload-url` | 换取 gameplay 直传 GCS 的 v4 签名 PUT URL |
| `POST` | `/api/autopilot/jobs` | 校验入参、建作业 → `{ jobId }` |
| `GET` | `/api/autopilot/jobs/:id` | 进度 + 各变体状态 + 已完成变体的签名 URL |
| `POST` | `/api/autopilot/jobs/:id/tick` | **幂等**推进一步(浏览器轮询驱动) |
| `POST` | `/api/autopilot/jobs/:id/cancel` | 取消作业,止损 |
| `GET` | `/api/autopilot/jobs` | 我的历史作业列表 |
| `POST` | `/api/autopilot/resume` | 捡起僵住作业(Cloud Scheduler 可选调用) |

`AUTOPILOT_ENABLED` 未开启时,以上全部返回 `404`。

---

## 11. 数据模型

新增 Datastore kind **`AutopilotJob`**,沿用 `Project` 的"索引摘要 + 非索引 JSON blob"套路,规避 Datastore 1500 字节索引属性上限:

```
indexed:    ownerEmail, status, variantCount, doneCount, failedCount,
            createdAt, updatedAt
unindexed:  spec     → JSON { gameInfo, layout, ratio, subtitles,
                              variantMode, gameplayGcsUri, gameplayMeta }
unindexed:  variants → JSON [ { idx, stage, scriptSegments, avatarUri,
                                clipUris[], finalUri, error, timings } ]
```

查询仅按 `ownerEmail` 过滤 + 内存排序,**不需要复合索引**(与现有 `Project` 做法一致)。

`VideoJob`(`content_blocked` 重投用)**照旧不变**,Autopilot 的片段生成直接调 `beginVideoJob`,自动继承回退链与拦截重投。

### GCS 布局

```
gs://<bucket>/autopilot/<jobId>/gameplay.<ext>          直传的原始素材
gs://<bucket>/autopilot/<jobId>/v<n>/avatar.png         各变体头像
gs://<bucket>/autopilot/<jobId>/v<n>/clip-<i>.mp4       各变体片段
gs://<bucket>/autopilot/<jobId>/v<n>/final.mp4          各变体成片
```

按 jobId 分目录,便于整单清理与生命周期规则。

---

## 12. deploy.sh 兼容方案

兼容策略:**加法不改法**。

### 12.1 老路径零改动

- 模式 **1 / 2 / 3** 的现有行为**一个字节都不改**
- 模式 1 仅**多问一句**"是否启用 Autopilot?",默认 `n` —— 回车即与今天完全一致

### 12.2 新增模式 4

```
4) 配置 Autopilot (批量成片)
   ├─ 1) 启用
   │     ├─ 写 AUTOPILOT_ENABLED=1 / AUTOPILOT_MAX_BATCH / AUTOPILOT_CONCURRENCY
   │     ├─ --no-cpu-throttling --min-instances=1   （后台任务能推进）
   │     ├─ 给 bucket 配 CORS                        （直传必需，配后回读校验）
   │     └─ 可选：建 Cloud Scheduler 续跑 cron
   ├─ 2) 关闭
   │     ├─ 移除上述 env
   │     └─ 回落 min-instances=0（省钱），保留已有数据
   └─ 3) 查看当前 Autopilot 配置
```

### 12.3 环境变量修改纪律

只用 `--update-env-vars` / `--remove-env-vars`,**绝不用 `--env-vars-file`**。

> README 已记录:`--env-vars-file` 会先清空所有现有变量再写入,曾因此把 `ADMIN_USERS` 弄丢,导致 admin 权限被静默降级为"所有能登录的人"。

### 12.4 非交互兼容

保持现有约定:所有非交互 `gcloud` 调用带 `</dev/null`,以免吞掉管道 stdin 导致后续 `read` 遇 EOF(在 `set -e` 下会终止脚本)。模式 4 同样支持 `printf '4\n1\n...' | ./deploy.sh` 方式驱动。

---

## 13. 环境变量

新增变量**全部有默认值**,不设不影响老部署:

| 变量 | 默认 | 作用 |
|---|---|---|
| `AUTOPILOT_ENABLED` | 空(关闭) | 关闭时 `/api/autopilot/*` 返回 404,前端不显示入口 |
| `AUTOPILOT_MAX_BATCH` | `10` | 单作业变体数上限 |
| `AUTOPILOT_CONCURRENCY` | `4` | 并发片段生成数(受 Omni 50 RPM 约束) |
| `AUTOPILOT_MAX_CLIPS_PER_JOB` | `60` | 成本熔断:单作业片段总数上限 |
| `AUTOPILOT_COMPOSE_CONCURRENCY` | `2` | 并发 ffmpeg 合成数(受 2 vCPU 约束) |

---

## 14. 成本与配额

**这是最需要拍板的部分。**

10 个成片 × 约 4 段 = **约 40 次视频生成**,是真金白银。

| 事项 | 实测 / 结论 |
|---|---|
| Omni 1.1 配额 | 50 RPM(已实测确认可用)。并发 4–6 安全,不会自撞限流 |
| Omni 1.1 单片段耗时 | 约 36 秒 |
| **Veo 兜底风险** | 若 Omni 全线不可用,链路会落到 Veo(**按量付费,单价远高于 Omni**)。40 个片段全走 Veo 的账单会很难看 |

### 建议的成本护栏

1. **Autopilot 下默认禁用 Veo 兜底**(`VIDEO_MODEL_LAST_RESORT=""`)—— 宁可该变体失败,也不静默烧钱
2. `AUTOPILOT_MAX_CLIPS_PER_JOB` 熔断
3. 提交前 UI **显式显示"本次将生成 N 个片段"**并要求确认
4. 建议给 bucket 加生命周期规则(Autopilot 会显著加快存储增长)

---

## 15. 实施分期

| 阶段 | 内容 | 可验证产出 |
|---|---|---|
| **P1** | 服务端合成:ffmpeg PiP / stacked / 音混 / 字幕 + 服务端 SRT 生成 | 用现有片段合出与浏览器版**视觉一致**的成片(逐帧比对) |
| **P2** | 直传通道:签名上传 URL + bucket CORS + gameplay 落 GCS | 250 MB 原片成功进桶(验证绕过 32 MiB 限制) |
| **P3** | 作业状态机:`AutopilotJob` + `tick` + 校验门 + 断点续跑 | 单变体端到端跑通;**杀实例后能续跑** |
| **P4** | 批量与并发 + 部分成功交付 + 成本熔断 | 10 变体跑通;故障注入验证部分交付 |
| **P5** | `Autopilot.tsx` 单页控制台 | **一次输入拿到 10 个下载 URL** |
| **P6** | deploy.sh 模式 4 + README / DEPLOYMENT 更新 | 全新部署 + 老服务升级**双向验证** |

每阶段结束都执行:

```bash
node --check server.js
npx tsc --noEmit
npm run build
```

并在 `john-poc-453315` 实测,测试产物(GCS 对象、Datastore 实体)测完即清理。

---

## 16. 风险登记

| 风险 | 影响 | 应对 |
|---|---|---|
| 服务端合成与浏览器版视觉不一致 | 成片效果与用户预期不符 | P1 先做逐帧比对,不通过不进入 P2 |
| ffmpeg 合成吃满 2 vCPU,10 变体排队慢 | 总耗时拉长 | `AUTOPILOT_COMPOSE_CONCURRENCY=2` 限流;必要时为 Autopilot 单独调大 CPU |
| `min-instances=1` 常驻带来固定成本 | 空闲也计费 | 模式 4 提供一键关闭,回落 `min-instances=0` |
| 40 个片段的时长与费用超预期 | 账单意外 | 提交前明示片段数 + 熔断 + 默认关 Veo |
| 直传需要 bucket CORS,配错则上传失败 | 功能不可用 | 模式 4 自动配置并**回读校验** |
| 大素材 ffmpeg 处理占用容器磁盘 | 磁盘打满 | 处理完立即清理临时文件(沿用现有 `stitch-clips` 的 tmpDir 模式) |
| Omni 后续再次失去配额 | 片段全失败 | 已有回退链;Autopilot 下若关 Veo 则明确报错而非静默降级 |

---

## 17. 待确认事项

需要你拍板三件事,确认后即按 P1 → P6 实施:

### ① 变体语义

- **(A) 默认** —— 一个 gameplay 出 10 个不同成片(变体来自脚本/头像差异)
- (B) —— 10 个不同 gameplay 各出 1 个成片

> 影响:(B) 需要多素材上传与管理,批量模型和 UI 都要改。

### ② Veo 兜底

- **(A) 建议** —— Autopilot 下默认**关闭** Veo:省钱,失败即失败
- (B) —— 保留 Veo:成功率优先,但可能显著更贵

### ③ 常驻实例

- **(A) 建议** —— 接受 `min-instances=1` + CPU 常开,换取"关掉页面继续跑"
- (B) —— 不接受常驻:任务仅在页面开着时推进(靠 L2 轮询驱动)

---

## 附录 A:代码勘查证据

本方案基于以下实际勘查结果,便于 review 时核对。

### A.1 代码规模

```
server.js                 2224 行
App.tsx                   1019 行
deploy.sh                  928 行
components/Studio.tsx     1180 行
utils/videoUtils.ts        790 行
（总计约 9286 行）
```

### A.2 现有 API 端点(`apiRouter`)

```
/me                        /projects (GET/POST)      /projects/:id (GET/DELETE)
/log                       /admin/stats              /admin/signed-url
/gemini/generate-script    /gemini/analyze-script    /gemini/generate-avatar
/gemini/generate-video     /gemini/video-operation   /gemini/download-video
/gemini/stitch-clips       /gemini/burn-subtitles    /gemini/save-export
/media/export-url          /media/save-image         /media/object
```

### A.3 关键函数位置

| 函数 | 位置 | 与本方案的关系 |
|---|---|---|
| `beginVideoJob` | `server.js:1343` | **直接复用**(Omni 回退链 + 拦截重投) |
| `startOmniInteraction` | `server.js:1222` | 间接复用 |
| `buildAssFromSrt` | `server.js:1795` | **直接复用**(字幕) |
| `burnSrtIntoVideo` | `server.js:1856` | **直接复用**(字幕) |
| `probeVideoDimensions` | `server.js:1828` | 复用于校验门 |
| `uploadExportToBucket` | `server.js:987` | 复用于成片落桶 |
| `compositePipVideo` | `utils/videoUtils.ts:341` | **需移植到服务端**(最大新代码块) |
| `compressVideo` | `utils/videoUtils.ts:95` | Autopilot 不再依赖(改直传原片) |

### A.4 ffmpeg 能力(容器内实测)

```
ffmpeg version 7.1.5-0+deb13u1
  ✓ overlay    ✓ scale    ✓ amix    ✓ vstack
```

### A.5 现有限制

| 限制 | 值 | 出处 |
|---|---|---|
| Cloud Run HTTP/1 请求体 | **32 MiB,不可调** | GCP 官方限制(已查证) |
| `express.json` | `50mb` | `server.js:63` |
| `multer` 单文件 | `200MB` | `server.js:1750` |
| UI gameplay 上限 | 250 MB | README |
| Cloud Run `timeoutSeconds` | `3600` | 实测当前服务 |
| Cloud Run `cpu-throttling` | 空(默认节流) | 实测当前服务 |
| Cloud Run `minScale` | 空(= 0) | 实测当前服务 |

### A.6 布局类型

```ts
// types.ts:3
export type LayoutType = 'classic-pip' | 'stacked' | 'streamer-only';
```

### A.7 浏览器合成几何规则(从 `videoUtils.ts:341-435` 提取)

- 画布:`16:9` → 1920×1080;`9:16` → 1080×1920
- 背景:cover 缩放裁切,居中
- `classic-pip`:目标面积 = 画布面积 × **0.1**;`padding = width × 0.02`;四角位置,默认 `bottom-left`
- `stacked`:上下分割(依 `stackedPlacement`)

### A.8 deploy.sh 结构

| 位置 | 内容 |
|---|---|
| `42-48` | 模式菜单(1/2/3)与读取 |
| `833-851` | `ENV_FILE` 拼装(模式 1 用 `--env-vars-file`) |
| `257` | 模式 3 用 `--update-env-vars="^#^k=v"` |
| `864-875` | `gcloud run deploy` 调用 |

### A.9 Omni 配额实测(2026-09-02)

```
metric: aiplatform.googleapis.com/global_generate_content_requests_per_minute_per_project_per_base_model
  gemini-omni-1.1-flash-preview  → 50   (global)
  gemini-omni-flash-preview      → 50   (global)
```

Omni 1.1 已可用(4/4 成功,含 1080p 实测 1920×1080),生产返回 `fallback: false`。
