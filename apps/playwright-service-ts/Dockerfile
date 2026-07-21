FROM mcr.microsoft.com/playwright:v1.58.1-noble@sha256:feae0b1581609d3dc2ba22567b4703dd6a3e7a219984bb86a19ed35007148a91 AS runtime

RUN corepack enable
RUN corepack prepare pnpm@10.33.0 --activate

WORKDIR /usr/src/app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

ARG PORT=3000
ENV PORT=${PORT}

EXPOSE ${PORT}

CMD [ "pnpm", "start" ]
