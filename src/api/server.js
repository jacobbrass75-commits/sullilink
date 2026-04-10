const path = require('path');
const dotenv = require('dotenv');
const express = require('express');
const healthRouter = require('./routes/health');
const ingestRouter = require('./routes/ingest');
const searchRouter = require('./routes/search');
const entitiesRouter = require('./routes/entities');
const buyersRouter = require('./routes/buyers');
const sellersRouter = require('./routes/sellers');
const knowledgeRouter = require('./routes/knowledge');
const propertiesRouter = require('./routes/properties');
const matchRouter = require('./routes/match');
const matchesRouter = require('./routes/matches');
const dailyRouter = require('./routes/daily');
const importExportRouter = require('./routes/import-export');
const assistantRouter = require('./routes/assistant');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function createApp() {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use(healthRouter);
  app.use(ingestRouter);
  app.use(searchRouter);
  app.use(entitiesRouter);
  app.use(buyersRouter);
  app.use(sellersRouter);
  app.use(knowledgeRouter);
  app.use(propertiesRouter);
  app.use(matchRouter);
  app.use(matchesRouter);
  app.use(dailyRouter);
  app.use(importExportRouter);
  app.use(assistantRouter);
  app.use((error, _req, res, _next) => {
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    const message = statusCode >= 500 ? 'Internal server error' : error.message;

    if (statusCode >= 500) {
      console.error(error);
    }

    return res.status(statusCode).json({ error: message });
  });
  return app;
}

async function startServer(port) {
  const app = createApp();
  const listenPort = port ?? Number(process.env.API_PORT || 3100);

  await new Promise((resolve, reject) => {
    const server = app.listen(listenPort, resolve);
    server.on('error', reject);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  createApp,
  startServer
};
