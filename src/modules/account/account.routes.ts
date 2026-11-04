/**
 * src/modules/account/account.routes.ts
 *
 * The signed-in person's own settings: password, devices and two-factor login.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { actorOf, contextOf, handle } from '@/lib/http';
import { prisma } from '@/lib/prisma';
import { encrypt, hashToken } from '@/lib/security';
import { generateTotpSecret, totpUri } from '@/lib/totp';
import { authenticate, requirePersonalAccount } from '@/middleware/authenticate';
import { AppError } from '@/middleware/errorHandler';
import { auditService } from '@/modules/audit/audit.service';
import { newPassword, personName } from '@/modules/auth/auth.schema';
import { authService, BCRYPT_COST, matchTotp } from '@/modules/auth/auth.service';
import { sessionService } from '@/modules/auth/session.service';

const RECOVERY_CODE_COUNT = 8;

export const updateProfileSchema = z.object({ name: personName });

export const changePasswordSchema = z.object({
  currentPassword: z.string({ error: 'Current password is required.' }).min(1),
  newPassword,
});

export const enableTwoFactorSchema = z.object({ code: z.string().trim().length(6) });

export const alertPreferenceSchema = z.object({ alertEmails: z.boolean() });

export const disableTwoFactorSchema = z.object({
  password: z.string({ error: 'Password is required.' }).min(1),
  code: z.string({ error: 'Code is required.' }).trim().min(6).max(20),
});

const accountRouter = Router();

accountRouter.use(authenticate, requirePersonalAccount);

const assertPassword = async (hash: string, password: string): Promise<void> => {
  if (!(await bcrypt.compare(password, hash))) {
    throw new AppError(422, 'That password is not correct.');
  }
};

accountRouter.patch(
  '/profile',
  handle(async (req, res) => {
    const { name } = updateProfileSchema.parse(req.body);
    await prisma.user.update({ where: { id: actorOf(req).sub }, data: { name } });
    res.status(204).end();
  }),
);

/** Turns campaign alert emails on or off for the active organisation. */
accountRouter.patch(
  '/alerts',
  handle(async (req, res) => {
    const actor = actorOf(req);
    const { alertEmails } = alertPreferenceSchema.parse(req.body);
    if (!actor.organisationId) throw new AppError(409, 'Choose an organisation first.');

    await prisma.membership.update({
      where: { userId_organisationId: { userId: actor.sub, organisationId: actor.organisationId } },
      data: { alertEmails },
    });
    res.status(204).end();
  }),
);

/** Changing a password signs out every other device. */
accountRouter.post(
  '/password',
  handle(async (req, res) => {
    const actor = actorOf(req);
    const dto = changePasswordSchema.parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.sub } });

    await assertPassword(user.passwordHash, dto.currentPassword);

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(dto.newPassword, BCRYPT_COST) },
    });
    await sessionService.endAll(user.id, actor.sessionId);
    await auditService.record({
      action: 'account.password_changed',
      actorId: user.id,
      actorEmail: user.email,
      ipAddress: contextOf(req).ipAddress,
    });
    res.status(204).end();
  }),
);

accountRouter.get(
  '/sessions',
  handle(async (req, res) => {
    const actor = actorOf(req);
    const sessions = await sessionService.list(actor.sub);
    res.status(200).json({
      status: 'success',
      data: sessions.map((session) => ({
        ...session,
        current: session.id === actor.sessionId,
      })),
    });
  }),
);

/** Signs out every device except this one. */
accountRouter.delete(
  '/sessions',
  handle(async (req, res) => {
    const actor = actorOf(req);
    const ended = await sessionService.endAll(actor.sub, actor.sessionId);
    await auditService.record({
      action: 'account.sessions_ended',
      actorId: actor.sub,
      details: { ended },
      ipAddress: contextOf(req).ipAddress,
    });
    res.status(204).end();
  }),
);

accountRouter.delete(
  '/sessions/:id',
  handle(async (req, res) => {
    const ended = await sessionService.endOne(actorOf(req).sub, req.params['id'] as string);
    if (!ended) throw new AppError(404, 'Session not found.');
    res.status(204).end();
  }),
);

/** Stores a pending secret. Nothing changes until a first code proves it works. */
accountRouter.post(
  '/two-factor/setup',
  handle(async (req, res) => {
    const actor = actorOf(req);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.sub } });
    if (user.twoFactorEnabledAt) throw new AppError(409, 'Two-factor login is already on.');

    const secret = generateTotpSecret();
    await prisma.user.update({
      where: { id: user.id },
      data: { twoFactorSecret: encrypt(secret) },
    });

    res.status(200).json({
      status: 'success',
      data: { secret, qrCode: await QRCode.toDataURL(totpUri(secret, user.email)) },
    });
  }),
);

/** Recovery codes are shown once, here, and only their hashes are kept. */
accountRouter.post(
  '/two-factor/enable',
  handle(async (req, res) => {
    const actor = actorOf(req);
    const { code } = enableTwoFactorSchema.parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.sub } });

    if (user.twoFactorEnabledAt) throw new AppError(409, 'Two-factor login is already on.');
    if (!user.twoFactorSecret) throw new AppError(409, 'Start two-factor setup first.');

    const step = matchTotp(user.twoFactorSecret, code, null);
    if (step === null) throw new AppError(422, 'That code is not valid.');

    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      randomBytes(5).toString('hex').toUpperCase(),
    );

    await prisma.user.update({
      where: { id: user.id },
      data: {
        twoFactorEnabledAt: new Date(),
        twoFactorLastStep: step,
        recoveryCodes: recoveryCodes.map(hashToken),
      },
    });
    await auditService.record({
      action: 'account.two_factor_enabled',
      actorId: user.id,
      actorEmail: user.email,
      ipAddress: contextOf(req).ipAddress,
    });

    res.status(200).json({ status: 'success', data: { recoveryCodes } });
  }),
);

accountRouter.post(
  '/two-factor/disable',
  handle(async (req, res) => {
    const actor = actorOf(req);
    const dto = disableTwoFactorSchema.parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.sub } });

    if (!user.twoFactorEnabledAt) throw new AppError(409, 'Two-factor login is already off.');
    await assertPassword(user.passwordHash, dto.password);
    if (!(await authService.acceptSecondFactor(user, dto.code))) {
      throw new AppError(422, 'That code is not valid.');
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        twoFactorEnabledAt: null,
        twoFactorSecret: null,
        twoFactorLastStep: null,
        recoveryCodes: [],
      },
    });
    await auditService.record({
      action: 'account.two_factor_disabled',
      actorId: user.id,
      actorEmail: user.email,
      ipAddress: contextOf(req).ipAddress,
    });
    res.status(204).end();
  }),
);

export { accountRouter };
