# Stage 0: Base image to avoid repeated metadata fetches
FROM node:20-alpine AS base

# Stage 1: Install dependencies
FROM base AS deps
WORKDIR /app

# Copy only package files first for better cache utilization
COPY package.json package-lock.json ./
COPY patches ./patches

# Install all dependencies (including devDependencies for TypeScript build)
RUN npm ci --prefer-offline --no-audit --no-fund

# Stage 2: Build TypeScript
FROM base AS builder
WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./

# Copy source files needed for build
COPY tsconfig.json ./
COPY src ./src

# Build the application
RUN npm run build

# Stage 3: Production dependencies only
FROM base AS prod-deps
WORKDIR /app

# Reuse fully installed (and patched) dependencies from the deps stage,
# then prune devDependencies to produce a runtime-only node_modules.
COPY --from=deps /app/package.json /app/package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
RUN npm prune --omit=dev

# Stage 4: Final runtime image
FROM base AS runtime
WORKDIR /app

# Install wireguard and networking tools. openresolv provides resolvconf for DNS updates.
# The symlink ensures resolvconf is found in /sbin which some tools expect.
# Using ln -sf to force symlink creation; errors are suppressed since the target
# may already exist or the source may not be present (both are acceptable states).
RUN apk add --no-cache wireguard-tools openvpn iproute2 iptables openresolv \
    && ln -sf /usr/sbin/resolvconf /sbin/resolvconf 2>/dev/null || true

ENV NODE_ENV=production

# Copy only production dependencies (not devDependencies)
COPY --from=prod-deps /app/node_modules ./node_modules

# Copy built application
COPY --from=builder /app/dist ./dist

# Copy package.json for runtime metadata
COPY package.json ./

CMD ["node", "dist/app/main.js"]
