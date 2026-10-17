# Autopilot agent + cloud plant simulator. Runs on Blaxel, Fly, Railway,
# Cloud Run, InsForge compute, or any container host.
#   docker build -t plant-autopilot autopilot
#   docker run -p 3000:3000 -e PLANT_INGEST_TOKEN=... plant-autopilot
FROM node:22-alpine
WORKDIR /app
COPY autopilot.mjs .
ENV PORT=3000 \
    MCP_URL=https://dark-forge-tma6f.run.mcp-use.com/mcp \
    INSFORGE_FUNCTIONS_URL=https://nden3esm.us-west.insforge.app/functions
EXPOSE 3000
USER node
CMD ["node", "autopilot.mjs"]
