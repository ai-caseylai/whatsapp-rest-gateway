FROM node:22-alpine

WORKDIR /app

# Install deps first for better caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js connector.js ./
COPY admin/ admin/

EXPOSE 3090

CMD ["node", "server.js"]
