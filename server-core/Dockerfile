# server-core — Express + Prisma 7 (TS client) runs on Bun, matching the
# repo's bun-first workflow ("bun run server.js", prisma via bun).
# The old node:20-alpine image could not import the generated
# ./generated/prisma/client.ts and never ran `prisma generate`.
FROM oven/bun:1.2-slim
WORKDIR /usr/src/app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
# `prisma generate` only emits the client; it never connects, but the config
# resolves env("DATABASE_URL"), so give it a dummy value at build time.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" bunx prisma generate
EXPOSE 5000
CMD ["bun", "server.js"]
