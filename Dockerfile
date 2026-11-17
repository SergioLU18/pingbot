FROM node:20-slim

# ffmpeg is only used to turn videos/GIFs into animated stickers.
RUN apt-get update && apt-get install -y ffmpeg --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["node", "index.js"]
