#!/bin/bash

# GamerHeads Cloud Run 部署脚本 / Deployment Script
# 适用于多用户/开源部署环境 / For multi-user / open-source deployment
# 使用方法 / Usage: ./deploy.sh

set -e

# ── Language Selection / 语言选择 ─────────────────────────────
echo "Please select language / 请选择语言:"
echo "  1) 中文"
echo "  2) English"
read -p "Enter / 输入 [1/2, default/默认: 1]: " LANG_SEL
LANG_SEL=${LANG_SEL:-1}
if [ "$LANG_SEL" == "2" ]; then
    LANG_CHOICE="en"
else
    LANG_CHOICE="zh"
fi
echo ""

# Translation helper: _t "Chinese text" "English text"
_t() {
    if [ "$LANG_CHOICE" == "en" ]; then
        printf '%s' "$2"
    else
        printf '%s' "$1"
    fi
}

echo "🚀 GamerHeads Cloud Run $(_t "部署工具" "Deployment Tool")"
echo "=================================="
echo ""

# 检查是否已登录gcloud / Check gcloud login
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" &>/dev/null; then
    echo "$(_t "❌ 未检测到活动的 gcloud 账号，请先运行:" "❌ No active gcloud account detected. Please run:")"
    echo "   gcloud auth login"
    exit 1
fi

# ── 选择操作模式 / Select operation mode ──────────────────────
echo "$(_t "请选择操作:" "Select an operation:")"
echo "  1) $(_t "全新部署" "Fresh deployment")"
echo "  2) $(_t "更新已有服务 (仅更新代码，保留现有配置)" "Update existing service (code only, keep existing config)")"
echo "  3) $(_t "管理授权用户 (添加/删除可登录的邮箱)" "Manage authorized users (add/remove login emails)")"
echo "  4) $(_t "配置 Autopilot (批量成片)" "Configure Autopilot (batch production)")"
read -p "$(_t "输入选项 [1/2/3/4, 默认: 1]: " "Enter option [1/2/3/4, default: 1]: ")" DEPLOY_MODE
DEPLOY_MODE=${DEPLOY_MODE:-1}
echo ""

# 获取当前项目ID / Get current project ID
CURRENT_PROJECT=$(gcloud config get-value project 2>/dev/null)

if [ -z "$CURRENT_PROJECT" ]; then
    echo "$(_t "⚠️  未设置默认 GCP 项目" "⚠️  No default GCP project set")"
    read -p "$(_t "请输入您的 GCP 项目ID: " "Please enter your GCP project ID: ")" PROJECT_ID
    gcloud config set project $PROJECT_ID
else
    echo "$(_t "📋 当前检测到的 GCP 项目: $CURRENT_PROJECT" "📋 Current GCP project detected: $CURRENT_PROJECT")"
    read -p "$(_t "是否部署到此项目? (y/n) [默认: y]: " "Deploy to this project? (y/n) [default: y]: ")" USE_CURRENT
    USE_CURRENT=${USE_CURRENT:-y}
    if [ "$USE_CURRENT" != "y" ]; then
        read -p "$(_t "请输入您想部署的 GCP 项目ID: " "Please enter the GCP project ID to deploy to: ")" PROJECT_ID
        gcloud config set project $PROJECT_ID
    else
        PROJECT_ID=$CURRENT_PROJECT
    fi
fi

# ══════════════════════════════════════════════════════════════
# 更新模式 / Update mode
# ══════════════════════════════════════════════════════════════
if [ "$DEPLOY_MODE" == "2" ]; then
    echo ""
    echo "$(_t "🔍 正在查询项目 [$PROJECT_ID] 中的 Cloud Run 服务..." "🔍 Fetching Cloud Run services in project [$PROJECT_ID]...")"
    SERVICES_RAW=$(gcloud run services list \
        --project=$PROJECT_ID \
        --platform=managed \
        --format="csv[no-heading](metadata.name,metadata.labels['cloud.googleapis.com/location'])" \
        2>/dev/null || echo "")

    if [ -z "$SERVICES_RAW" ]; then
        echo "$(_t "❌ 未找到任何 Cloud Run 服务，请先执行全新部署。" "❌ No Cloud Run services found. Please perform a fresh deployment first.")"
        exit 1
    fi

    echo ""
    echo "$(_t "已有服务列表:" "Existing services:")"
    echo "$SERVICES_RAW" | while IFS=',' read -r svc_name svc_region; do
        echo "   • $svc_name  ($svc_region)"
    done

    FIRST_SVC=$(echo "$SERVICES_RAW" | head -1 | cut -d',' -f1)
    FIRST_REGION=$(echo "$SERVICES_RAW" | head -1 | cut -d',' -f2)
    echo ""
    read -p "$(_t "输入要更新的服务名称 [默认: ${FIRST_SVC}]: " "Enter the service name to update [default: ${FIRST_SVC}]: ")" SERVICE_NAME
    SERVICE_NAME=${SERVICE_NAME:-$FIRST_SVC}
    read -p "$(_t "输入服务所在区域 [默认: ${FIRST_REGION}]: " "Enter the service region [default: ${FIRST_REGION}]: ")" REGION
    REGION=${REGION:-$FIRST_REGION}

    # 验证服务是否存在 / Verify service exists
    if ! gcloud run services describe "$SERVICE_NAME" \
            --region="$REGION" --project="$PROJECT_ID" &>/dev/null; then
        echo "$(_t "❌ 服务 [$SERVICE_NAME] 在区域 [$REGION] 不存在，请检查名称和区域。" "❌ Service [$SERVICE_NAME] not found in region [$REGION]. Please check the name and region.")"
        exit 1
    fi

    # 读取并展示现有配置 / Show existing config
    echo ""
    echo "$(_t "📋 现有服务配置 (将完整保留):" "📋 Existing service config (will be fully preserved):")"
    gcloud run services describe "$SERVICE_NAME" \
        --region="$REGION" --project="$PROJECT_ID" \
        --format="table[no-heading,box](
            spec.template.spec.containers[0].env[].name,
            spec.template.spec.containers[0].env[].value
        )" 2>/dev/null | sed 's/^/   /' || true

    echo ""
    echo "$(_t "📋 更新确认:" "📋 Update confirmation:")"
    echo "   $(_t "项目ID : $PROJECT_ID" "Project ID : $PROJECT_ID")"
    echo "   $(_t "服务名 : $SERVICE_NAME" "Service    : $SERVICE_NAME")"
    echo "   $(_t "区域   : $REGION" "Region     : $REGION")"
    UPD_IAP=$(gcloud run services describe "$SERVICE_NAME" \
        --region="$REGION" --project="$PROJECT_ID" \
        --format="value(metadata.annotations['run.googleapis.com/iap-enabled'])" 2>/dev/null)
    if [ "$UPD_IAP" == "true" ] || [ "$UPD_IAP" == "True" ]; then
        echo "   $(_t "IAP    : 已启用 (更新代码不会改动它)" "IAP        : enabled (a code update leaves it untouched)")"
    fi
    echo "   $(_t "操作   : 仅更新代码，所有环境变量/配置保持不变" "Action     : Code update only, all env vars/config unchanged")"
    echo ""
    read -p "$(_t "确认开始更新? (y/n) [默认: y]: " "Confirm update? (y/n) [default: y]: ")" CONFIRM
    CONFIRM=${CONFIRM:-y}
    if [ "$CONFIRM" != "y" ]; then
        echo "$(_t "❌ 已取消" "❌ Cancelled")"
        exit 0
    fi

    echo ""
    echo "$(_t "🏗️  开始更新 Cloud Run 服务..." "🏗️  Starting Cloud Run service update...")"
    echo "$(_t "📦 正在将本地源码打包并通过 Cloud Build 构建 (大约需要 3-5 分钟)..." "📦 Packaging local source and building via Cloud Build (approx. 3-5 minutes)...")"

    gcloud run deploy "$SERVICE_NAME" \
        --source . \
        --region="$REGION" \
        --platform=managed \
        --project="$PROJECT_ID"

    echo ""
    echo "$(_t "✅ 更新成功!" "✅ Update successful!")"
    echo ""
    PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
    SERVICE_URL="https://${SERVICE_NAME}-${PROJECT_NUMBER}.${REGION}.run.app"
    echo "$(_t "🌐 服务访问地址: $SERVICE_URL" "🌐 Service URL: $SERVICE_URL")"
    echo ""
    echo "$(_t "🎉 代码已更新，原有配置（Bucket、验证方式等）均保持不变。" "🎉 Code updated. Existing config (Bucket, auth settings, etc.) remains unchanged.")"
    exit 0
fi

