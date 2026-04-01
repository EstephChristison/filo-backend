FROM node:20-alpine
# Gemini AI integration added 2026-04-01
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install production dependencies
# --ignore-scripts avoids native compilation issues during install
# then rebuild sharp specifically for the target platform
RUN npm ci --production --ignore-scripts && \
    npm rebuild sharp

    # Copy application source
    COPY . .

    # Railway sets PORT dynamically
    EXPOSE ${PORT:-3000}

    # Start the server
    CMD ["node", "filo-api-server.js"]
