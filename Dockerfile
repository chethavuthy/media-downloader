# Use Node.js as base
FROM node:20-slim

# Install system dependencies (ffmpeg and python3 for yt-dlp)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp globally
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# Set environment variables
ENV NODE_ENV=production
ENV YT_DLP_PATH=/usr/local/bin/yt-dlp
ENV PORT=7860

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build the project
RUN npm run build

# Create downloads directory and set permissions
RUN mkdir -p /app/downloads && chmod 777 /app/downloads

# Hugging Face runs as a non-root user (UID 1000)
# Make sure the user has access to the app directory
RUN useradd -m -u 1000 user
RUN chown -R user:user /app
USER user

# Expose port (Hugging Face expects a server on 7860)
EXPOSE 7860

# Run the bot
CMD ["node", "dist/index.js"]
