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

## 排查清单

逐条确认,通常第 1 或第 2 条就是原因：

- [ ] `iamcredentials.googleapis.com` 已启用
- [ ] `roles/iam.serviceAccountTokenCreator` 已授予运行服务账号（服务账号级或项目级）
- [ ] 绑定的主体是 **Cloud Run 实际的运行身份**,不是想当然的默认 Compute SA
- [ ] 绑定没有附加 IAM Condition（脚本用 `--condition=None`,手工加的可能带条件）
- [ ] 距离改动已超过 1 分钟（IAM 传播延迟）
- [ ] 若仍失败,查容器日志定位具体端点：
      `gcloud run services logs read $SERVICE_NAME --region=$REGION --limit=50`
