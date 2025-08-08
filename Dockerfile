FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
ENV PORT=3001
EXPOSE 3001
CMD [ "sh", "-c", "npm run db:push && node server.js" ]
