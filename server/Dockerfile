FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY web ./web
ENV PORT=8080 DATA_DIR=/data NODE_ENV=production
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "src/server.js"]
