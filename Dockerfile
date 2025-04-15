# Generated by https://smithery.ai. See: https://smithery.ai/docs/config#dockerfile
FROM node:lts-alpine

# Install pnpm globally
RUN npm install -g pnpm

WORKDIR /app

# Copy package manifests and lockfile
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build the project
RUN pnpm run build

# Use node to run the built artifact
ENTRYPOINT ["node", "dist/index.js"]
