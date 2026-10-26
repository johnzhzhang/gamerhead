# 排障：Autopilot 上传报 `signBlob denied`

**一句话结论**：目标项目缺少「服务账号给自己签名」的权限,或 `iamcredentials.googleapis.com`
未启用。两者缺一不可,且后者 `deploy.sh` **从未配置过**,所以每个新项目都会踩到。

修复不需要重新部署,IAM 改动约 1 分钟内生效。

---

## 报错原文

```
Failed to create upload URL: Permission iam.serviceAccounts.signBlob denied on
resource (or it may not exist).
```

出现时机：在 Autopilot 里选择游戏录像、点击上传时。

---

## 为什么会走到签名这一步

Autopilot 的游戏录像是**浏览器直传 Cloud Storage** 的,不经过应用容器。这不是优化,
而是硬约束：Cloud Run 的 HTTP/1 请求体上限是 **32 MiB 且不可调**,而界面允许 250 MB
的录像。所以服务端只签发一个 v4 签名 URL,字节流从浏览器直接进桶。

而这个应用**刻意不持有任何私钥**,全程使用 ADC（Application Default Credentials）。
没有私钥,客户端库就无法在本地完成签名,只能调用 IAM Credentials API 的 `signBlob`,
让运行服务账号「为自己签名」。

被拒绝的就是这一次 `signBlob` 调用。

---

## 需要什么

### 1. 角色：`roles/iam.serviceAccountTokenCreator`

授予 **Cloud Run 的运行服务账号**,主体和资源都是它自己。

对应的最小权限是 `iam.serviceAccounts.signBlob`——如果贵司用自定义角色,只需要这一条。

绑定可以在两个范围做,任选其一：

| 范围 | 说明 |
|---|---|
| 服务账号自身（推荐） | 范围最窄,只允许它签自己 |
| 项目级 | 会让它能为项目内**所有**服务账号签名,范围偏大 |

> `deploy.sh` 用的是项目级。如果安全要求较严,建议改用服务账号级。

### 2. API：`iamcredentials.googleapis.com`

未启用时 `signBlob` 必然失败。报错里那句 **"or it may not exist"** 正是这种情况的典型表现。

---

## 最快的路径：用部署脚本自检

```bash
./deploy.sh        # → 3 (管理服务配置) → 4 (检查运行时依赖)
```

它会解析服务**实际**的运行身份,逐项列出 API 与角色的缺失,并询问是否就地修复;
选择不修复时会打印可直接交给管理员执行的命令。启用 Autopilot 时也会自动跑一遍。

下面是等价的手工步骤,适合没有脚本或需要走审批流程的场景。

## 一键修复

```bash
# ── 按实际情况修改这三个变量 ──
PROJECT_ID=你的项目ID
SERVICE_NAME=gamerheads
REGION=us-central1

# 取出 Cloud Run 实际的运行身份（为空则是默认 Compute SA）
RUNTIME_SA=$(gcloud run services describe "$SERVICE_NAME" \
  --region="$REGION" --project="$PROJECT_ID" \
  --format="value(spec.template.spec.serviceAccountName)")
if [ -z "$RUNTIME_SA" ]; then
  PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
  RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
fi
echo "运行身份: $RUNTIME_SA"

# 1) 启用 IAM Credentials API
gcloud services enable iamcredentials.googleapis.com --project="$PROJECT_ID"

# 2) 允许该服务账号为自己签名
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --member="serviceAccount:$RUNTIME_SA" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --project="$PROJECT_ID"
```

> **务必用 `describe` 取运行身份,不要假定是默认 Compute SA。**
> 如果服务跑在自定义服务账号上,授权给 Compute SA 是无效的——这是一个常见误区。

---

## 验证

