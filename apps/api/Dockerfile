FROM node:22-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y python3 make g++ rsync ffmpeg libimage-exiftool-perl && rm -rf /var/lib/apt/lists/*

COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
COPY apps/web/package.json apps/web/tsconfig.json apps/web/vite.config.ts ./apps/web/
COPY apps/host-helper/package.json apps/host-helper/tsconfig.json ./apps/host-helper/

RUN npm install

COPY packages/shared/src ./packages/shared/src
COPY apps/api/src ./apps/api/src

RUN npm run build -w @wrangler/shared && npm run build -w @wrangler/api

FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y rsync ffmpeg libimage-exiftool-perl && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json

EXPOSE 4001

CMD ["node", "dist/server.js"]
