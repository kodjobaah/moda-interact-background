FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY tsconfig.json ./
COPY prisma.config.ts ./
COPY database ./database
COPY src ./src

RUN npm run build

ENV NODE_ENV=production

CMD ["npm", "start"]