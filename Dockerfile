FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data TRUST_PROXY=1
EXPOSE 8787
CMD ["node", "dist/server.mjs"]
