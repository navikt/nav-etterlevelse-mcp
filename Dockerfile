FROM node:22-alpine AS builder
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build
# Installer kun prod-avhengigheter for kopiering til runtime
RUN pnpm install --frozen-lockfile --prod

# Runtime: kun Node.js + dist/ + prod node_modules — ingen pnpm, npm eller tar
FROM node:22-alpine
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
    # Fjern npm og npx for å redusere angrepsflate og eliminere npm/tar-sårbarheter
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
USER appuser
EXPOSE 8080
CMD ["node", "dist/index.js"]
