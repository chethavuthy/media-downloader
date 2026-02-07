# Use Node.js slim for a cleaner network stack
FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install gallery-dl and instaloader for image downloads
RUN pip3 install --break-system-packages gallery-dl instaloader

# Install yt-dlp binary
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# Set environment variables
ENV YT_DLP_PATH=/usr/local/bin/yt-dlp
ENV PORT=7860
# Force Node.js to prefer IPv4 (fixes many ENOTFOUND issues in cloud environments)
ENV NODE_OPTIONS="--dns-result-order=ipv4first"

# Create app directory
WORKDIR /app

# Set permissions for the existing 'node' user (UID 1000)
# Hugging Face requires UID 1000
RUN chown -R node:node /app

# Switch to non-root user
USER node

# Copy package files first to leverage Docker cache
COPY --chown=node:node package*.json ./

# Install ALL dependencies (including dev deps needed for build)
RUN npm install

# Copy the rest of the source code
COPY --chown=node:node . .

# Build the project
RUN npm run build

# Set permissions for downloads
RUN mkdir -p /app/downloads

# Switch to production
ENV NODE_ENV=production

# Expose the mandatory port 7860 for Hugging Face
EXPOSE 7860

# Run the bot
CMD ["node", "dist/index.js"]
