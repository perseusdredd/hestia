# Hestia on a plain Linux host (VPS). Migrations run on every start.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npx prisma generate && npx next build --turbopack
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && exec npx next start -H 0.0.0.0 -p 3000"]
