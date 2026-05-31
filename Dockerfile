FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js .
COPY public/ ./public/

# Render handles SSL — run plain HTTP internally
ENV NO_HTTPS=true
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]
