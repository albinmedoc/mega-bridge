import { Router } from 'express';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memoryMB: Math.round(process.memoryUsage().rss / 1_048_576),
  });
});

export default router;
