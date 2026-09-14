FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY tsconfig.json ./
COPY prisma.config.ts ./
COPY database ./database
COPY observability ./observability
COPY src ./src

ENV PRISMA_CLIENT_ENGINE_TYPE='binary'
RUN npx prisma generate --schema=./database/prisma/schema.prisma

RUN npm run build

ENV NODE_ENV=production

CMD ["npm", "start"]
