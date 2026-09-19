FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/crawler/package.json apps/crawler/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/job-sources/package.json packages/job-sources/package.json
COPY packages/discovery/package.json packages/discovery/package.json
RUN npm ci
# After `npm ci`, not before: `npm ci` itself respects NODE_ENV=production by
# skipping devDependencies, and this image's runtime is `tsx` (a
# devDependency) executing TypeScript directly — setting this any earlier
# would drop the very tool that runs the app. This is fix round 2's P4: the
# image otherwise falls back to whatever NODE_ENV the environment supplies
# (or none) when run outside Compose, reverting to the env-var-only posture
# `apps/crawler/src/policy.ts` and `session.ts` treat as fail-closed but not
# ideal. Compose's `compose.yaml` sets the same value explicitly for
# defence in depth; this is what protects a `docker run` that bypasses it.
ENV NODE_ENV=production
COPY . .
USER pwuser
EXPOSE 4000
CMD ["npm", "run", "crawler"]
