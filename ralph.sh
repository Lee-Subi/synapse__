#!/usr/bin/env bash
# ============================================================
#  Ralph Loop - Simple Edition
#  Based on Geoffrey Huntley's Ralph Wiggum technique
#  Usage: ./ralph.sh [max_iterations]
# ============================================================

set -euo pipefail

# ── 설정 ────────────────────────────────────────────────────
MAX_ITER=${1:-20}          # 최대 반복 횟수 (기본 20)
COMPLETION_TOKEN="<promise>COMPLETE</promise>"
PRD_FILE="PRD.md"
PROGRESS_FILE="progress.txt"
CLAUDE_PROMPT="CLAUDE.md"
LOG_FILE="ralph_run.log"
# ─────────────────────────────────────────────────────────────

# 색상 출력
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

header() { echo -e "\n${BOLD}${CYAN}═══════════════════════════════════════${RESET}"; }
info()   { echo -e "${CYAN}[Ralph]${RESET} $1"; }
ok()     { echo -e "${GREEN}[✓]${RESET} $1"; }
warn()   { echo -e "${YELLOW}[!]${RESET} $1"; }
fail()   { echo -e "${RED}[✗]${RESET} $1"; }

# ── 사전 체크 ────────────────────────────────────────────────
check_requirements() {
    if ! command -v claude &>/dev/null; then
        fail "Claude Code가 설치되어 있지 않습니다."
        echo "  설치: npm install -g @anthropic-ai/claude-code"
        exit 1
    fi
    if [ ! -f "$PRD_FILE" ]; then
        fail "$PRD_FILE 파일이 없습니다. 먼저 PRD를 작성하세요."
        echo "  참고: prd_template.md 파일을 복사해서 시작하세요."
        exit 1
    fi
    if [ ! -f "$CLAUDE_PROMPT" ]; then
        fail "$CLAUDE_PROMPT 파일이 없습니다."
        exit 1
    fi
}

# ── git 초기화 확인 ──────────────────────────────────────────
ensure_git() {
    if [ ! -d ".git" ]; then
        warn "git 저장소가 없습니다. 초기화합니다..."
        git init
        git add -A
        git commit -m "chore: ralph loop 초기 커밋" --allow-empty
    fi
}

# ── 이터레이션 실행 ──────────────────────────────────────────
run_iteration() {
    local iter=$1
    local timestamp
    timestamp=$(date '+%Y-%m-%d %H:%M:%S')

    header
    echo -e " ${BOLD}Ralph Loop - 이터레이션 ${iter} / ${MAX_ITER}${RESET}  [${timestamp}]"
    header

    # progress.txt 가 없으면 생성
    if [ ! -f "$PROGRESS_FILE" ]; then
        echo "# Ralph Loop 진행 상황" > "$PROGRESS_FILE"
        echo "시작: $timestamp" >> "$PROGRESS_FILE"
    fi

    # CLAUDE.md + PRD.md + progress.txt 를 합쳐서 프롬프트 구성
    local prompt
    prompt=$(cat "$CLAUDE_PROMPT")
    prompt="${prompt}

---
## 현재 PRD ($(cat $PRD_FILE | wc -l) 줄)
$(cat $PRD_FILE)

---
## 지금까지 진행 상황
$(cat $PROGRESS_FILE 2>/dev/null || echo '아직 없음')
"

    # Claude Code 실행 (non-interactive, print mode)
    local output
    info "Claude Code 실행 중..."
    output=$(echo "$prompt" | claude --print --dangerously-skip-permissions 2>&1) || true

    # 로그 기록
    {
        echo "=== 이터레이션 $iter / $timestamp ==="
        echo "$output"
        echo ""
    } >> "$LOG_FILE"

    # 출력 표시 (처음 50줄만)
    echo "$output" | head -50
    local line_count
    line_count=$(echo "$output" | wc -l)
    if [ "$line_count" -gt 50 ]; then
        warn "... ($((line_count - 50))줄 생략, 전체는 $LOG_FILE 참조)"
    fi

    # 진행 상황 업데이트 (Claude 출력에서 ## PROGRESS 섹션 파싱)
    if echo "$output" | grep -q "## PROGRESS"; then
        echo "$output" | awk '/## PROGRESS/,/## END_PROGRESS/' >> "$PROGRESS_FILE"
        echo "--- 이터레이션 $iter 완료: $timestamp ---" >> "$PROGRESS_FILE"
    fi

    # git 커밋 (변경사항 있을 때만)
    if ! git diff --quiet || ! git diff --staged --quiet 2>/dev/null; then
        git add -A
        git commit -m "ralph: 이터레이션 $iter - $(date '+%H:%M:%S')" 2>/dev/null || true
        ok "변경사항 커밋 완료"
    else
        info "이번 이터레이션에서 변경사항 없음"
    fi

    # 완료 토큰 확인
    if echo "$output" | grep -qF "$COMPLETION_TOKEN"; then
        return 0  # 완료!
    fi
    return 1  # 계속
}

# ── 메인 루프 ────────────────────────────────────────────────
main() {
    header
    echo -e " ${BOLD}🔁  Ralph Loop 시작${RESET}"
    echo -e "    PRD: $PRD_FILE"
    echo -e "    최대 이터레이션: $MAX_ITER"
    echo -e "    완료 토큰: $COMPLETION_TOKEN"
    header

    check_requirements
    ensure_git

    local start_time=$SECONDS

    for (( i=1; i<=MAX_ITER; i++ )); do
        if run_iteration "$i"; then
            header
            ok "${BOLD}Ralph Loop 완료! (${i}번 이터레이션)${RESET}"
            echo -e "    소요 시간: $(( SECONDS - start_time ))초"
            echo -e "    로그: $LOG_FILE"
            header
            exit 0
        fi
        # 짧은 대기 (API rate limit 방지)
        sleep 2
    done

    header
    warn "최대 이터레이션(${MAX_ITER})에 도달했습니다."
    warn "progress.txt와 ralph_run.log를 확인하세요."
    header
    exit 1
}

main "$@"
