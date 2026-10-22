#!/usr/bin/env bash
# docs/test-plan.md §2.2 의 가짜 프로젝트 저장소를 만든다 (deployment.yaml 의 redis-servcie 오타 + verify.sh).
# 사용법: ./scripts/fixture-backend-api.sh [경로]   (기본 /tmp/baton-test-fixtures/backend-api)
set -euo pipefail
FIX="${1:-/tmp/baton-test-fixtures/backend-api}"
rm -rf "$FIX"
mkdir -p "$FIX"
cat > "$FIX/deployment.yaml" <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend-api
spec:
  template:
    spec:
      containers:
      - name: api
        image: backend-api:latest
        env:
        - name: REDIS_HOST
          value: redis-servcie # ← 오타 주입 (의도된 결함)
EOF
cat > "$FIX/verify.sh" <<'EOF'
#!/usr/bin/env bash
if grep -q "value: redis-service" deployment.yaml && ! grep -q "redis-servcie" deployment.yaml; then
  echo "DEPLOYMENT_VERIFIED_SUCCESS"
  exit 0
else
  echo "VERIFICATION_FAILED"
  exit 1
fi
EOF
chmod +x "$FIX/verify.sh"
printf '# backend-api\nKubernetes 배포 설정. 검증: ./verify.sh\n' > "$FIX/README.md"
(cd "$FIX" && git init -q && git add -A && git -c user.name=fixture -c user.email=fixture@baton.local commit -q -m 'fixture: redis-servcie typo')
echo "[baton-dev] fixture 준비 완료: $FIX (verify.sh 는 지금 VERIFICATION_FAILED 여야 정상)"
