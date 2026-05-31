FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install express socket.io selfsigned mongoose dotenv

COPY server.js .
COPY public/ ./public/

ENV NO_HTTPS=true
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]
