FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/automation/package.json packages/automation/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/job-sources/package.json packages/job-sources/package.json
COPY packages/matching/package.json packages/matching/package.json
COPY packages/discovery/package.json packages/discovery/package.json
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
USER node
EXPOSE 3000
CMD ["npm", "run", "start"]
