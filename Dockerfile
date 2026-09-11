FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_FUND=false

# Baileys 6.7.24 uses a libsignal dependency fetched through Git.
# Railway's slim Node image does not include Git by default.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && git config --global url."https://github.com/".insteadOf "git://github.com/" \
    && git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 3000

CMD ["node", "start.js"]
