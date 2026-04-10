FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p data logs raw/property-documents

EXPOSE 3100

CMD ["node", "src/api/server.js"]