# ══════════════════════════════════════════════════════════════
# Autopilot 配置模式 / Configure Autopilot mode
# ══════════════════════════════════════════════════════════════
# 只用 --update-env-vars / --remove-env-vars，绝不用 --env-vars-file：
# 后者会先清空所有现有变量，历史上曾因此丢掉 ADMIN_USERS。
# Only ever uses --update-env-vars / --remove-env-vars. --env-vars-file wipes
# every existing variable first, which is how ADMIN_USERS was once silently lost.
if [ "$DEPLOY_MODE" == "4" ]; then
    echo ""
    echo "$(_t "🔍 正在查询项目 [$PROJECT_ID] 中的 Cloud Run 服务..." "🔍 Fetching Cloud Run services in project [$PROJECT_ID]...")"
    SERVICES_RAW=$(gcloud run services list \
        --project=$PROJECT_ID --platform=managed \
        --format="csv[no-heading](metadata.name,metadata.labels['cloud.googleapis.com/location'])" \
        2>/dev/null || echo "")

    if [ -z "$SERVICES_RAW" ]; then
        echo "$(_t "❌ 未找到任何 Cloud Run 服务" "❌ No Cloud Run services found")"
        exit 1
    fi
    echo ""
    echo "$(_t "已有服务列表:" "Existing services:")"
    echo "$SERVICES_RAW" | while IFS=',' read -r svc_name svc_region; do
        echo "   • $svc_name  ($svc_region)"
    done

    FIRST_SVC=$(echo "$SERVICES_RAW" | head -1 | cut -d',' -f1)
    FIRST_REGION=$(echo "$SERVICES_RAW" | head -1 | cut -d',' -f2)
    echo ""
    read -p "$(_t "输入服务名称 [默认: ${FIRST_SVC}]: " "Enter service name [default: ${FIRST_SVC}]: ")" SERVICE_NAME
    SERVICE_NAME=${SERVICE_NAME:-$FIRST_SVC}
    read -p "$(_t "输入服务区域 [默认: ${FIRST_REGION}]: " "Enter service region [default: ${FIRST_REGION}]: ")" REGION
    REGION=${REGION:-$FIRST_REGION}

    if ! gcloud run services describe "$SERVICE_NAME" \
            --region="$REGION" --project="$PROJECT_ID" &>/dev/null </dev/null; then
        echo "$(_t "❌ 服务 [$SERVICE_NAME] 在区域 [$REGION] 不存在。" "❌ Service [$SERVICE_NAME] not found in region [$REGION].")"
        exit 1
    fi

    # 读取当前状态 / Read the current state
    AP_ENABLED_NOW=$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --project="$PROJECT_ID" \
        --format="value(spec.template.spec.containers[0].env.filter(\"name:AUTOPILOT_ENABLED\").extract(\"value\"))" 2>/dev/null </dev/null | tr -d '[]"'"'"' ')
    AP_BUCKET=$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --project="$PROJECT_ID" \
        --format="value(spec.template.spec.containers[0].env.filter(\"name:GCS_BUCKET_NAME\").extract(\"value\"))" 2>/dev/null </dev/null | tr -d '[]"'"'"' ')
    AP_CPU_THROTTLE=$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --project="$PROJECT_ID" \
        --format="value(spec.template.metadata.annotations['run.googleapis.com/cpu-throttling'])" 2>/dev/null </dev/null)
    AP_MIN_SCALE=$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --project="$PROJECT_ID" \
        --format="value(spec.template.metadata.annotations['autoscaling.knative.dev/minScale'])" 2>/dev/null </dev/null)

    echo ""
    echo "$(_t "📋 当前 Autopilot 配置:" "📋 Current Autopilot configuration:")"
    if [ -n "$AP_ENABLED_NOW" ]; then
        echo "   $(_t "状态" "State")        : $(_t "已启用" "enabled") (AUTOPILOT_ENABLED=$AP_ENABLED_NOW)"
    else
        echo "   $(_t "状态" "State")        : $(_t "未启用" "not enabled")"
    fi
    echo "   $(_t "存储桶" "Bucket")      : ${AP_BUCKET:-$(_t "未设置" "not set")}"
    echo "   CPU              : $([ "$AP_CPU_THROTTLE" == "false" ] && echo "$(_t "常开 (请求外也运行)" "always allocated")" || echo "$(_t "仅请求期间 (默认)" "throttled outside requests (default)")")"
    echo "   min-instances    : ${AP_MIN_SCALE:-0}"

    echo ""
    echo "$(_t "请选择操作:" "Select an operation:")"
    echo "  1) $(_t "启用 Autopilot" "Enable Autopilot")"
    echo "  2) $(_t "关闭 Autopilot" "Disable Autopilot")"
    echo "  3) $(_t "仅查看配置 (已显示在上方)" "View configuration only (shown above)")"
    read -p "$(_t "输入选项 [1/2/3, 默认: 1]: " "Enter option [1/2/3, default: 1]: ")" AP_OP
    AP_OP=${AP_OP:-1}

    if [ "$AP_OP" == "3" ]; then
        echo ""
        echo "$(_t "✅ 完成 (未做修改)。" "✅ Done (nothing changed).")"
        exit 0
    fi

    # ── 关闭 / Disable ────────────────────────────────────────
    if [ "$AP_OP" == "2" ]; then
        echo ""
        echo "$(_t "🔻 关闭 Autopilot..." "🔻 Disabling Autopilot...")"
        gcloud run services update "$SERVICE_NAME" --region="$REGION" --project="$PROJECT_ID" \
            --remove-env-vars=AUTOPILOT_ENABLED,AUTOPILOT_MAX_BATCH,AUTOPILOT_CONCURRENCY,AUTOPILOT_COMPOSE_CONCURRENCY,AUTOPILOT_MAX_CLIPS_PER_JOB,AUTOPILOT_VEO_CLIP_BUDGET \
            --quiet </dev/null 2>&1 | tail -2
        # 回落到按需实例，空闲不再计费 / Scale back to zero so idle costs nothing
        gcloud run services update "$SERVICE_NAME" --region="$REGION" --project="$PROJECT_ID" \
            --min-instances=0 --cpu-throttling --quiet </dev/null 2>&1 | tail -2
        echo ""
        echo "$(_t "✅ Autopilot 已关闭，min-instances 回落为 0。" "✅ Autopilot disabled; min-instances back to 0.")"
        echo "$(_t "   已产出的作业与视频保留在 Datastore 和存储桶中。" "   Existing jobs and videos are left untouched in Datastore and the bucket.")"
        exit 0
    fi

    # ── 启用 / Enable ─────────────────────────────────────────
    if [ -z "$AP_BUCKET" ]; then
        echo ""
        echo "$(_t "❌ 该服务没有配置 GCS_BUCKET_NAME。" "❌ This service has no GCS_BUCKET_NAME configured.")"
        echo "$(_t "   Autopilot 需要存储桶来存放素材与成片。" "   Autopilot needs a bucket for footage and finished videos.")"
        exit 1
    fi

    echo ""
    read -p "$(_t "单次批量最多几个成片 [默认: 10]: " "Maximum videos per batch [default: 10]: ")" AP_MAX_BATCH
    AP_MAX_BATCH=${AP_MAX_BATCH:-10}
    read -p "$(_t "并发片段生成数 (受模型配额约束) [默认: 4]: " "Concurrent clip generations (bounded by model quota) [default: 4]: ")" AP_CONC
    AP_CONC=${AP_CONC:-4}
    read -p "$(_t "单个作业片段总数上限 (成本熔断) [默认: 60]: " "Clip ceiling per job (cost breaker) [default: 60]: ")" AP_MAX_CLIPS
    AP_MAX_CLIPS=${AP_MAX_CLIPS:-60}

    echo ""
    echo "$(_t "🖥️  后台推进方式" "🖥️  How batches keep running")"
    echo "$(_t "   Cloud Run 默认在请求之外会限制 CPU，作业只能在页面打开时推进。" "   Cloud Run throttles CPU outside requests by default, so a batch only advances while a tab is open.")"
    echo "$(_t "   常驻一个实例可以让用户关掉页面后继续跑，代价是空闲也计费。" "   Keeping one instance warm lets it continue after the tab closes, at the cost of paying while idle.")"
    read -p "$(_t "启用常驻实例 (min-instances=1, CPU 常开)? (y/n) [默认: y]: " "Keep one instance warm (min-instances=1, CPU always on)? (y/n) [default: y]: ")" AP_WARM
    AP_WARM=${AP_WARM:-y}

    echo ""
    echo "$(_t "📋 即将应用:" "📋 About to apply:")"
    echo "   $(_t "服务" "Service")           : $SERVICE_NAME ($REGION)"
    echo "   AUTOPILOT_MAX_BATCH           : $AP_MAX_BATCH"
    echo "   AUTOPILOT_CONCURRENCY         : $AP_CONC"
    echo "   AUTOPILOT_MAX_CLIPS_PER_JOB   : $AP_MAX_CLIPS"
    echo "   $(_t "常驻实例" "Warm instance")       : $AP_WARM"
    echo "   $(_t "存储桶 CORS" "Bucket CORS")     : gs://$AP_BUCKET"
    read -p "$(_t "确认? (y/n) [默认: y]: " "Confirm? (y/n) [default: y]: ")" AP_CONFIRM
    AP_CONFIRM=${AP_CONFIRM:-y}
    if [ "$AP_CONFIRM" != "y" ] && [ "$AP_CONFIRM" != "Y" ]; then
        echo "$(_t "已取消。" "Cancelled.")"
        exit 0
    fi

    # 1) 环境变量 / Environment variables
    echo ""
    echo "$(_t "⚙️  写入环境变量..." "⚙️  Writing environment variables...")"
    gcloud run services update "$SERVICE_NAME" --region="$REGION" --project="$PROJECT_ID" \
        --update-env-vars="AUTOPILOT_ENABLED=1,AUTOPILOT_MAX_BATCH=${AP_MAX_BATCH},AUTOPILOT_CONCURRENCY=${AP_CONC},AUTOPILOT_MAX_CLIPS_PER_JOB=${AP_MAX_CLIPS}" \
        --quiet </dev/null 2>&1 | tail -2

    # 2) 常驻实例 / Warm instance
    if [ "$AP_WARM" == "y" ] || [ "$AP_WARM" == "Y" ]; then
        echo "$(_t "⚙️  配置常驻实例 (min-instances=1, CPU 常开)..." "⚙️  Configuring a warm instance (min-instances=1, CPU always on)...")"
        gcloud run services update "$SERVICE_NAME" --region="$REGION" --project="$PROJECT_ID" \
            --min-instances=1 --no-cpu-throttling --quiet </dev/null 2>&1 | tail -2
    fi

    # 3) 存储桶 CORS —— 浏览器直传的必要条件
    #    Bucket CORS: required for the browser to PUT gameplay straight to GCS,
    #    which is unavoidable because Cloud Run caps a request body at 32 MiB.
    echo "$(_t "⚙️  配置存储桶 CORS (浏览器直传素材所必需)..." "⚙️  Configuring bucket CORS (required for direct uploads)...")"
    SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --project="$PROJECT_ID" \
        --format="value(status.url)" 2>/dev/null </dev/null)
    # Cloud Run answers on two host forms and a user may arrive on either, so both
    # have to be allowed — a missing origin makes the upload fail with an opaque
    # CORS error and no server-side trace.
    AP_PNUM=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)" 2>/dev/null </dev/null)
    SERVICE_URL_ALT="https://${SERVICE_NAME}-${AP_PNUM}.${REGION}.run.app"
    CORS_FILE=$(mktemp)
    cat > "$CORS_FILE" <<CORSEOF
