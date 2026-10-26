FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Chromium and its Linux libraries, pinned by the Playwright version.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chromium
COPY src ./src
ENV NODE_ENV=production
CMD ["node", "--experimental-strip-types", "--no-warnings", "src/server.ts"]
