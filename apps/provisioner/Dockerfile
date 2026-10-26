# Build from the repository root, because the image bundles the store chart:
#   docker build -f apps/provisioner/Dockerfile -t urumi/provisioner:dev .
FROM node:22-alpine AS build
WORKDIR /app
COPY apps/provisioner/package.json apps/provisioner/package-lock.json ./
RUN npm ci
COPY apps/provisioner/tsconfig.json ./
COPY apps/provisioner/src ./src
RUN npm run build && npm prune --omit=dev

FROM alpine:3.22 AS helm
ARG HELM_VERSION=v3.18.4
ARG TARGETARCH
RUN apk add --no-cache curl tar \
 && curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${TARGETARCH:-amd64}.tar.gz" | tar -xz -C /tmp \
 && mv /tmp/linux-*/helm /usr/local/bin/helm

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=helm /usr/local/bin/helm /usr/local/bin/helm
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY apps/provisioner/package.json ./
# The chart used to provision stores: same chart as the main store, so a new store is exactly like the first.
COPY charts/store /charts/store
USER node
EXPOSE 8081
CMD ["node", "dist/index.js"]
