FROM node:20-slim
WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
# Rebuild native modules for the correct architecture
RUN npm ci --omit=dev || npm install --omit=dev

COPY app ./app
COPY public ./public
COPY universfield-ringtone-088-496414.mp3 ./

# Railway defaults
EXPOSE 8080
ENV PORT=8080

CMD ["node", "app/main.js"]
