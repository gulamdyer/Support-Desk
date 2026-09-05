# node:sqlite is unflagged from Node 23.4; 24 LTS is the safe floor.
FROM node:24-alpine

WORKDIR /app
RUN apk add --no-cache tini

# Deps first so a source-only push reuses these layers.
COPY package*.json ./
RUN npm ci --omit=dev
COPY bridge/package*.json ./bridge/
RUN npm ci --omit=dev --prefix bridge

COPY src ./src
COPY public ./public
COPY bridge ./bridge

# Both are volumes in production; created here so a bare `docker run` still works.
RUN mkdir -p data/media auth_state

ENV NODE_ENV=production PORT=8080
EXPOSE 8080

# tini reaps zombies and makes SIGTERM from Coolify stop the process promptly.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
