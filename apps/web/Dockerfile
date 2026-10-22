FROM node:22-bookworm-slim AS build

ARG VITE_API_BASE_URL=https://videocraft.emancipationdevelopment.org/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

WORKDIR /app
COPY . .
RUN npm install --ignore-scripts && npm run build --workspace=@videocraft/web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
