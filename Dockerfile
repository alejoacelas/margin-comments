# Backend image for Fly.io. Node 24 (built-in node:sqlite), SQLite on a volume.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY scripts/build-server.mjs scripts/
COPY src ./src
RUN node scripts/build-server.mjs

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts && npm cache clean --force
COPY --from=build /app/build/server ./build/server
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "build/server/index.js"]