[
  {
    "origin": ["${SERVICE_URL}", "${SERVICE_URL_ALT}"],
    "method": ["PUT", "GET", "HEAD", "OPTIONS"],
    "responseHeader": ["Content-Type", "Content-Length", "Content-Disposition", "x-goog-resumable"],
    "maxAgeSeconds": 3600
  }
]
CORSEOF
    if gcloud storage buckets update "gs://${AP_BUCKET}" --cors-file="$CORS_FILE" --quiet </dev/null >/dev/null 2>&1; then
        # 回读校验：配错了上传会静默失败，必须确认真的写进去了
        # Read back: a wrong CORS rule fails uploads silently, so verify it landed.
        CORS_CHECK=$(gcloud storage buckets describe "gs://${AP_BUCKET}" --format=json 2>/dev/null </dev/null \
            | grep -c "$SERVICE_URL" || echo 0)
        if [ "$CORS_CHECK" -gt 0 ]; then
            echo "   ✅ $(_t "CORS 已配置并回读确认" "CORS applied and verified") ($SERVICE_URL)"
        else
            echo "   ⚠️  $(_t "CORS 已提交但回读未匹配，请手动确认" "CORS submitted but the read-back did not match; please verify manually")"
        fi
    else
        echo "   ❌ $(_t "CORS 配置失败。素材直传会失败，请手动配置:" "CORS configuration failed. Direct uploads will fail; configure it manually:")"
        echo "      gcloud storage buckets update gs://${AP_BUCKET} --cors-file=cors.json"
    fi
    rm -f "$CORS_FILE"

    # 4) 可选：Cloud Scheduler 续跑 / Optional resume cron
    echo ""
    echo "$(_t "⏰ 可选：定时唤醒停滞作业" "⏰ Optional: a cron that picks up stalled batches")"
    echo "$(_t "   即使实例被回收，也能让未完成的批次继续。等待确认头像的作业不会被唤醒。" "   Lets an unfinished batch continue even if the instance was recycled. Jobs waiting for avatar confirmation are never woken.")"
    read -p "$(_t "创建 Cloud Scheduler 任务? (y/n) [默认: n]: " "Create a Cloud Scheduler job? (y/n) [default: n]: ")" AP_CRON
    AP_CRON=${AP_CRON:-n}
    if [ "$AP_CRON" == "y" ] || [ "$AP_CRON" == "Y" ]; then
        gcloud services enable cloudscheduler.googleapis.com --project="$PROJECT_ID" --quiet </dev/null 2>&1 | tail -1
        PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)" 2>/dev/null </dev/null)
        SCHED_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
        SCHED_NAME="${SERVICE_NAME}-autopilot-resume"
        gcloud scheduler jobs delete "$SCHED_NAME" --location="$REGION" --project="$PROJECT_ID" --quiet </dev/null >/dev/null 2>&1
        if gcloud scheduler jobs create http "$SCHED_NAME" \
                --location="$REGION" --project="$PROJECT_ID" \
                --schedule="*/5 * * * *" \
                --uri="${SERVICE_URL}/api/autopilot/resume" \
                --http-method=POST \
                --oidc-service-account-email="$SCHED_SA" \
                --oidc-token-audience="$SERVICE_URL" \
                --quiet </dev/null 2>&1 | tail -2; then
            echo "   ✅ $(_t "已创建定时任务" "Scheduler job created"): $SCHED_NAME ($(_t "每 5 分钟" "every 5 minutes"))"
        else
            echo "   ⚠️  $(_t "定时任务创建失败，可稍后手动创建。批次在页面打开时仍会推进。" "Scheduler job creation failed; you can add it later. Batches still advance while a tab is open.")"
        fi
    fi

    echo ""
    echo "$(_t "✅ Autopilot 已启用!" "✅ Autopilot enabled!")"
    echo ""
    echo "$(_t "⚠️  本模式只改配置，不部署代码。" "⚠️  This mode only changes configuration; it does not deploy code.")"
    echo "$(_t "   若打开服务后看不到 Autopilot 标签，说明当前运行的镜像还没有这个功能，" "   If the Autopilot tab does not appear, the running image predates the feature;")"
    echo "$(_t "   请先执行 ./deploy.sh → 模式 2 更新代码。" "   run ./deploy.sh → mode 2 to update the code first.")"
    echo ""
    echo "$(_t "🌐 打开服务后会多出一个 Autopilot 标签:" "🌐 Open the service and you will see an extra Autopilot tab:")"
    echo "   $SERVICE_URL"
    echo ""
    echo "$(_t "💡 成本提醒: 一批 ${AP_MAX_BATCH} 个成片约需 ${AP_MAX_BATCH}×4 次视频生成。" "💡 Cost note: a batch of ${AP_MAX_BATCH} videos is roughly ${AP_MAX_BATCH}×4 video generations.")"
    echo "$(_t "   界面会在确认主播那一步显示本次将生成多少片段，确认后才开始花费。" "   The console states the clip count at the streamer-confirmation step; nothing is spent until you confirm.")"
    exit 0
fi

