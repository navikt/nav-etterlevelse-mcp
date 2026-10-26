# Byggesteget kjører på Alpine. Det havner ikke i runtime-imaget, og ingen prod-avhengigheter
# har native binærfiler, så det er trygt å bygge med musl og kjøre på glibc (Chainguard).
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
# Installer kun prod-avhengigheter for kopiering til runtime. node_modules slettes først:
# pnpm install --prod fjerner bare lenkene, mens pakkene blir liggende i node_modules/.pnpm
# og ville blitt med i imaget.
RUN rm -rf node_modules && pnpm install --frozen-lockfile --prod

# Runtime: Chainguard Node fra Navs registry. Kjører som non-root og har verken npm eller pnpm.
FROM europe-north1-docker.pkg.dev/cgr-nav/pull-through/nav.no/node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
EXPOSE 8080
CMD ["dist/index.js"]
