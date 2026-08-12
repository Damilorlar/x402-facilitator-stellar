# Build stage
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src/ src/

# Production stage
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
WORKDIR /app

RUN addgroup -S facilitator && adduser -S facilitator -G facilitator
USER facilitator

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/src ./src

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3402}/healthz || exit 1

EXPOSE 3402
CMD ["npm", "start"]
