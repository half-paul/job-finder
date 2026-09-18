FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/crawler/package.json apps/crawler/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/job-sources/package.json packages/job-sources/package.json
COPY packages/discovery/package.json packages/discovery/package.json
RUN npm ci
COPY . .
USER pwuser
EXPOSE 4000
CMD ["npm", "run", "crawler"]
