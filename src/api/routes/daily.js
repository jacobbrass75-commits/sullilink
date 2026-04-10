const express = require('express');
const { getDailyOverview } = require('../../daily/overview');

const router = express.Router();

router.get('/api/daily', async (_req, res, next) => {
  try {
    return res.json(await getDailyOverview());
  } catch (error) {
    return next(error);
  }
});

router.get('/brain/daily', (_req, res) => {
  res.status(501).json({
    status: 'not_implemented',
    module: 'Module 2',
    message: 'This endpoint will be implemented in Module 2: Entity Extraction'
  });
});

module.exports = router;
