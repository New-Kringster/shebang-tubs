FROM node:22-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
COPY server.mjs .
# The data folder arrives owned by whoever unpacked the tub, so take it over
# as root, then run the app as the unprivileged node user.
ENTRYPOINT ["sh", "-c", "mkdir -p \"$FILES_DIR\" && chown -R node:node \"$FILES_DIR\" && exec su-exec node node server.mjs"]
