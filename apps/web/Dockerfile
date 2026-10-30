FROM node:22-bookworm-slim AS build

ARG RELEASE_SHA=unknown
ENV VITE_RELEASE_SHA=$RELEASE_SHA
ARG VITE_API_BASE_URL=https://videocraft.emancipationdevelopment.org/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

WORKDIR /app
COPY . .
RUN npm install --ignore-scripts && npm run build --workspace=@videocraft/domain && npm run build --workspace=@videocraft/web && printf '{"sha":"%s"}\n' "$RELEASE_SHA" > apps/web/dist/version.json

FROM nginx:1.27-alpine
ARG RELEASE_SHA=unknown
LABEL org.opencontainers.image.revision=$RELEASE_SHA
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
