FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY tsconfig.json tsconfig.provision.json ./
COPY scripts ./scripts
COPY assets ./assets
COPY prisma.config.ts ./
COPY database ./database
COPY observability ./observability
COPY src ./src

ENV PRISMA_CLIENT_ENGINE_TYPE='binary'
RUN npx prisma generate --schema=./database/prisma/schema.prisma


# npm run build already generates the Prisma Client.
# Give TypeScript sufficient memory for compilation.
RUN NODE_OPTIONS="--max-old-space-size=4096" npm run build

ENV NODE_ENV=production

CMD ["npm", "start"]
