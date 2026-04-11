const express = require('express');
const router = express.Router();

router.get('/health', async (req, res) => {
  return res.status(200).json({
    ok: true,
    service: 'white-creams-api',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
