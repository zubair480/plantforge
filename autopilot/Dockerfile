# Autopilot agent + cloud plant simulator. Runs on Blaxel, Fly, Railway,
# Cloud Run, InsForge compute, or any container host.
#   docker build -t plant-autopilot autopilot
#   docker run -p 3000:3000 -e PLANT_INGEST_TOKEN=... -e SIMULATOR_KEY=... plant-autopilot
# Optional env: MCP_ACCESS_TOKEN (if the MCP server requires it), INTERVAL_MS, NO_REPLY_PAGE_MS.
FROM node:22-alpine
WORKDIR /app
COPY autopilot.mjs .
ENV NODE_ENV=production \
    PORT=3000 \
    MCP_URL=https://dark-forge-tma6f.run.mcp-use.com/mcp \
    INSFORGE_FUNCTIONS_URL=https://nden3esm.us-west.insforge.app/functions
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "autopilot.mjs"]