```bash
# API 是否启用（有输出即正常）
gcloud services list --enabled --project="$PROJECT_ID" \
  --filter="config.name:iamcredentials.googleapis.com" \
  --format="value(config.name)"

# 服务账号级绑定
gcloud iam service-accounts get-iam-policy "$RUNTIME_SA" --project="$PROJECT_ID"

# 项目级绑定（两种范围任一生效即可）
gcloud projects get-iam-policy "$PROJECT_ID" \
  --flatten="bindings[].members" \
  --filter="bindings.members:$RUNTIME_SA AND bindings.role:roles/iam.serviceAccountTokenCreator" \
  --format="value(bindings.role)"
```

改完**不需要重新部署**：权限在每次调用时检查,等约 1 分钟让 IAM 传播即可重试。

---

## 同一原因会影响的全部功能

代码里有 6 处 `getSignedUrl`,全部依赖这一个权限。上传只是最先撞上的那个,
修好后整条链路一起恢复。

| 端点 | 功能 |
|---|---|
| `POST /api/autopilot/upload-url` | **游戏录像上传**（报错点） |
| `POST /api/autopilot/image-upload-url` | 参考图 / 自备主播图上传 |
| `POST /api/autopilot/jobs/:id/avatar/upload-url` | 确认闸门处上传自己的主播图 |
| `GET /api/media/export-url` | 成品视频的内嵌播放与下载链接 |
| `GET /api/admin/signed-url` | 管理后台的文件下载 |
| `GET /api/admin/stats` | 活动日志里的文件链接 |

---

## 为什么新项目总会踩到

三个独立的原因,都在 `deploy.sh` 里：

**1. 从未启用 `iamcredentials.googleapis.com`。**
第 819 行只启用了 6 个 API：`cloudbuild`、`run`、`artifactregistry`、`firestore`、
`aiplatform`、`storage`。已有的可用项目里它是启用状态,但那是被其他用途顺带开启的,
不是部署脚本的功劳。换到干净项目就暴露了。

**2. 角色绑定失败只打警告,不中断部署。**
第 1121 行的 `ROLES` 数组里确实包含 `roles/iam.serviceAccountTokenCreator`,但循环是这样写的：

```bash
gcloud projects add-iam-policy-binding ... > /dev/null 2>&1 \
  || echo "⚠️ 无法绑定角色 $ROLE，可能是权限不足"
```

如果执行部署的账号缺少 `resourcemanager.projects.setIamPolicy`,它只输出一行警告就继续,
部署依旧显示「成功」。错误要到运行时才浮现。

**3. 授权只在模式 1（全新部署）执行。**
模式 2（更新代码）与模式 3（管理服务配置）完全不碰 IAM 和 API——这符合「只更新代码」的设计,
但代价是：一旦当初绑定失败,后续无论升级多少次都不会自愈。

---

## 执行修复所需的操作者权限

运行上面命令的人（不是服务账号）需要：

| 权限 | 用于 |
|---|---|
| `serviceusage.services.enable` | 启用 API（含于 `roles/serviceusage.serviceUsageAdmin`） |
| `iam.serviceAccounts.setIamPolicy` | 在服务账号上加绑定（含于 `roles/iam.serviceAccountAdmin`） |
| `resourcemanager.projects.setIamPolicy` | 仅在选择项目级绑定时需要（含于 `roles/resourcemanager.projectIamAdmin`） |
| `run.services.get` | 读取运行身份（含于 `roles/run.viewer`） |

项目 Owner 覆盖以上全部。

---

## 另一种报错：`Upload was blocked before Cloud Storage could answer`

签名拿到了（说明上一节的权限没问题）,但浏览器 PUT 到存储桶时失败。

**这两种报错的区别值得记住**,它能直接砍掉一半排查范围：

| 报错 | 含义 | 方向 |
|---|---|---|
| `Permission ... signBlob denied` | 签名 URL **没能生成** | IAM 权限 / API |
| `Upload was blocked before ... could answer` | URL 生成了,但**存储桶没有回应** | CORS / 网络 |
| `Cloud Storage refused the upload (HTTP 403/400)` | 存储桶**回应了并拒绝** | 签名过期 / Content-Type 不符 |

