# Client (static) — builds the Vite app and serves dist on $PORT.
# Railway: deploy as a service using this Dockerfile (the default).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Vite bakes in VITE_SPACETIMEDB_* from .env.local (maincloud + watchman-1v356).
RUN npm run build

FROM node:22-slim
WORKDIR /app
RUN npm i -g serve
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["sh", "-c", "serve -s dist -l ${PORT:-8080}"]