# ══════════════════════════════════════════════════════════════
# 管理授权用户模式 / Manage authorized users mode
# ══════════════════════════════════════════════════════════════
if [ "$DEPLOY_MODE" == "3" ]; then
    echo ""
    echo "$(_t "🔍 正在查询项目 [$PROJECT_ID] 中的 Cloud Run 服务..." "🔍 Fetching Cloud Run services in project [$PROJECT_ID]...")"
    SERVICES_RAW=$(gcloud run services list \
        --project=$PROJECT_ID \
        --platform=managed \
        --format="csv[no-heading](metadata.name,metadata.labels['cloud.googleapis.com/location'])" \
        2>/dev/null || echo "")

    if [ -z "$SERVICES_RAW" ]; then
        echo "$(_t "❌ 未找到任何 Cloud Run 服务" "❌ No Cloud Run services found")"
        exit 1
    fi

    echo ""
    echo "$(_t "已有服务列表:" "Existing services:")"
    echo "$SERVICES_RAW" | while IFS=',' read -r svc_name svc_region; do
        echo "   • $svc_name  ($svc_region)"
    done

    FIRST_SVC=$(echo "$SERVICES_RAW" | head -1 | cut -d',' -f1)
    FIRST_REGION=$(echo "$SERVICES_RAW" | head -1 | cut -d',' -f2)
    echo ""
    read -p "$(_t "输入服务名称 [默认: ${FIRST_SVC}]: " "Enter service name [default: ${FIRST_SVC}]: ")" SERVICE_NAME
    SERVICE_NAME=${SERVICE_NAME:-$FIRST_SVC}
    read -p "$(_t "输入服务区域 [默认: ${FIRST_REGION}]: " "Enter service region [default: ${FIRST_REGION}]: ")" REGION
    REGION=${REGION:-$FIRST_REGION}

    # 验证服务是否存在 / Verify service exists
    if ! gcloud run services describe "$SERVICE_NAME" \
            --region="$REGION" --project="$PROJECT_ID" &>/dev/null; then
        echo "$(_t "❌ 服务 [$SERVICE_NAME] 在区域 [$REGION] 不存在，请检查名称和区域。" "❌ Service [$SERVICE_NAME] not found in region [$REGION]. Please check the name and region.")"
        exit 1
    fi

    # 读取当前所有环境变量 / Read current env vars
    echo ""
    echo "$(_t "🔍 正在读取当前配置..." "🔍 Reading current configuration...")"
    ENV_JSON=$(gcloud run services describe "$SERVICE_NAME" \
        --region="$REGION" --project="$PROJECT_ID" \
        --format="json(spec.template.spec.containers[0].env)" 2>/dev/null) || true

    # 解析各环境变量 / Parse env vars
    get_env() {
        echo "$ENV_JSON" | grep -A1 "\"name\": \"$1\"" | grep '"value"' | sed 's/.*"value": "\(.*\)".*/\1/' || true
    }

    CUR_CLIENT_ID=$(get_env "GOOGLE_CLIENT_ID")
    CUR_AUTHORIZED=$(get_env "AUTHORIZED_USERS")
    CUR_BASIC_AUTH=$(get_env "BASIC_AUTH_USERS")
    CUR_ADMIN_USERS=$(get_env "ADMIN_USERS")

    # 检测是否为 Cloud Run 原生 IAP 部署 / Detect Cloud Run native IAP
    IAP_ENABLED=$(gcloud run services describe "$SERVICE_NAME" \
        --region="$REGION" --project="$PROJECT_ID" \
        --format="value(metadata.annotations['run.googleapis.com/iap-enabled'])" 2>/dev/null)

    if [ -n "$CUR_CLIENT_ID" ]; then
        AUTH_KIND="gis"
    elif [ "$IAP_ENABLED" == "true" ] || [ "$IAP_ENABLED" == "True" ]; then
        AUTH_KIND="iap"
    elif [ -n "$CUR_BASIC_AUTH" ]; then
        AUTH_KIND="basic"
    else
        AUTH_KIND="open"
    fi

    IAP_ROLE="roles/iap.httpsResourceAccessor"

    # 列出 IAP 授权成员 / List IAP-authorized members
    list_iap_members() {
        gcloud beta iap web get-iam-policy \
            --resource-type=cloud-run --service="$SERVICE_NAME" --region="$REGION" \
            --project="$PROJECT_ID" \
            --flatten="bindings[].members" \
            --filter="bindings.role:${IAP_ROLE}" \
            --format="value(bindings.members)" 2>/dev/null || true
    }

    # 只更新单个环境变量，其余保持不变。
    # 绝不使用 --env-vars-file：它会先清空所有环境变量再写入，任何未列在
    # 脚本里的变量（例如 ADMIN_USERS）都会被静默丢弃。
    # Update ONE env var and leave the rest untouched. Never use --env-vars-file:
    # it removes every existing variable before writing, silently dropping
    # anything this script does not happen to know about (e.g. ADMIN_USERS).
    # 前缀 ^#^ 让 gcloud 用 '#' 而不是 ',' 分隔条目，值里的逗号才安全。
    update_one_env() {
        local key="$1" val="$2"
        if [ -z "$val" ]; then
            gcloud run services update "$SERVICE_NAME" \
                --region="$REGION" --project="$PROJECT_ID" \
                --remove-env-vars="$key" 2>&1 | tail -3
        else
            gcloud run services update "$SERVICE_NAME" \
                --region="$REGION" --project="$PROJECT_ID" \
                --update-env-vars="^#^${key}=${val}" 2>&1 | tail -3
        fi
    }

    # 交互式增删逗号分隔的列表，结果放在全局 EDITED_LIST
    # Interactively edit a comma-separated list → EDITED_LIST
    edit_email_list() {
        local current="$1" label="$2"
        EDITED_LIST="$current"

        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "$(_t "📋 当前${label}:" "📋 Current ${label}:")"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        if [ -z "$current" ]; then
            echo "   $(_t "（未设置）" "(not set)")"
        else
            echo "$current" | tr ',' '\n' | while read -r item; do
                [ -n "$item" ] && echo "   • $item"
            done
        fi

        echo ""
        echo "$(_t "请选择操作:" "Select an operation:")"
        echo "  1) $(_t "添加" "Add")"
        echo "  2) $(_t "删除" "Remove")"
        echo "  3) $(_t "查看后退出" "View and exit")"
        read -p "$(_t "输入选项 [1/2/3]: " "Enter option [1/2/3]: ")" LIST_OP

        if [ "$LIST_OP" == "1" ]; then
            echo ""
            echo "$(_t "输入要添加的条目 (每行一个，直接回车结束):" "Enter entries to add (one per line, press Enter when done):")"
            while true; do
                read -p "$(_t "  条目: " "  Entry: ")" NEW_EMAIL
                [ -z "$NEW_EMAIL" ] && break
                if echo "$EDITED_LIST" | tr ',' '\n' | grep -qx "$NEW_EMAIL"; then
                    echo "  ⚠️  $NEW_EMAIL $(_t "已在列表中" "is already in the list")"
                else
                    if [ -z "$EDITED_LIST" ]; then
                        EDITED_LIST="$NEW_EMAIL"
                    else
                        EDITED_LIST="${EDITED_LIST},${NEW_EMAIL}"
                    fi
                    echo "  ✅ $(_t "已添加: $NEW_EMAIL" "Added: $NEW_EMAIL")"
                fi
            done
        elif [ "$LIST_OP" == "2" ]; then
            if [ -z "$current" ]; then
                echo "$(_t "列表为空，无可删除项。" "The list is empty — nothing to remove.")"
                return 1
            fi
            echo ""
            i=1
            declare -a EMAIL_ARR
            while IFS= read -r item; do
                [ -z "$item" ] && continue
                echo "  $i) $item"
                EMAIL_ARR[$i]="$item"
                i=$((i+1))
            done < <(echo "$current" | tr ',' '\n')

            echo ""
            read -p "$(_t "输入要删除的编号 (多个用空格分隔): " "Enter numbers to remove (space-separated): ")" DEL_NUMS
            for num in $DEL_NUMS; do
                DEL_EMAIL="${EMAIL_ARR[$num]}"
                if [ -n "$DEL_EMAIL" ]; then
                    EDITED_LIST=$(echo "$EDITED_LIST" | tr ',' '\n' | grep -vx "$DEL_EMAIL" | tr '\n' ',' | sed 's/,$//')
                    echo "  ✅ $(_t "已删除: $DEL_EMAIL" "Removed: $DEL_EMAIL")"
                fi
            done
        else
            return 1
        fi
        return 0
    }

    confirm_or_exit() {
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "$(_t "📋 更新后的列表:" "📋 Updated list:")"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        if [ -z "$1" ]; then
            echo "   $(_t "（空）" "(empty)")"
        else
            echo "$1" | tr ',' '\n' | while read -r item; do
                [ -n "$item" ] && echo "   • $item"
            done
        fi
        echo ""
        read -p "$(_t "确认更新? (y/n) [默认: y]: " "Confirm update? (y/n) [default: y]: ")" CONFIRM
        CONFIRM=${CONFIRM:-y}
        if [ "$CONFIRM" != "y" ]; then
            echo "$(_t "❌ 已取消" "❌ Cancelled")"
            exit 0
        fi
    }

    AUTH_KIND_LABEL=$(case "$AUTH_KIND" in
        gis)   _t "Google Sign-In (应用层白名单)" "Google Sign-In (application-level allowlist)" ;;
        iap)   _t "Cloud Run 原生 IAP (IAM 授权)" "Cloud Run native IAP (IAM-based)" ;;
        basic) _t "固定用户名/密码" "Fixed username/password" ;;
        *)     _t "未配置任何登录验证" "No login protection configured" ;;
    esac)
    echo ""
    echo "$(_t "🛡️  该服务的登录方式: " "🛡️  Login method for this service: ")${AUTH_KIND_LABEL}"

    echo ""
    echo "$(_t "请选择要管理的内容:" "What would you like to manage?")"
    echo "  1) $(_t "可登录用户" "Users allowed to sign in")"
    echo "  2) $(_t "管理员 (可访问 Admin 仪表板, ADMIN_USERS)" "Admins (Admin dashboard access, ADMIN_USERS)")"
    echo "  3) $(_t "退出" "Exit")"
    read -p "$(_t "输入选项 [1/2/3, 默认: 1]: " "Enter option [1/2/3, default: 1]: ")" MANAGE_WHAT
    MANAGE_WHAT=${MANAGE_WHAT:-1}

    # ── 管理员名单 (所有登录方式通用) / Admin list (all auth modes) ──────────
    if [ "$MANAGE_WHAT" == "2" ]; then
        echo ""
        echo "$(_t "ℹ️  ADMIN_USERS 决定谁能打开 Admin 仪表板 (/api/admin/*)。" "ℹ️  ADMIN_USERS decides who can open the Admin dashboard (/api/admin/*).")"
        echo "   $(_t "留空时回退到 AUTHORIZED_USERS；两者都为空则 Admin 接口完全禁用。" "When empty it falls back to AUTHORIZED_USERS; if both are empty the Admin API is disabled entirely.")"
        if [ "$AUTH_KIND" == "basic" ]; then
            echo "   $(_t "固定密码模式下请填用户名 (不是邮箱)。" "In fixed-password mode use the username, not an email.")"
        fi
        if edit_email_list "$CUR_ADMIN_USERS" "$(_t "管理员名单" "admin list")"; then
            confirm_or_exit "$EDITED_LIST"
            echo ""
            echo "$(_t "🔄 正在更新 ADMIN_USERS..." "🔄 Updating ADMIN_USERS...")"
            update_one_env "ADMIN_USERS" "$EDITED_LIST"
            echo ""
            echo "$(_t "✅ 管理员名单已更新，立即生效。" "✅ Admin list updated — effective immediately.")"
        fi
        exit 0
    fi

    if [ "$MANAGE_WHAT" == "3" ]; then
        exit 0
    fi

    # ── 可登录用户 / Users allowed to sign in ────────────────────────────────
    case "$AUTH_KIND" in
      gis)
        if edit_email_list "$CUR_AUTHORIZED" "$(_t "授权用户列表" "authorized user list")"; then
            confirm_or_exit "$EDITED_LIST"
            echo ""
            echo "$(_t "🔄 正在更新 AUTHORIZED_USERS..." "🔄 Updating AUTHORIZED_USERS...")"
            update_one_env "AUTHORIZED_USERS" "$EDITED_LIST"
            echo ""
            if [ -z "$EDITED_LIST" ]; then
                echo "$(_t "⚠️  列表已清空 — 任意能通过 OAuth 同意屏幕的 Google 账号都能进入应用。" "⚠️  The list is now empty — any Google account that passes the OAuth consent screen can enter the app.")"
            fi
            echo "$(_t "✅ 授权用户已更新，立即生效，无需重新部署。" "✅ Authorized users updated — effective immediately, no redeploy needed.")"
        fi
        ;;

      iap)
        echo ""
        echo "$(_t "ℹ️  IAP 部署的访问权限由 IAM 控制，不走环境变量。" "ℹ️  Access for an IAP deployment is controlled by IAM, not environment variables.")"
        echo "   $(_t "角色: ${IAP_ROLE}" "Role: ${IAP_ROLE}")"
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "$(_t "📋 当前可访问的成员:" "📋 Members with access:")"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        IAP_MEMBERS=$(list_iap_members)
        if [ -z "$IAP_MEMBERS" ]; then
            echo "   $(_t "（无，目前没人能访问）" "(none — nobody can access it yet)")"
        else
            echo "$IAP_MEMBERS" | while read -r m; do [ -n "$m" ] && echo "   • $m"; done
        fi

        echo ""
        echo "$(_t "请选择操作:" "Select an operation:")"
        echo "  1) $(_t "添加用户" "Add user")"
        echo "  2) $(_t "删除用户" "Remove user")"
        echo "  3) $(_t "查看后退出" "View and exit")"
        read -p "$(_t "输入选项 [1/2/3]: " "Enter option [1/2/3]: ")" IAP_OP

        if [ "$IAP_OP" == "1" ]; then
            echo ""
            echo "$(_t "输入邮箱 (每行一个，直接回车结束)。整个网域用 domain:example.com" "Enter emails (one per line, blank to finish). For a whole domain use domain:example.com")"
            while true; do
                read -p "$(_t "  邮箱: " "  Email: ")" NEW_M
                [ -z "$NEW_M" ] && break
                case "$NEW_M" in
                    user:*|group:*|domain:*|serviceAccount:*) MEMBER="$NEW_M" ;;
                    *) MEMBER="user:${NEW_M}" ;;
                esac
                # </dev/null: 否则 gcloud 会吃掉后面几行输入，循环提前结束。
                # </dev/null: otherwise gcloud swallows the remaining input lines
                # and this read loop exits early.
                # 用退出码判断成功 —— gcloud 把 "Updated IAM policy" 也写到 stderr。
                # Judge success by exit status: gcloud writes even its success
                # notice ("Updated IAM policy...") to stderr.
                if IAP_ERR=$(gcloud beta iap web add-iam-policy-binding \
                        --resource-type=cloud-run --service="$SERVICE_NAME" --region="$REGION" \
                        --project="$PROJECT_ID" --member="$MEMBER" --role="$IAP_ROLE" \
                        2>&1 >/dev/null </dev/null); then
                    echo "  ✅ $(_t "已添加: $MEMBER" "Added: $MEMBER")"
                else
                    echo "  ❌ $(_t "添加失败: $MEMBER" "Failed to add: $MEMBER")"
                    echo "     $(echo "$IAP_ERR" | grep -m1 -E "ERROR|INVALID_ARGUMENT|PERMISSION_DENIED" || echo "$IAP_ERR" | tail -1)"
                fi
            done
            echo ""
            echo "$(_t "✅ 完成。IAP 权限变更通常在 1 分钟内生效。" "✅ Done. IAP permission changes usually take effect within a minute.")"

        elif [ "$IAP_OP" == "2" ]; then
            if [ -z "$IAP_MEMBERS" ]; then
                echo "$(_t "列表为空，无可删除项。" "The list is empty — nothing to remove.")"
                exit 0
            fi
            echo ""
            i=1
            declare -a MEM_ARR
            while IFS= read -r m; do
                [ -z "$m" ] && continue
                echo "  $i) $m"
                MEM_ARR[$i]="$m"
                i=$((i+1))
            done < <(echo "$IAP_MEMBERS")
            echo ""
            read -p "$(_t "输入要删除的编号 (多个用空格分隔): " "Enter numbers to remove (space-separated): ")" DEL_NUMS
            for num in $DEL_NUMS; do
                DEL_M="${MEM_ARR[$num]}"
                [ -z "$DEL_M" ] && continue
                if IAP_ERR=$(gcloud beta iap web remove-iam-policy-binding \
                        --resource-type=cloud-run --service="$SERVICE_NAME" --region="$REGION" \
                        --project="$PROJECT_ID" --member="$DEL_M" --role="$IAP_ROLE" \
                        2>&1 >/dev/null </dev/null); then
                    echo "  ✅ $(_t "已删除: $DEL_M" "Removed: $DEL_M")"
                else
                    echo "  ❌ $(_t "删除失败: $DEL_M" "Failed to remove: $DEL_M")"
                    echo "     $(echo "$IAP_ERR" | grep -m1 -E "ERROR|INVALID_ARGUMENT|PERMISSION_DENIED" || echo "$IAP_ERR" | tail -1)"
                fi
            done
            echo ""
            echo "$(_t "✅ 完成。" "✅ Done.")"
        fi
        ;;

      basic)
        echo ""
        echo "$(_t "ℹ️  该服务使用固定用户名/密码 (BASIC_AUTH_USERS)，没有可增删的邮箱白名单。" "ℹ️  This service uses fixed username/password (BASIC_AUTH_USERS); there is no email allowlist to edit.")"
        echo "   $(_t "要修改账号请重新执行模式 1，或手动更新该环境变量:" "To change accounts re-run mode 1, or update the variable manually:")"
        echo "   gcloud run services update $SERVICE_NAME --region=$REGION \\"
        echo "     --update-env-vars=\"^#^BASIC_AUTH_USERS=user1:pass1,user2:pass2\""
        ;;

      *)
        echo ""
        echo "$(_t "⚠️  该服务没有配置任何登录验证 — 任何人都能访问。" "⚠️  This service has no login protection at all — anyone can access it.")"
        echo "   $(_t "请重新执行模式 1 并选择一种验证方式。" "Re-run mode 1 and pick an authentication method.")"
        ;;
    esac

    exit 0
fi

# ══════════════════════════════════════════════════════════════
# 全新部署模式 / Fresh deployment mode
# ══════════════════════════════════════════════════════════════

# 检查并设置 Billing / Check Billing
BILLING_ENABLED=$(gcloud beta billing projects describe $PROJECT_ID --format="value(billingEnabled)" 2>/dev/null </dev/null || echo "False")
if [ "$BILLING_ENABLED" != "True" ]; then
    echo "$(_t "❌ 错误: 您的项目 $PROJECT_ID 未启用结算功能(Billing)。" "❌ Error: Billing is not enabled for project $PROJECT_ID.")"
    echo "$(_t "Cloud Run 需要开启结算账户才能使用。请访问 GCP 控制台开启后重试。" "Cloud Run requires billing to be enabled. Please enable it in the GCP Console and retry.")"
    exit 1
fi

echo ""
echo "$(_t "🔧 正在启用必要的 GCP API (这可能需要几分钟)..." "🔧 Enabling required GCP APIs (this may take a few minutes)...")"
gcloud services enable \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  aiplatform.googleapis.com \
  storage.googleapis.com \
  --project=$PROJECT_ID </dev/null

# 设置服务名称 / Set service name
read -p "$(_t "输入 Cloud Run 服务名称 [默认: gamerheads]: " "Enter Cloud Run service name [default: gamerheads]: ")" SERVICE_NAME
SERVICE_NAME=${SERVICE_NAME:-gamerheads}

# 设置区域 / Set region
read -p "$(_t "输入部署区域 [默认: us-central1]: " "Enter deployment region [default: us-central1]: ")" REGION
REGION=${REGION:-us-central1}

# 设置数据库名称 / Set database name
read -p "$(_t "输入 Firestore 数据库名称 [默认: gamerheads]: " "Enter Firestore database name [default: gamerheads]: ")" DATASTORE_DATABASE
DATASTORE_DATABASE=${DATASTORE_DATABASE:-gamerheads}

echo ""
echo "$(_t "🗄️  检查并创建 Datastore Mode 数据库 [$DATASTORE_DATABASE]..." "🗄️  Checking/creating Datastore Mode database [$DATASTORE_DATABASE]...")"
DB_EXISTS=$(gcloud firestore databases describe \
  --database="$DATASTORE_DATABASE" \
  --project=$PROJECT_ID \
  --format="value(name)" 2>/dev/null </dev/null || echo "")

if [ -z "$DB_EXISTS" ]; then
    echo "   $(_t "创建 Datastore Mode 数据库: $DATASTORE_DATABASE (region: $REGION)..." "Creating Datastore Mode database: $DATASTORE_DATABASE (region: $REGION)...")"
    gcloud firestore databases create \
      --database="$DATASTORE_DATABASE" \
      --location="$REGION" \
      --type=datastore-mode \
      --project=$PROJECT_ID </dev/null
    echo "   ✅ $(_t "数据库 [$DATASTORE_DATABASE] 创建成功" "Database [$DATASTORE_DATABASE] created successfully")"
else
    echo "   ℹ️  $(_t "数据库 [$DATASTORE_DATABASE] 已存在，跳过创建" "Database [$DATASTORE_DATABASE] already exists, skipping creation")"
fi

echo ""
echo "$(_t "ℹ️  此版本使用 Vertex AI (Application Default Credentials)，无需 Gemini API Key。" "ℹ️  This version uses Vertex AI (Application Default Credentials) — no Gemini API Key required.")"
echo "   $(_t "Cloud Run 将使用 Compute Service Account 自动鉴权。" "Cloud Run will authenticate automatically using the Compute Service Account.")"
echo ""
echo "$(_t "📦 配置生成视频的 GCS 存储桶:" "📦 Configure GCS bucket for generated videos:")"
DEFAULT_BUCKET="gamerheads$(date +%s | tail -c 5 | head -c 4)"
echo "   $(_t "默认 Bucket 名称: ${DEFAULT_BUCKET}" "Default bucket name: ${DEFAULT_BUCKET}")"
read -p "$(_t "输入 GCS Bucket 名称 (直接回车使用默认 [${DEFAULT_BUCKET}]): " "Enter GCS bucket name (press Enter to use default [${DEFAULT_BUCKET}]): ")" GCS_BUCKET
GCS_BUCKET=${GCS_BUCKET:-$DEFAULT_BUCKET}

# Create bucket if it doesn't exist
if ! gsutil ls "gs://${GCS_BUCKET}" </dev/null &>/dev/null; then
    echo "   $(_t "创建 GCS Bucket: gs://${GCS_BUCKET} (region: ${REGION:-us-central1})..." "Creating GCS bucket: gs://${GCS_BUCKET} (region: ${REGION:-us-central1})...")"
    gsutil mb -l "${REGION:-us-central1}" "gs://${GCS_BUCKET}" </dev/null
    echo "   ✅ $(_t "Bucket 创建成功" "Bucket created successfully")"
else
    echo "   ℹ️  $(_t "Bucket 已存在: gs://${GCS_BUCKET}" "Bucket already exists: gs://${GCS_BUCKET}")"
fi
GCS_BUCKET_NAME_ENV="$GCS_BUCKET"

echo "$(_t "🛡️  请选择网站登录验证方式:" "🛡️  Select website login authentication method:")"
echo "1) $(_t "Google 账号登录 (Google Identity Services，需要在 Console 手工创建 OAuth 客户端 ID)" "Google Sign-In (Google Identity Services — requires manually creating an OAuth Client ID in the Console)")"
echo "2) $(_t "固定用户名和密码验证" "Fixed username and password")"
echo "3) $(_t "Cloud Run 原生 IAP (推荐，同样是 Google 账号登录，但全程自动配置，无需 OAuth 客户端 ID)" "Cloud Run native IAP (recommended — also Google account sign-in, fully automated, no OAuth Client ID needed)")"
read -p "$(_t "输入选项 [1/2/3, 默认: 3]: " "Enter option [1/2/3, default: 3]: ")" AUTH_MODE
AUTH_MODE=${AUTH_MODE:-3}

BASIC_AUTH_ENV=""
GOOGLE_CLIENT_ID_ENV=""
AUTHORIZED_USERS_ENV=""
IAP_MEMBERS_INPUT=""
IAP_ROLE="roles/iap.httpsResourceAccessor"

if [ "$AUTH_MODE" == "1" ]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "$(_t "📋 步骤一：配置 Google Auth Platform (OAuth 同意屏幕)" "📋 Step 1: Configure Google Auth Platform (OAuth Consent Screen)")"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "   1. $(_t "访问: https://console.cloud.google.com/auth/overview" "Go to: https://console.cloud.google.com/auth/overview")"
    echo "      $(_t "选择项目: $PROJECT_ID" "Select project: $PROJECT_ID")"
    echo ""
    echo "   2. $(_t "点击「Get Started」(首次) 或进入已有配置" "Click \"Get Started\" (first time) or open existing config")"
    echo ""
    echo "   3. $(_t "【Branding】页面:" "【Branding】page:")"
    echo "      - App name: GamerHeads ($(_t "或自定义" "or custom name"))"
    echo "      - User support email: $(_t "填写您的邮箱" "enter your email")"
    echo "      - Developer contact email: $(_t "填写您的邮箱" "enter your email")"
    echo "      → Next"
    echo ""
    echo "   4. $(_t "【Audience】页面:" "【Audience】page:")"
    echo "      - $(_t "选择「External」" "Select \"External\"")"
    echo "      → Next"
    echo "   5. → $(_t "Contact Info 页面: 填写您的邮箱，完成后点击「Save and Create」" "Contact Info page: enter your email, then click \"Save and Create\"")"
    echo ""
    echo "   6. $(_t "【Audience】页面: 点击发布应用" "【Audience】page: click \"Publish app\"")"
    echo ""
    read -p "   ✅ $(_t "以上步骤完成后按回车继续..." "Press Enter when the above steps are complete...")" _CONFIRM_AUTH_PLATFORM
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "$(_t "📋 步骤二：创建 OAuth 2.0 客户端 ID" "📋 Step 2: Create OAuth 2.0 Client ID")"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "   1. $(_t "访问: https://console.cloud.google.com/apis/credentials" "Go to: https://console.cloud.google.com/apis/credentials")"
    echo "      $(_t "选择项目: $PROJECT_ID" "Select project: $PROJECT_ID")"
    echo ""
    echo "   2. $(_t "点击「创建凭据」→「OAuth 客户端 ID」" "Click \"Create Credentials\" → \"OAuth client ID\"")"
    echo ""
    echo "   3. $(_t "应用类型选「Web 应用」" "Set application type to \"Web application\"")"
    echo ""
    echo "   4. $(_t "「已获授权的 JavaScript 来源」填入 Cloud Run 服务 URL" "Under \"Authorized JavaScript origins\" enter the Cloud Run service URL")"
    echo "      $(_t "初次部署可先填: http://localhost" "For first deployment you can use: http://localhost")"
    echo "      $(_t "部署完成后再改为实际 URL (如: https://gamerheads-xxx.run.app)" "Update to the real URL after deployment (e.g. https://gamerheads-xxx.run.app)")"
    echo ""
    echo "   5. $(_t "点击「创建」，复制生成的「客户端 ID」" "Click \"Create\" and copy the generated \"Client ID\"")"
    echo ""
    read -p "👉 $(_t "输入 OAuth 2.0 客户端 ID: " "Enter OAuth 2.0 Client ID: ")" GOOGLE_CLIENT_ID_INPUT
    if [ -z "$GOOGLE_CLIENT_ID_INPUT" ]; then
        echo "$(_t "❌ 客户端 ID 不能为空" "❌ Client ID cannot be empty")"
        exit 1
    fi
    GOOGLE_CLIENT_ID_ENV="$GOOGLE_CLIENT_ID_INPUT"

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "$(_t "📋 步骤三：配置授权用户" "📋 Step 3: Configure authorized users")"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "   $(_t "Google Auth Platform 已设为公开，由应用层统一控制访问权限。" "Google Auth Platform is set to public; access is controlled at the application level.")"
    echo "   $(_t "输入允许登录的邮箱列表（逗号分隔）。" "Enter the list of emails allowed to log in (comma-separated).")"
    echo "   $(_t "留空 = 任意 Google 账号均可进入应用（不推荐）。" "Leave empty = any Google account can access the app (not recommended).")"
    echo "   $(_t "后续可随时通过 ./deploy.sh 选 3 添加/删除用户。" "You can add/remove users anytime by running ./deploy.sh and selecting option 3.")"
    echo "   ($(_t "如: a@gmail.com,b@company.com" "e.g. a@gmail.com,b@company.com"))"
    echo ""
    read -p "👉 $(_t "授权邮箱列表: " "Authorized email list: ")" AUTHORIZED_USERS_INPUT
    AUTHORIZED_USERS_ENV="$AUTHORIZED_USERS_INPUT"

    echo ""
    echo "✅ $(_t "Google Sign-In 配置完成" "Google Sign-In configuration complete")"

elif [ "$AUTH_MODE" == "2" ]; then
    echo ""
    echo "$(_t "配置固定用户名和密码 (支持多个账号):" "Configure fixed username(s) and password(s) (multiple accounts supported):")"

    USERS_LIST=""
    USER_COUNT=0

    while true; do
        read -p "👉 $(_t "输入用户名 (直接回车结束添加): " "Enter username (press Enter when done): ")" BASIC_USER
        if [ -z "$BASIC_USER" ]; then
            if [ $USER_COUNT -eq 0 ]; then
                echo "$(_t "❌ 至少需要配置一个用户名或密码" "❌ At least one username/password is required")"
                exit 1
            fi
            break
        fi

        read -s -p "🔑 $(_t "输入密码: " "Enter password: ")" BASIC_PASS
        echo ""
        if [ -z "$BASIC_PASS" ]; then
            echo "$(_t "❌ 密码不能为空，请重新输入" "❌ Password cannot be empty. Please try again.")"
            continue
        fi

        if [ -z "$USERS_LIST" ]; then
            USERS_LIST="${BASIC_USER}:${BASIC_PASS}"
        else
            USERS_LIST="${USERS_LIST},${BASIC_USER}:${BASIC_PASS}"
        fi

        USER_COUNT=$((USER_COUNT + 1))
        echo "✅ $(_t "账号 [$BASIC_USER] 已记录. (当前共 $USER_COUNT 个账号)" "Account [$BASIC_USER] recorded. (Total: $USER_COUNT account(s))")"
        echo "----------------------------------------"
    done

    BASIC_AUTH_ENV="$USERS_LIST"
    echo "✅ $(_t "已完成配置 (共 $USER_COUNT 个账号)" "Configuration complete ($USER_COUNT account(s))")"

elif [ "$AUTH_MODE" == "3" ]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "$(_t "📋 Cloud Run 原生 IAP" "📋 Cloud Run native IAP")"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "   $(_t "IAP 在 Cloud Run 前面拦截所有请求，未登录会跳转到 Google 账号登录页。" "IAP intercepts every request in front of Cloud Run; unauthenticated visitors are redirected to Google sign-in.")"
    echo "   $(_t "访问权限用 IAM 角色 ${IAP_ROLE} 授予，不需要 OAuth 客户端 ID，也没有手工步骤。" "Access is granted with the IAM role ${IAP_ROLE} — no OAuth Client ID and no manual Console steps.")"
    echo "   $(_t "应用会从 IAP 注入的请求头读取登录邮箱，用于活动日志和项目归属。" "The app reads the signed-in email from the IAP-injected header for activity logs and project ownership.")"
    echo ""
    echo "$(_t "输入允许访问的邮箱 (逗号分隔)。整个网域用 domain:example.com。" "Enter the emails allowed in (comma-separated). For a whole domain use domain:example.com.")"
    echo "   $(_t "留空则先不授权任何人，之后用 ./deploy.sh 模式 3 添加。" "Leave empty to grant nobody for now and add people later with ./deploy.sh mode 3.")"
    echo ""
    read -p "👉 $(_t "授权邮箱列表: " "Authorized email list: ")" IAP_MEMBERS_INPUT

    echo ""
    echo "🔧 $(_t "启用 IAP API..." "Enabling the IAP API...")"
    gcloud services enable iap.googleapis.com --project=$PROJECT_ID </dev/null 2>&1 | tail -2

    echo "✅ $(_t "IAP 配置完成" "IAP configuration complete")"
fi

# ── 管理员名单 (所有验证方式通用) / Admin list (all auth modes) ──────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "$(_t "📋 配置管理员 (Admin 仪表板)" "📋 Configure admins (Admin dashboard)")"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "   $(_t "只有名单内的账号能打开 Admin 仪表板，看到所有用户的活动日志和生成文件。" "Only accounts on this list can open the Admin dashboard and see every user's activity log and generated files.")"
if [ "$AUTH_MODE" == "2" ]; then
    echo "   $(_t "固定密码模式下请填用户名 (不是邮箱)，逗号分隔。" "In fixed-password mode enter usernames (not emails), comma-separated.")"
else
    echo "   $(_t "填邮箱，逗号分隔。" "Enter emails, comma-separated.")"
fi
echo "   $(_t "⚠️ 留空则回退到「授权用户」名单 (所有能登录的人都是管理员)；" "⚠️ If left empty it falls back to the authorized-user list (everyone who can sign in becomes an admin);")"
echo "   $(_t "   若两者都为空，Admin 接口会被完全禁用。" "   if both are empty the Admin API is disabled entirely.")"
echo ""
read -p "👉 $(_t "管理员名单: " "Admin list: ")" ADMIN_USERS_INPUT
ADMIN_USERS_ENV="$ADMIN_USERS_INPUT"

# ── Autopilot (可选) / Autopilot (optional) ────────────────────
# 默认关闭：直接回车得到的部署与加入该功能之前完全一致。
# Defaults to off, so pressing Enter yields exactly the pre-Autopilot deployment.
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "$(_t "🤖 Autopilot (批量成片，可选)" "🤖 Autopilot (batch production, optional)")"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "   $(_t "填一次表单，确认主播形象，然后一次拿到多个成片。" "Fill one form, confirm the streamer, then collect several finished videos.")"
echo "   $(_t "启用会额外配置存储桶 CORS 与常驻实例 (空闲也计费)。" "Enabling also configures bucket CORS and a warm instance (billed while idle).")"
echo "   $(_t "现在跳过也可以，之后用 ./deploy.sh → 模式 4 随时开启。" "You can skip this and enable it later with ./deploy.sh → mode 4.")"
echo ""
read -p "👉 $(_t "启用 Autopilot? (y/n) [默认: n]: " "Enable Autopilot? (y/n) [default: n]: ")" AUTOPILOT_INPUT
AUTOPILOT_INPUT=${AUTOPILOT_INPUT:-n}
if [ "$AUTOPILOT_INPUT" == "y" ] || [ "$AUTOPILOT_INPUT" == "Y" ]; then
    AUTOPILOT_ENV="1"
else
    AUTOPILOT_ENV=""
fi

echo ""
echo "$(_t "📋 部署确认:" "📋 Deployment confirmation:")"
echo "   $(_t "项目ID: $PROJECT_ID" "Project ID: $PROJECT_ID")"
echo "   $(_t "服务名: $SERVICE_NAME" "Service   : $SERVICE_NAME")"
echo "   $(_t "区域: $REGION" "Region    : $REGION")"
echo "   $(_t "数据库: $DATASTORE_DATABASE" "Database  : $DATASTORE_DATABASE")"
echo "   $(_t "AI 模式: Vertex AI (ADC)" "AI mode   : Vertex AI (ADC)")"
echo "   $(_t "视频存储: gs://${GCS_BUCKET_NAME_ENV}" "Video storage: gs://${GCS_BUCKET_NAME_ENV}")"
if [ "$AUTH_MODE" == "1" ]; then
    echo "   $(_t "验证方式: Google Sign-In" "Auth method: Google Sign-In")"
    echo "   $(_t "Client ID: ${GOOGLE_CLIENT_ID_ENV:0:20}..." "Client ID  : ${GOOGLE_CLIENT_ID_ENV:0:20}...")"
    if [ -n "$AUTHORIZED_USERS_ENV" ]; then
        echo "   $(_t "授权用户: $AUTHORIZED_USERS_ENV" "Authorized users: $AUTHORIZED_USERS_ENV")"
    else
        echo "   $(_t "授权用户: 任意 Google 账号" "Authorized users: Any Google account")"
    fi
elif [ "$AUTH_MODE" == "2" ]; then
    echo "   $(_t "验证方式: 固定用户名/密码 (共 $USER_COUNT 个账号)" "Auth method: Fixed username/password ($USER_COUNT account(s))")"
elif [ "$AUTH_MODE" == "3" ]; then
    echo "   $(_t "验证方式: Cloud Run 原生 IAP" "Auth method: Cloud Run native IAP")"
    if [ -n "$IAP_MEMBERS_INPUT" ]; then
        echo "   $(_t "授权用户: $IAP_MEMBERS_INPUT" "Authorized users: $IAP_MEMBERS_INPUT")"
    else
        echo "   $(_t "授权用户: 暂无 (部署后需用模式 3 添加)" "Authorized users: none yet (add them with mode 3 after deploying)")"
    fi
fi
if [ -n "$AUTOPILOT_ENV" ]; then
    echo "   $(_t "Autopilot: 启用" "Autopilot : enabled")"
fi
if [ -n "$ADMIN_USERS_ENV" ]; then
    echo "   $(_t "管理员: $ADMIN_USERS_ENV" "Admins    : $ADMIN_USERS_ENV")"
else
    echo "   $(_t "管理员: 未单独设置 (回退到授权用户名单)" "Admins    : not set separately (falls back to the authorized-user list)")"
fi
echo ""

read -p "$(_t "确认开始部署? (y/n) [默认: y]: " "Confirm deployment? (y/n) [default: y]: ")" CONFIRM
CONFIRM=${CONFIRM:-y}
if [ "$CONFIRM" != "y" ]; then
    echo "$(_t "❌ 已取消部署" "❌ Deployment cancelled")"
    exit 0
fi

echo ""
echo "$(_t "🔐 配置服务权限..." "🔐 Configuring service permissions...")"
# 获取 Project Number / Get Project Number
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)' </dev/null)

echo "   - $(_t "配置 Cloud Build 权限..." "Configuring Cloud Build permissions...")"
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
  --role="roles/artifactregistry.writer" \
  --condition=None \
  </dev/null > /dev/null 2>&1 || echo "   ($(_t "忽略权限赋予的警告，继续执行" "Ignoring permission grant warning, continuing"))"

echo "   - $(_t "配置 Cloud Run 运行所需的各项服务权限 (Datastore, Vertex AI, Storage 等)..." "Configuring Cloud Run service permissions (Datastore, Vertex AI, Storage, etc.)...")"
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

if [ -n "$GCS_BUCKET_NAME_ENV" ]; then
    echo "   - $(_t "授予 Compute SA 对 gs://${GCS_BUCKET_NAME_ENV} 的访问权限..." "Granting Compute SA access to gs://${GCS_BUCKET_NAME_ENV}...")"
    gsutil iam ch "serviceAccount:${COMPUTE_SA}:roles/storage.objectAdmin" "gs://${GCS_BUCKET_NAME_ENV}" \
      </dev/null > /dev/null 2>&1 || echo "   ($(_t "⚠️ Bucket IAM 绑定失败，请确认您有该 Bucket 的管理权限" "⚠️ Bucket IAM binding failed — ensure you have admin rights on this bucket"))"
fi

ROLES=(
  "roles/datastore.user"
  "roles/cloudtrace.agent"
  "roles/cloudtranslate.user"
  "roles/logging.logWriter"
  "roles/monitoring.metricWriter"
  "roles/iam.serviceAccountTokenCreator"
  "roles/storage.objectAdmin"
  "roles/aiplatform.user"
)

for ROLE in "${ROLES[@]}"; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:${COMPUTE_SA}" \
    --role="$ROLE" \
    --condition=None \
    </dev/null > /dev/null 2>&1 || echo "   ($(_t "⚠️ 无法绑定角色 $ROLE，可能是权限不足" "⚠️ Could not bind role $ROLE — insufficient permissions"))"
done

echo "   ✅ $(_t "权限配置完成" "Permission configuration complete")"

echo ""
echo "$(_t "🏗️  开始部署到 Cloud Run..." "🏗️  Starting deployment to Cloud Run...")"
echo "$(_t "📦 正在将本地源码打包并利用 GCP Cloud Build 进行云端构建并部署 (大约需要 3-5 分钟)..." "📦 Packaging local source and building via GCP Cloud Build (approx. 3-5 minutes)...")"

# 使用临时文件传递环境变量以支持密码中的特殊字符 (!@#$%^&*)
# Use a temp file to pass env vars — supports special chars in passwords
ENV_FILE=$(mktemp)
echo "GOOGLE_CLOUD_PROJECT: \"${PROJECT_ID}\"" >> "$ENV_FILE"
echo "GCP_LOCATION: \"${REGION}\"" >> "$ENV_FILE"
echo "DATASTORE_DATABASE: \"${DATASTORE_DATABASE}\"" >> "$ENV_FILE"
if [ -n "$GCS_BUCKET_NAME_ENV" ]; then
    echo "GCS_BUCKET_NAME: \"${GCS_BUCKET_NAME_ENV}\"" >> "$ENV_FILE"
fi
if [ "$AUTH_MODE" == "1" ]; then
    echo "GOOGLE_CLIENT_ID: \"${GOOGLE_CLIENT_ID_ENV}\"" >> "$ENV_FILE"
    if [ -n "$AUTHORIZED_USERS_ENV" ]; then
        echo "AUTHORIZED_USERS: '${AUTHORIZED_USERS_ENV}'" >> "$ENV_FILE"
    fi
elif [ "$AUTH_MODE" == "2" ]; then
    # 单引号可以防止 YAML 解析器转义特殊字符
    # Single quotes prevent YAML parser from escaping special characters
    echo "BASIC_AUTH_USERS: '${BASIC_AUTH_ENV}'" >> "$ENV_FILE"
fi
if [ -n "$AUTOPILOT_ENV" ]; then
    echo "AUTOPILOT_ENABLED: \"1\"" >> "$ENV_FILE"
fi
if [ -n "$ADMIN_USERS_ENV" ]; then
    echo "ADMIN_USERS: '${ADMIN_USERS_ENV}'" >> "$ENV_FILE"
fi

# IAP 模式下服务只能由 IAP 服务代理调用，绝不能加 --allow-unauthenticated，
# 否则 allUsers 会拿到 run.invoker，IAP 就被绕过了。
# Under IAP the service must only be invocable by the IAP service agent. Never
# add --allow-unauthenticated there: it grants run.invoker to allUsers, which
# bypasses IAP entirely.
if [ "$AUTH_MODE" == "3" ]; then
    AUTH_FLAG="--iap"
else
    AUTH_FLAG="--allow-unauthenticated"
fi

gcloud run deploy $SERVICE_NAME \
  --source . \
  --region=$REGION \
  --platform=managed \
  $AUTH_FLAG \
  --env-vars-file="$ENV_FILE" \
  --memory=2Gi \
  --cpu=2 \
  --timeout=3600 \
  --max-instances=10 \
  --min-instances=0 \
  --project=$PROJECT_ID

rm -f "$ENV_FILE"

# Autopilot 启用时的追加配置 / Extra setup when Autopilot was enabled
# 直传素材需要存储桶 CORS；后台推进需要常驻实例。
# Direct uploads need bucket CORS; unattended progress needs a warm instance.
if [ -n "$AUTOPILOT_ENV" ]; then
    echo ""
    echo "🤖 $(_t "配置 Autopilot..." "Configuring Autopilot...")"
    AP_URL=$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --project="$PROJECT_ID" \
        --format="value(status.url)" 2>/dev/null </dev/null)

    # Both Cloud Run host forms must be allowed; see the note in mode 4.
    AP_URL_ALT="https://${SERVICE_NAME}-${PROJECT_NUMBER}.${REGION}.run.app"
    if [ -n "$GCS_BUCKET_NAME_ENV" ] && [ -n "$AP_URL" ]; then
        AP_CORS=$(mktemp)
        cat > "$AP_CORS" <<APCORSEOF
[
  {
    "origin": ["${AP_URL}", "${AP_URL_ALT}"],
    "method": ["PUT", "GET", "HEAD", "OPTIONS"],
    "responseHeader": ["Content-Type", "Content-Length", "Content-Disposition", "x-goog-resumable"],
    "maxAgeSeconds": 3600
  }
]
APCORSEOF
        if gcloud storage buckets update "gs://${GCS_BUCKET_NAME_ENV}" --cors-file="$AP_CORS" --quiet </dev/null >/dev/null 2>&1; then
            AP_CORS_OK=$(gcloud storage buckets describe "gs://${GCS_BUCKET_NAME_ENV}" --format=json 2>/dev/null </dev/null | grep -c "$AP_URL" || echo 0)
            if [ "$AP_CORS_OK" -gt 0 ]; then
                echo "   ✅ $(_t "存储桶 CORS 已配置并回读确认" "Bucket CORS applied and verified")"
            else
                echo "   ⚠️  $(_t "CORS 已提交但回读未匹配，请手动确认" "CORS submitted but the read-back did not match; verify manually")"
            fi
        else
            echo "   ❌ $(_t "CORS 配置失败，素材直传会失败。手动执行:" "CORS failed; direct uploads will fail. Run manually:")"
            echo "      gcloud storage buckets update gs://${GCS_BUCKET_NAME_ENV} --cors-file=cors.json"
        fi
        rm -f "$AP_CORS"
    fi

    if gcloud run services update "$SERVICE_NAME" --region="$REGION" --project="$PROJECT_ID" \
            --min-instances=1 --no-cpu-throttling --quiet </dev/null >/dev/null 2>&1; then
        echo "   ✅ $(_t "常驻实例已启用 (关掉页面后批次继续跑)" "Warm instance enabled (batches continue after the tab closes)")"
        echo "      $(_t "如需省钱可用 ./deploy.sh → 模式 4 → 关闭" "To stop paying while idle use ./deploy.sh → mode 4 → disable")"
    else
        echo "   ⚠️  $(_t "常驻实例配置失败；批次只在页面打开时推进。" "Warm instance failed; batches will only advance while a tab is open.")"
    fi
fi

# IAP 模式：把授权邮箱绑定到 IAP 资源上 / IAP mode: grant access to the listed members
if [ "$AUTH_MODE" == "3" ] && [ -n "$IAP_MEMBERS_INPUT" ]; then
    echo ""
    echo "🔐 $(_t "授予 IAP 访问权限..." "Granting IAP access...")"
    echo "$IAP_MEMBERS_INPUT" | tr ',' '\n' | while read -r RAW_M; do
        RAW_M=$(echo "$RAW_M" | tr -d '[:space:]')
        [ -z "$RAW_M" ] && continue
        case "$RAW_M" in
            user:*|group:*|domain:*|serviceAccount:*) MEMBER="$RAW_M" ;;
            *) MEMBER="user:${RAW_M}" ;;
        esac
        if IAP_ERR=$(gcloud beta iap web add-iam-policy-binding \
                --resource-type=cloud-run --service="$SERVICE_NAME" --region="$REGION" \
                --project="$PROJECT_ID" --member="$MEMBER" --role="$IAP_ROLE" \
                2>&1 >/dev/null </dev/null); then
            echo "   ✅ $MEMBER"
        else
            echo "   ❌ $(_t "授权失败: $MEMBER" "Failed: $MEMBER")"
            echo "      $(echo "$IAP_ERR" | grep -m1 -E "ERROR|INVALID_ARGUMENT|PERMISSION_DENIED" || echo "$IAP_ERR" | tail -1)"
        fi
    done
fi

echo ""
echo "✅ $(_t "部署成功!" "Deployment successful!")"
echo ""

PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)' </dev/null)
SERVICE_URL="https://${SERVICE_NAME}-${PROJECT_NUMBER}.${REGION}.run.app"

echo "$(_t "🌐 服务访问地址: $SERVICE_URL" "🌐 Service URL: $SERVICE_URL")"
echo ""

if [ "$AUTH_MODE" == "1" ]; then
    echo "$(_t "⚠️  别忘了在 OAuth 凭据页把这个 URL 加到「已获授权的 JavaScript 来源」，否则登录按钮不工作:" "⚠️  Remember to add this URL to \"Authorized JavaScript origins\" on the OAuth credentials page, or the sign-in button will not work:")"
    echo "   $SERVICE_URL"
    echo "   https://console.cloud.google.com/apis/credentials?project=$PROJECT_ID"
    echo ""
    echo "$(_t "增删可登录用户: ./deploy.sh → 模式 3 → 可登录用户" "Add/remove users who can sign in: ./deploy.sh → mode 3 → users allowed to sign in")"
elif [ "$AUTH_MODE" == "3" ]; then
    echo "$(_t "🔒 服务已由 IAP 保护，未授权访问会跳转到 Google 登录页。" "🔒 The service is protected by IAP; unauthorized visitors are redirected to Google sign-in.")"
    if [ -z "$IAP_MEMBERS_INPUT" ]; then
        echo "$(_t "⚠️  目前还没有授权任何人，现在没人能打开这个地址。" "⚠️  Nobody has been granted access yet, so nobody can open this URL.")"
    fi
    echo "$(_t "增删可访问用户: ./deploy.sh → 模式 3 → 可登录用户" "Add/remove users: ./deploy.sh → mode 3 → users allowed to sign in")"
fi
echo "$(_t "增删管理员: ./deploy.sh → 模式 3 → 管理员" "Add/remove admins: ./deploy.sh → mode 3 → admins")"
echo ""
echo "$(_t "🎉 恭喜！GamerHeads 现已在您的 GCP 环境中运行。" "🎉 Congratulations! GamerHeads is now running in your GCP environment.")"
