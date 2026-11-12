# ---------- Stage 1: install production dependencies ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ---------- Stage 2: small runtime image, runs as NON-ROOT ----------
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package*.json ./
COPY --chown=node:node api ./api
COPY --chown=node:node worker ./worker

USER node
EXPOSE 8080

# Default = API. The worker reuses this same image with another command
# (compose.yaml / worker-deployment.yaml: node worker/src/index.js)
CMD ["node", "api/src/index.js"]
