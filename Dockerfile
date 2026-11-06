# The AEP hub: server, conversation state and web app. Agents connect to it, it never connects to them.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY plugin/lib/protocol.js plugin/lib/protocol.js
COPY plugin/package.json plugin/package.json
COPY hub hub
ENV AEP_DATA_DIR=/data AEP_HOST=0.0.0.0 PORT=8787
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "hub/server.js"]
