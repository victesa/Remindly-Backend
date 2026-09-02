import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import { createServer as createViteServer } from 'vite';
import { setRuntimeConfig } from './src/runtimeConfig.js';

import { authenticateToken, mintDevToken } from './src/server/auth.js';
import { rateLimiterMiddleware, getQuotaInfo, resetUserQuota, resetAllQuotas } from './src/server/rateLimiter.js';
import { logOperation, getRecentLogs, clearLogs, getAiServiceStatus } from './src/server/logger.js';
import { getUserItems, updateUserItem, deleteUserItem, deleteUserData, requestPasswordReset } from './src/server/firebaseStore.js';
import { processExtraction } from './src/server/extractor.js';
import { UserTier } from './src/types.js';

setRuntimeConfig(process.env);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/jpg'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: JPEG, PNG, WEBP, GIF`));
    }
  },
});

async function startServer() {
  const app = express();
  const PORT = 3000;

  // JSON and URL-encoded body parsers
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // CORS and custom headers middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key, X-User-Tier, X-User-Id');
    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    req.requestId = `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    next();
  });

  // --- Health Endpoints ---
  const healthHandler = async (_req: Request, res: Response) => {
    try {
      const aiStatus = await getAiServiceStatus();
      res.json({
        status: 'ok',
        service: 'Remindly AI Backend Proxy',
        version: '1.2.0',
        timestamp: new Date().toISOString(),
        geminiConfigured: aiStatus.geminiConfigured,
        uptimeSeconds: aiStatus.uptimeSeconds,
        tiersSupported: ['free', 'premium'],
        strategies: ['gemini_cloud_ai', 'gemini_flash_lite', 'cached_response'],
      });
    } catch (error: any) {
      res.status(503).json({
        status: 'degraded',
        service: 'Remindly AI Backend Proxy',
        version: '1.2.0',
        timestamp: new Date().toISOString(),
        error: error?.message || 'Health status is temporarily unavailable.',
      });
    }
  };

  app.get('/v1/health', healthHandler);
  app.get('/api/health', healthHandler);

  // --- AI Service Status ---
  app.get('/v1/ai-status', async (_req: Request, res: Response) => {
    try {
      const status = await getAiServiceStatus();
      res.json({
        success: true,
        data: status,
      });
    } catch (error: any) {
      res.status(503).json({
        success: false,
        error: error?.message || 'AI status is currently unavailable.',
      });
    }
  });

  // --- Dev Auth Minting ---
  app.post('/v1/auth/mint-token', (req: Request, res: Response) => {
    const tier: UserTier = req.body.tier === 'premium' ? 'premium' : 'free';
    const userId = req.body.userId as string | undefined;
    const minted = mintDevToken(tier, userId);
    res.json({
      success: true,
      token: minted.token,
      user: minted.user,
      instructions: `Pass as header 'Authorization: Bearer ${minted.token}' or 'X-User-Tier: ${tier}'`,
    });
  });

  // --- Quota Endpoints ---
  app.get('/v1/quota', authenticateToken, async (req: Request, res: Response) => {
    const userId = req.user?.uid || 'guest';
    const tier = req.user?.tier || 'free';
    const quota = await getQuotaInfo(userId, tier);
    res.json({
      success: true,
      quota,
      user: req.user,
    });
  });

  app.post('/v1/quota/reset', authenticateToken, async (req: Request, res: Response) => {
    const userId = req.body.userId || req.user?.uid;
    const resetAll = req.body.all === true;

    if (resetAll) {
      await resetAllQuotas();
    } else if (userId) {
      await resetUserQuota(userId);
    }

    res.json({
      success: true,
      message: resetAll ? 'All quotas reset' : `Quota reset for user ${userId}`,
    });
  });

  // --- Logs & Telemetry Endpoints ---
  app.get('/v1/logs', async (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string, 10) || 100;
    const tier = req.query.tier as UserTier | undefined;
    const endpoint = req.query.endpoint as string | undefined;
    const logs = await getRecentLogs(limit, tier, endpoint);
    res.json({
      success: true,
      count: logs.length,
      logs,
    });
  });

  app.post('/v1/logs/clear', async (_req: Request, res: Response) => {
    await clearLogs();
    res.json({ success: true, message: 'Logs cleared' });
  });

  // --- User Items / Sync History ---
  app.get('/v1/items', authenticateToken, async (req: Request, res: Response) => {
    const userId = req.user?.uid || 'demo_guest_user';
    const userTier = req.user?.tier || 'free';

    if (userTier !== 'premium') {
      res.status(403).json({
        success: false,
        error: 'Stored captures are available for premium users only.',
        userId,
        userTier,
      });
      return;
    }

    try {
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const items = await getUserItems(userId, limit);
      res.json({
        success: true,
        userId,
        userTier,
        count: items.length,
        items,
      });
    } catch (error: any) {
      res.status(503).json({
        success: false,
        error: error?.message || 'Cloud storage is currently unavailable.',
        userId,
        userTier,
      });
    }
  });

  app.patch('/v1/items/:id', authenticateToken, async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    const headerTier = (req.headers['x-user-tier'] as string | undefined)?.toLowerCase();
    const userId = req.user?.uid || 'demo_guest_user';
    const userTier = req.user?.tier || 'free';

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        success: false,
        error: 'Authorization: Bearer <token> is required.',
      });
      return;
    }

    if (headerTier !== 'premium' || userTier !== 'premium') {
      res.status(403).json({
        success: false,
        error: 'Premium access required for item updates.',
        userId,
        userTier,
      });
      return;
    }

    try {
      const itemId = req.params.id;
      const updated = await updateUserItem(userId, itemId, req.body || {});
      res.status(200).json(updated);
    } catch (error: any) {
      const message = error?.message || 'Failed to update item.';
      const statusCode = message === 'Item not found.' ? 404 : 400;
      res.status(statusCode).json({
        success: false,
        error: message,
      });
    }
  });

  app.delete('/v1/items/:id', authenticateToken, async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    const headerTier = (req.headers['x-user-tier'] as string | undefined)?.toLowerCase();
    const userId = req.user?.uid || 'demo_guest_user';
    const userTier = req.user?.tier || 'free';

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        success: false,
        error: 'Authorization: Bearer <token> is required.',
      });
      return;
    }

    if (headerTier !== 'premium' || userTier !== 'premium') {
      res.status(403).json({
        success: false,
        error: 'Premium access required for item deletion.',
        userId,
        userTier,
      });
      return;
    }

    try {
      const itemId = req.params.id;
      const deleted = await deleteUserItem(userId, itemId);
      if (!deleted) {
        res.status(404).json({
          success: false,
          error: 'Item not found.',
        });
        return;
      }

      res.status(200).json({ success: true });
    } catch (error: any) {
      res.status(503).json({
        success: false,
        error: error?.message || 'Failed to delete item.',
      });
    }
  });

  // --- Account Lifecycle Endpoints ---
  app.post('/v1/account/request-password-reset', async (req: Request, res: Response) => {
    const email = req.body.email || 'user@example.com';
    const result = await requestPasswordReset(email);
    res.json({
      success: true,
      email,
      message: result.message,
    });
  });

  app.post('/v1/account/delete', authenticateToken, async (req: Request, res: Response) => {
    const userId = req.user?.uid || 'demo_guest_user';
    const result = await deleteUserData(userId);
    res.json({
      success: true,
      userId,
      deletedItemsCount: result.deletedCount,
      message: `Account data for user ${userId} has been permanently purged.`,
    });
  });

  // --- Primary Extraction Endpoint ---
  app.post(
    '/v1/extract-data',
    upload.single('image'),
    authenticateToken,
    rateLimiterMiddleware,
    async (req: Request, res: Response) => {
      const startTime = Date.now();
      const userId = req.user!.uid;
      const userTier = req.user!.tier;
      const idempotencyKey = (req.headers['idempotency-key'] as string) || (req.body.idempotencyKey as string);
      const text = req.body.text as string | undefined;
      const url = req.body.url as string | undefined;
      const currentDate = (req.body.currentDate as string) || (req.headers['x-client-date'] as string) || (req.query.currentDate as string) || new Date().toISOString();
      const userTimezone = (req.headers['x-user-timezone'] as string) || (req.body.timezone as string) || (req.body.userTimezone as string) || (req.query.timezone as string) || 'UTC';
      const quota = await getQuotaInfo(userId, userTier);

      const hasText = Boolean(text && text.trim().length > 0);
      const hasImage = Boolean(req.file && req.file.buffer);
      const hasUrl = Boolean(url && url.trim().length > 0);

      try {
        const result = await processExtraction({
          userId,
          userTier,
          text,
          url,
          currentDate,
          userTimezone,
          image: req.file
            ? {
                buffer: req.file.buffer,
                mimeType: req.file.mimetype,
                originalName: req.file.originalname,
              }
            : null,
          idempotencyKey,
          quota,
          requestId: req.requestId || `req_${Date.now()}`,
        });

        const latencyMs = Date.now() - startTime;

        await logOperation({
          requestId: req.requestId || result.metadata.requestId,
          userId,
          userTier,
          endpoint: '/v1/extract-data',
          method: 'POST',
          statusCode: 200,
          latencyMs,
          strategy: result.data.strategy,
          hasText,
          hasImage,
          hasUrl,
          cached: result.metadata.cached,
          categoryExtracted: result.data.category,
          titleExtracted: result.data.title,
        });

        res.status(200).json(result);
      } catch (error: any) {
        const latencyMs = Date.now() - startTime;
        const errorMessage = error?.message || 'Extraction failed';

        await logOperation({
          requestId: req.requestId || `req_${Date.now()}`,
          userId,
          userTier,
          endpoint: '/v1/extract-data',
          method: 'POST',
          statusCode: 400,
          latencyMs,
          hasText,
          hasImage,
          hasUrl,
          cached: false,
          error: errorMessage,
        });

        res.status(400).json({
          success: false,
          error: errorMessage,
          quota,
          metadata: {
            requestId: req.requestId,
            processingTimeMs: latencyMs,
            hasImage,
            hasText,
            hasUrl,
            userId,
            userTier,
            cached: false,
            persistedToFirebase: false,
          },
        });
      }
    }
  );

  // Global error handler for multer/upload errors
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      res.status(413).json({
        success: false,
        error: `Upload error: ${err.message}`,
      });
      return;
    }
    if (err) {
      res.status(400).json({
        success: false,
        error: err.message || 'Server error',
      });
      return;
    }
  });

  // Vite middleware for development vs Static serving in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Remindly AI Proxy] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
