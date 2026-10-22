# 저장소 루트를 빌드 컨텍스트로 사용한다.
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@10.15.0
WORKDIR /app

FROM base AS builder
# bcrypt 사전 빌드 파일을 받을 수 없는 환경에서도 네이티브 모듈을 빌드한다.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/server/package.json ./apps/server/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @baton/server exec node -e "require('child_process').execFileSync('npm', ['run', 'install'], {cwd: require('path').dirname(require.resolve('bcrypt/package.json')), stdio: 'inherit'})"
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server
RUN pnpm --filter @baton/shared build \
    && pnpm --filter @baton/server prisma:generate \
    && pnpm --filter @baton/server build

FROM base AS runner
ENV NODE_ENV=production PORT=3001 HOST=0.0.0.0
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/tsconfig.base.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=builder /app/apps/server/package.json ./apps/server/package.json
COPY --from=builder /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=builder /app/apps/server/dist ./apps/server/dist
# 같은 이미지의 initContainer에서 실행한다 (dev-deploy-plan.md "기동 절차"):
#   npx prisma migrate deploy && node dist/cli/install-audit.js
# 감사 트리거 설치기는 src/cli 에서 dist 로 컴파일되므로 tsx 없이 돈다.
COPY --from=builder /app/apps/server/prisma ./apps/server/prisma
WORKDIR /app/apps/server
USER node
EXPOSE 3001
# 마이그레이션과 감사 트리거 설치는 배포 단계에서 별도로 수행한다.
CMD ["node", "dist/main.js"]
