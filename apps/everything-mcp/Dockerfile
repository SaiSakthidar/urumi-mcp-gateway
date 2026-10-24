# Official MCP reference server, run in Streamable HTTP mode.
# Used as an in-cluster upstream: a pod we can kill in the demo, plus a slow
# tool for demonstrating gateway timeouts. Version pinned at build time.
FROM node:22-alpine
ARG EVERYTHING_VERSION=2.0.0
RUN npm install -g @modelcontextprotocol/server-everything@${EVERYTHING_VERSION}
USER node
ENV PORT=3001
EXPOSE 3001
CMD ["mcp-server-everything", "streamableHttp"]
