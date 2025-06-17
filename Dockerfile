# Use Node.js 18 Alpine as base image
FROM node:18-alpine

# Install ffmpeg and build tools
RUN apk update && \
    apk add --no-cache \
    ffmpeg \
    && rm -rf /var/cache/apk/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (using npm install instead of npm ci)
RUN npm install && \
    npm cache clean --force

# Copy TypeScript configuration and source code
COPY tsconfig.json ./
COPY src/ ./src/

# Build the application
RUN npm run build

# Remove dev dependencies and source files to reduce image size
RUN npm prune --production && \
    rm -rf src/ tsconfig.json node_modules/@types

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S audioconv -u 1001 -G nodejs

# Change ownership of app directory and temp directory
RUN chown -R audioconv:nodejs /app /tmp

# Switch to non-root user
USER audioconv

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# Start the application
CMD ["npm", "start"]