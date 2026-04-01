FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY apps/web/package.json apps/web/tsconfig.json apps/web/vite.config.ts ./apps/web/
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
COPY apps/host-helper/package.json apps/host-helper/tsconfig.json ./apps/host-helper/

RUN npm install

COPY packages/shared/src ./packages/shared/src
COPY apps/web/index.html ./apps/web/index.html
COPY apps/web/src ./apps/web/src

RUN npm run build -w @wrangler/shared && npm run build -w @wrangler/web

FROM nginx:1.27-alpine

COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
