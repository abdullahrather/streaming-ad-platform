/**
 * src/modules/creatives/creatives.routes.ts
 *
 * Uploading and managing video ads, and the media routes that play them.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer, { MulterError } from 'multer';
import { env } from '@/config/env';
import { actorOf, allowAnyOrigin, contextOf, handle } from '@/lib/http';
import { storage } from '@/lib/storage';
import { authenticate, requireWriteAccess } from '@/middleware/authenticate';
import { AppError } from '@/middleware/errorHandler';
import { auditService } from '@/modules/audit/audit.service';
import {
  campaignQuerySchema,
  updateCreativeSchema,
  uploadCreativeSchema,
} from './creatives.schema';
import { creativesService } from './creatives.service';

const upload = multer({
  dest: path.join(os.tmpdir(), 'campaign-uploads'),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1_000_000, files: 1 },
}).single('file');

/** Turns upload problems into normal API errors. */
const receiveFile = (req: Request, res: Response, next: NextFunction): void => {
  upload(req, res, (error: unknown) => {
    if (error instanceof MulterError) {
      next(
        new AppError(
          error.code === 'LIMIT_FILE_SIZE' ? 413 : 422,
          error.code === 'LIMIT_FILE_SIZE'
            ? `Videos can be up to ${env.MAX_UPLOAD_MB} MB.`
            : 'That upload could not be read.',
        ),
      );
      return;
    }
    next(error);
  });
};

const creativesRouter = Router();
const mediaRouter = Router();

creativesRouter.use(authenticate);
mediaRouter.use('/media', allowAnyOrigin);

creativesRouter.get(
  '/',
  handle(async (req, res) => {
    const { campaignId } = campaignQuerySchema.parse(req.query);
    const data = await creativesService.list(actorOf(req), campaignId);
    res.status(200).json({ status: 'success', data });
  }),
);

creativesRouter.post(
  '/',
  requireWriteAccess,
  receiveFile,
  handle(async (req, res) => {
    const actor = actorOf(req);
    if (!req.file) throw new AppError(422, 'Choose a video to upload.');

    const dto = uploadCreativeSchema.safeParse(req.body);
    if (!dto.success) {
      await fs.rm(req.file.path, { force: true });
      throw dto.error;
    }

    const creative = await creativesService.upload(actor, req.file.path, dto.data);
    await auditService.record({
      action: 'creative.uploaded',
      actorId: actor.sub,
      organisationId: actor.organisationId,
      targetType: 'creative',
      targetId: creative.id,
      details: { name: creative.name },
      ipAddress: contextOf(req).ipAddress,
    });
    res.status(201).json({ status: 'success', data: creativesService.toView(creative) });
  }),
);

creativesRouter.patch(
  '/:id',
  requireWriteAccess,
  handle(async (req, res) => {
    const { weight } = updateCreativeSchema.parse(req.body);
    await creativesService.setWeight(actorOf(req), req.params['id'] as string, weight);
    res.status(204).end();
  }),
);

creativesRouter.delete(
  '/:id',
  requireWriteAccess,
  handle(async (req, res) => {
    const actor = actorOf(req);
    const creative = await creativesService.remove(actor, req.params['id'] as string);

    await auditService.record({
      action: 'creative.deleted',
      actorId: actor.sub,
      organisationId: actor.organisationId,
      targetType: 'creative',
      targetId: creative.id,
      details: { name: creative.name },
      ipAddress: contextOf(req).ipAddress,
    });
    res.status(204).end();
  }),
);

mediaRouter.get(
  '/media/creatives/:id/video',
  handle(async (req, res) => {
    const creative = await creativesService.mediaFor(req.params['id'] as string, req.query['t']);
    if (!creative.videoKey) throw new AppError(404, 'Not found.');

    res.set('Cache-Control', 'private, max-age=300');
    res.sendFile(storage.localPath(creative.videoKey), { dotfiles: 'allow' });
  }),
);

mediaRouter.get(
  '/media/creatives/:id/poster',
  handle(async (req, res) => {
    const creative = await creativesService.mediaFor(req.params['id'] as string, req.query['t']);
    if (!creative.posterKey) throw new AppError(404, 'Not found.');

    res.sendFile(storage.localPath(creative.posterKey), { dotfiles: 'allow' });
  }),
);

export { creativesRouter, mediaRouter };