第二种之所以能断定「不是签名被拒」,是因为前端用的是 `XMLHttpRequest`：任何带状态码的
响应都会走 `onload`,只有完全拿不到响应才走 `onerror`。

### 最可能的原因：Origin 不在 CORS 规则里

`deploy.sh` 只会写两种 `run.app` 地址,并自动探测域名映射。如果用户是通过
**自定义域名或外部负载均衡**（组织级 IAP 的常见做法）访问的,浏览器发出的 `Origin`
两者都不匹配,预检就被拒。

`Origin` 必须与浏览器地址栏**完全一致**,只比对 `scheme://host[:port]`——
带路径、带末尾斜杠、http 与 https 混用都不算匹配。

### 不需要任何 GCP 权限就能确诊

让使用者在浏览器里做,比申请项目权限快得多：

1. F12 打开开发者工具 → Network
2. 重试上传,找到发往 `storage.googleapis.com` 的失败请求
3. 看两件事：
   - **有没有 `OPTIONS` 预检请求?** 没有 → 请求在更早的网络层就被拦了（代理 / 防火墙 / VPC-SC）
   - **预检的响应头里有 `Access-Control-Allow-Origin` 吗?** 没有,或值与地址栏域名不符 → 就是 CORS 规则缺这个 Origin
4. 同时记下地址栏的完整域名——这就是需要加进规则的那个 Origin

### 修复

```bash
./deploy.sh        # → 3 → 4   先看实际允许了哪些 Origin
./deploy.sh        # → 3 → 3   重写规则，会提示补充自定义域名
```

手工方式（需要 `storage.buckets.update`,**运行服务账号的 `objectAdmin` 不含这个权限**,
所以应用无法自我修复）：

```bash
cat > cors.json <<'EOF'
[
  {
    "origin": ["https://你的服务.run.app", "https://app.example.com"],
    "method": ["PUT", "GET", "HEAD", "OPTIONS"],
    "responseHeader": ["Content-Type", "Content-Length", "Content-Disposition", "x-goog-resumable"],
    "maxAgeSeconds": 3600
  }
]
EOF
gcloud storage buckets update gs://你的桶 --cors-file=cors.json

# 回读确认
gcloud storage buckets describe gs://你的桶 --format="value(cors_config)"
```

> `responseHeader` 里必须保留 `Content-Type`：它决定预检响应中的
> `Access-Control-Allow-Headers`。而上传请求必然带 `Content-Type: video/mp4`,
> 这个值不属于 CORS 的「简单」头,所以一定会触发预检。

### 其余可能

- **网络路径被拦**：代理、防火墙或 VPC Service Controls 边界阻断了
  `storage.googleapis.com`。特征是连 `OPTIONS` 都看不到。
- **连接中断**：大文件在弱网下断流,同样走 `onerror`。重试一次即可区分。
- **CORS 当初写入失败过**：执行部署的账号缺 `storage.buckets.update` 时,
  `deploy.sh` 会打印 ❌,但在长日志里很容易被忽略。用 3 → 4 复查最快。

---

## 排查清单

逐条确认,通常第 1 或第 2 条就是原因：

- [ ] `iamcredentials.googleapis.com` 已启用
- [ ] `roles/iam.serviceAccountTokenCreator` 已授予运行服务账号（服务账号级或项目级）
- [ ] 绑定的主体是 **Cloud Run 实际的运行身份**,不是想当然的默认 Compute SA
- [ ] 绑定没有附加 IAM Condition（脚本用 `--condition=None`,手工加的可能带条件）
- [ ] 距离改动已超过 1 分钟（IAM 传播延迟）
- [ ] 若仍失败,查容器日志定位具体端点：
      `gcloud run services logs read $SERVICE_NAME --region=$REGION --limit=50`
