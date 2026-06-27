#!/bin/bash
# =========================================================
#  Safe Market Maker 双场地网络稳定性测试
#  同时测试 Polymarket + Predict.fun 所有核心接口
#
#  在新 VPS 上一键下载:
#  curl -O https://raw.githubusercontent.com/zhou2333133/safe-market-maker/main/network-test.sh
#
#  运行: bash network-test.sh [分钟数] [间隔秒数]
#  默认: 跑 8 小时 (480分钟), 每 5 秒一轮
# =========================================================

DURATION_MIN=${1:-480}
INTERVAL_SEC=${2:-5}
END_TS=$(($(date +%s) + DURATION_MIN * 60))
LOGFILE="network-test-$(date +%Y%m%d-%H%M%S).log"

# ===== 测试目标 =====
# Polymarket: 交易 REST / 市场数据 REST
POLY_CLOB="https://clob.polymarket.com"
POLY_GAMMA="https://gamma-api.polymarket.com"
# Predict.fun: 交易 REST
PREDICT_API="https://api.predict.fun"

TOTAL=0
FAIL=0
LATENCIES_POLY=()
LATENCIES_PREDICT=()

echo "==================================================" | tee "$LOGFILE"
echo " Safe Market Maker — 网络稳定性测试" | tee -a "$LOGFILE"
echo " 开始: $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$LOGFILE"
echo " 时长: ${DURATION_MIN} 分钟  |  间隔: ${INTERVAL_SEC} 秒" | tee -a "$LOGFILE"
echo " 预计: ~$((DURATION_MIN * 60 / INTERVAL_SEC)) 轮测试" | tee -a "$LOGFILE"
echo "--------------------------------------------------" | tee -a "$LOGFILE"
echo " 测试接口:" | tee -a "$LOGFILE"
echo "   Poly CLOB:   $POLY_CLOB  (挂单/撤单/查持仓)" | tee -a "$LOGFILE"
echo "   Poly Gamma:  $POLY_GAMMA  (市场数据/行情)" | tee -a "$LOGFILE"
echo "   Predict API: $PREDICT_API  (交易+行情)" | tee -a "$LOGFILE"
echo "==================================================" | tee -a "$LOGFILE"
echo "" | tee -a "$LOGFILE"

while [ $(date +%s) -lt $END_TS ]; do
    TOTAL=$((TOTAL + 1))
    NOW=$(date '+%H:%M:%S')
    
    # ---- Polymarket CLOB (交易接口: 挂单/撤单/查持仓/查余额) ----
    START=$(date +%s%3N)
    POLY_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
        "${POLY_CLOB}/markets" 2>/dev/null)
    END=$(date +%s%3N)
    POLY_LAT=$((END - START))
    POLY_STATUS="OK"
    [ "$POLY_CODE" != "200" ] && POLY_STATUS="FAIL($POLY_CODE)" && FAIL=$((FAIL + 1))
    LATENCIES_POLY+=($POLY_LAT)
    
    # ---- Polymarket Gamma (市场数据: 事件/行情/奖励) ----
    START=$(date +%s%3N)
    GAMMA_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
        "${POLY_GAMMA}/events?limit=1" 2>/dev/null)
    END=$(date +%s%3N)
    GAMMA_LAT=$((END - START))
    GAMMA_STATUS="OK"
    [ "$GAMMA_CODE" != "200" ] && GAMMA_STATUS="FAIL($GAMMA_CODE)" && FAIL=$((FAIL + 1))
    
    # ---- Predict.fun API (交易+行情) ----
    START=$(date +%s%3N)
    PREDICT_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
        "${PREDICT_API}/markets" 2>/dev/null)
    END=$(date +%s%3N)
    PREDICT_LAT=$((END - START))
    PREDICT_STATUS="OK"
    [ "$PREDICT_CODE" != "200" ] && PREDICT_STATUS="FAIL($PREDICT_CODE)" && FAIL=$((FAIL + 1))
    LATENCIES_PREDICT+=($PREDICT_LAT)
    
    # 输出 (同时在屏幕和日志)
    printf "[%s] Poly:%-8s %4sms | Gamma:%-8s %4sms | Predict:%-8s %4sms\n" \
        "$NOW" "$POLY_STATUS" "$POLY_LAT" "$GAMMA_STATUS" "$GAMMA_LAT" \
        "$PREDICT_STATUS" "$PREDICT_LAT" | tee -a "$LOGFILE"
    
    sleep $INTERVAL_SEC
done

# ============================
# 统计
# ============================
calc_stats() {
    local name=$1; shift
    local arr=("$@")
    local sum=0 min=999999 max=0 count=${#arr[@]}
    [ $count -eq 0 ] && echo "$name: 无数据" && return
    for v in "${arr[@]}"; do
        sum=$((sum + v))
        [ $v -lt $min ] && min=$v
        [ $v -gt $max ] && max=$v
    done
    local avg=$((sum / count))
    echo "$name: 平均=${avg}ms  最小=${min}ms  最大=${max}ms  样本=${count}"
}

FAIL_RATE=$(awk "BEGIN {printf \"%.2f\", ($FAIL/$TOTAL)*100}")

echo "" | tee -a "$LOGFILE"
echo "==================================================" | tee -a "$LOGFILE"
echo " 测试完成: $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$LOGFILE"
echo "==================================================" | tee -a "$LOGFILE"
echo "总请求: $TOTAL 轮 (每轮 3 个接口 = $((TOTAL * 3)) 次)" | tee -a "$LOGFILE"
echo "失败: $FAIL 次 (${FAIL_RATE}%)" | tee -a "$LOGFILE"
echo "" | tee -a "$LOGFILE"
calc_stats "Poly CLOB  " "${LATENCIES_POLY[@]}" | tee -a "$LOGFILE"
calc_stats "Predict API" "${LATENCIES_PREDICT[@]}" | tee -a "$LOGFILE"

echo "" | tee -a "$LOGFILE"
if [ "$FAIL_RATE" = "0.00" ]; then
    echo "✓★ 结论: 网络完美稳定，强烈推荐切换" | tee -a "$LOGFILE"
elif awk "BEGIN{exit !($FAIL_RATE < 1)}"; then
    echo "✓ 结论: 网络基本稳定 (<1% 失败), 可以切换" | tee -a "$LOGFILE"
elif awk "BEGIN{exit !($FAIL_RATE < 5)}"; then
    echo "△ 结论: 有小幅波动 (${FAIL_RATE}% 失败), 谨慎使用" | tee -a "$LOGFILE"
else
    echo "✗ 结论: 网络不稳定 (${FAIL_RATE}% 失败), 不建议切换" | tee -a "$LOGFILE"
fi

echo "" | tee -a "$LOGFILE"
echo "日志: $LOGFILE" | tee -a "$LOGFILE"
