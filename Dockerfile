FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev
COPY app ./app
COPY public ./public
ENV NODE_ENV=production
ENV PORT=8000
EXPOSE 8000
CMD ["node", "app/main.js"]
