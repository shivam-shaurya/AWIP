# Frontend (TanStack Start SSR) — production image.
# Build args allow subpath deploys (e.g. VITE_BASE_PATH=/awip/ behind nginx).
FROM oven/bun:1.2-slim AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile
COPY . .
ARG VITE_BASE_PATH=/
ARG VITE_CORE_API_URL
ARG VITE_AI_API_URL
ENV VITE_BASE_PATH=$VITE_BASE_PATH \
    VITE_CORE_API_URL=$VITE_CORE_API_URL \
    VITE_AI_API_URL=$VITE_AI_API_URL \
    NITRO_PRESET=node-server
RUN bun run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/.output ./.output
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
