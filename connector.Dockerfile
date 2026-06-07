# Connector (the "brain") — embeds frames + answers via Gemini.
# Railway: deploy as a SECOND service, set Dockerfile path to connector.Dockerfile,
# and set the GEMINI_API_KEY variable. Long-running; no port needed.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && npm i -g tsx
COPY . .
# Reads GEMINI_API_KEY (required), GEMINI_MODEL (optional),
# SPACETIMEDB_HOST / SPACETIMEDB_DB_NAME (default: maincloud / watchman-1v356).
CMD ["tsx", "connector.ts"]
