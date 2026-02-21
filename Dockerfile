FROM node:20-bookworm-slim

# Electron / Chromium runtime dependencies + Xvfb for virtual display
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    libgtk-3-0 \
    libnotify4 \
    libnss3 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    libatspi2.0-0 \
    libdrm2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libglib2.0-0 \
    libnspr4 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    fonts-liberation \
    dbus \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

VOLUME /data
EXPOSE 3845

ENV UNSOCIAL_DATA=/data
ENV DISPLAY=:99
ENV ELECTRON_DISABLE_SANDBOX=1

CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1280x900x24 -ac", "./node_modules/.bin/electron", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "src/headless.js"]
