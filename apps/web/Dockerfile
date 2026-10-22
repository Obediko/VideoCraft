FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY . .
RUN npm install --ignore-scripts && npm run build --workspace=@videocraft/web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
