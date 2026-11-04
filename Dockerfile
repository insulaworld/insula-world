# Insula World server image (used by Fly.io; works on any Docker host).
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY . .
ENV NODE_ENV=production PORT=8080 INSULA_SAVE=/data/world.json
EXPOSE 8080
CMD ["node", "server/index.js"]
