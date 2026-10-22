# 저장소 루트를 빌드 컨텍스트로 사용한다.
FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN npm install --global pnpm@10.15.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
# 빈 값은 동일 origin을 뜻한다. 외부 API 주소는 환경별 빌드 인자로 지정한다.
ARG NEXT_PUBLIC_API_URL=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_API_MODE=real NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @baton/shared build \
    && pnpm --filter @baton/web build \
    && mkdir -p apps/web/public

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
