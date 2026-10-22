FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app
COPY . .
RUN npm install --ignore-scripts && npm run build

USER node
EXPOSE 8080
CMD ["node", "apps/api/dist/main.js"]
