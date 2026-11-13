FROM node:22-alpine
# docker CLI + compose + buildx to drive the host's Docker; 7-Zip for tub zips.
RUN apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx 7zip
WORKDIR /opt/tubd
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
EXPOSE 7070
CMD ["node", "src/main.ts"]
