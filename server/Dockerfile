FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY kit.mjs guest.mjs consign.mjs ./
COPY kit ./kit
ENV PORT=8787 DATA=/data GUESTS=2 GUESTS_MNEMONIC_FILE=/run/secrets/guests
CMD ["node", "guest.mjs"]
