FROM node:22-slim
WORKDIR /app

# Install build dependencies if needed (though better-sqlite3 usually provides prebuilds for debian/slim)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY app ./app
COPY public ./public
COPY universfield-ringtone-088-496414.mp3 ./

# Railway will provide the dynamic PORT env var, we don't need to set a fixed one here.
# EXPOSE is still helpful for documentation/tools.
EXPOSE 8080

CMD ["node", "app/main.js"]
